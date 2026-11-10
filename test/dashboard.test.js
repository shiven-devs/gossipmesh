/**
 * Dashboard tests: the aggregation logic on a fake clock, and the routes with
 * a fake fetch. No real nodes and no real network, so these are instant.
 */

import test from "node:test";
import assert from "node:assert/strict";

import request from "supertest";
import pino from "pino";

import { ClusterView } from "../dashboard/aggregator.js";
import {
  createDashboardServer,
  loadDashboardConfig,
  pollNode,
  resolveTargets,
} from "../dashboard/server.js";

/** A /members body as a node would serve it. */
function membersBody(selfId, members) {
  const byLocalStatus = {};
  for (const m of members) byLocalStatus[m.localStatus] = (byLocalStatus[m.localStatus] ?? 0) + 1;

  return {
    self: { id: selfId, address: `${selfId}:3000` },
    count: members.length,
    byLocalStatus,
    members,
    graves: [],
  };
}

const member = (id, overrides = {}) => ({
  id,
  address: `${id}:3000`,
  generation: 100,
  heartbeat: 7,
  status: "alive",
  metadata: {},
  lastSeenAt: 1000,
  localStatus: "alive",
  ...overrides,
});

// --- config -----------------------------------------------------------------

test("dashboard config: defaults, and NODES is required", () => {
  const config = loadDashboardConfig({ NODES: "a:3000, b:3000 ,," });

  assert.equal(config.port, 8080);
  assert.deepEqual(config.nodes, ["a:3000", "b:3000"]);
  assert.equal(config.pollIntervalMs, 1000);
  assert.equal(config.requestTimeoutMs, 700);

  assert.throws(() => loadDashboardConfig({}), /set NODES .* or NODE_DNS/);
});

test("dashboard discovery: NODE_DNS resolves to one address per pod", async () => {
  // This is what makes `kubectl scale` visible on the page without
  // redeploying the dashboard.
  const config = loadDashboardConfig({ NODE_DNS: "gossip-headless.gossip.svc.cluster.local" });

  const targets = await resolveTargets(config, async () => ["10.0.0.1", "10.0.0.2"]);
  assert.deepEqual(targets, ["10.0.0.1:3000", "10.0.0.2:3000"]);
});

test("dashboard discovery: a failed lookup falls back to the static list", async () => {
  const config = loadDashboardConfig({ NODES: "fallback:3000", NODE_DNS: "gossip-headless" });

  const targets = await resolveTargets(config, async () => { throw new Error("EAI_AGAIN"); });
  // The dashboard failing to resolve says nothing about the cluster, so it
  // shows what it can rather than an empty page.
  assert.deepEqual(targets, ["fallback:3000"]);
});

test("dashboard: a scaled-away pod eventually leaves the table", async () => {
  const view = new ClusterView();
  view.update("10.0.0.9:3000", { reachable: true, members: membersBody("gone", [member("gone")]) }, 1000);
  view.update("10.0.0.1:3000", { reachable: true, members: membersBody("a", [member("a")]) }, 1000);

  // Still within the grace period: one failed DNS lookup must not blank rows.
  assert.deepEqual(view.forgetAddressesExcept(["10.0.0.1:3000"], 20_000), []);
  assert.equal(view.snapshot(20_000).rows.length, 2);

  // Past it, the pod that is no longer resolved is dropped - otherwise a
  // 10 -> 5 scale-down would leave five permanently stale rows.
  assert.deepEqual(view.forgetAddressesExcept(["10.0.0.1:3000"], 40_000), ["10.0.0.9:3000"]);
  assert.equal(view.snapshot(40_000).rows.length, 1);
});

test("dashboard config: a request timeout must be shorter than the poll interval", () => {
  // Otherwise one hung node makes the sweeps overlap and pile up.
  assert.throws(
    () => loadDashboardConfig({ NODES: "a:3000", POLL_INTERVAL_MS: "500", REQUEST_TIMEOUT_MS: "900" }),
    /must be < POLL_INTERVAL_MS/,
  );
});

// --- the matrix -------------------------------------------------------------

test("matrix: one row per observer, one column per member anyone knows", () => {
  const view = new ClusterView();

  view.update("a:3000", {
    reachable: true,
    members: membersBody("a", [member("a"), member("b")]),
  }, 1000);
  // b has already heard of c; a has not. c therefore gets a column, and a's
  // row shows "unknown" for it - which is what a half-propagated join is.
  view.update("b:3000", {
    reachable: true,
    members: membersBody("b", [member("a"), member("b"), member("c")]),
  }, 1000);

  const snap = view.snapshot(1000);

  assert.deepEqual(snap.columns, ["a", "b", "c"]);
  assert.deepEqual(snap.rows.map((r) => r.observer), ["a", "b"]);
  assert.deepEqual(snap.rows[0].cells.map((c) => c.status), ["alive", "alive", "unknown"]);
  assert.deepEqual(snap.rows[1].cells.map((c) => c.status), ["alive", "alive", "alive"]);

  // Each observer's own cell is marked, because it is the one entry a node
  // writes rather than learns.
  assert.equal(snap.rows[0].cells[0].self, true);
  assert.equal(snap.rows[0].cells[1].self, false);
});

test("matrix: disagreement is counted, which is what convergence looks like", () => {
  const view = new ClusterView();

  // a thinks c is dead; b still sees it alive. Both are legitimate views.
  view.update("a:3000", {
    reachable: true,
    members: membersBody("a", [member("a"), member("b"), member("c", { localStatus: "dead" })]),
  }, 1000);
  view.update("b:3000", {
    reachable: true,
    members: membersBody("b", [member("a"), member("b"), member("c")]),
  }, 1000);

  let snap = view.snapshot(1000);
  assert.equal(snap.summary.disagreements, 1);
  // The worst opinion anyone holds is what the tiles report, so one node's
  // "dead" is never hidden behind three nodes' "alive".
  assert.equal(snap.summary.worstCase.dead, 1);
  assert.equal(snap.summary.worstCase.alive, 2);

  // a hears from c again: now everybody agrees and the count drops to zero.
  view.update("a:3000", {
    reachable: true,
    members: membersBody("a", [member("a"), member("b"), member("c")]),
  }, 2000);

  snap = view.snapshot(2000);
  assert.equal(snap.summary.disagreements, 0);
});

test("matrix: an unreachable node keeps its last view, marked stale", () => {
  const view = new ClusterView();
  view.update("a:3000", {
    reachable: true,
    members: membersBody("a", [member("a"), member("b")]),
  }, 1000);

  view.update("a:3000", { reachable: false, error: "timeout" }, 5000);

  const snap = view.snapshot(5000);
  const row = snap.rows[0];

  assert.equal(row.reachable, false);
  assert.equal(row.stale, true);
  assert.equal(row.error, "timeout");
  // The last known opinions are still shown (the UI greys them out) rather
  // than blanked: the dashboard's own link may be the broken one.
  assert.deepEqual(row.cells.map((c) => c.status), ["alive", "alive"]);
  // ...but a stale row does not count towards agreement.
  assert.equal(snap.summary.observersReachable, 0);
  assert.equal(snap.summary.disagreements, 0);
});

test("matrix: a restarted pod gives one row, not two", () => {
  // Kubernetes gives a restarted pod the same name and a new IP, so the old
  // address lingers in the view for a while. Two rows labelled "a" would read
  // as a protocol bug during a demo; the freshest report wins.
  const view = new ClusterView();
  view.update("10.0.0.1:3000", {
    reachable: true,
    members: membersBody("a", [member("a", { heartbeat: 90 })]),
  }, 1000);
  view.update("10.0.0.2:3000", {
    reachable: true,
    members: membersBody("a", [member("a", { heartbeat: 2 })]),
  }, 2000);

  const snap = view.snapshot(2000);

  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].observer, "a");
  assert.equal(snap.rows[0].address, "10.0.0.2:3000", "the newer pod IP wins");
  assert.equal(snap.rows[0].cells[0].heartbeat, 2, "and so does its fresh heartbeat");
});

test("matrix: a reachable report beats a stale one for the same node", () => {
  const view = new ClusterView();

  // The old pod IP answered once, so we know which node it was...
  view.update("10.0.0.1:3000", { reachable: true, members: membersBody("a", [member("a")]) }, 500);
  // ...the replacement answers on its new IP...
  view.update("10.0.0.2:3000", { reachable: true, members: membersBody("a", [member("a")]) }, 1000);
  // ...and the old IP now times out, which is a FRESHER report but a useless one.
  view.update("10.0.0.1:3000", { reachable: false, error: "timeout" }, 2000);

  const snap = view.snapshot(2000);

  assert.equal(snap.rows.length, 1, "one node id, one row");
  assert.equal(snap.rows[0].reachable, true, "a live answer beats a newer timeout");
  assert.equal(snap.rows[0].address, "10.0.0.2:3000");
});

test("matrix: an address that never answered is still shown, labelled by address", () => {
  // Nothing links it to a node id, so it cannot be merged with anything - and
  // hiding it would hide "we are polling something that never replies".
  const view = new ClusterView();
  view.update("10.0.0.7:3000", { reachable: false, error: "timeout" }, 1000);

  const snap = view.snapshot(1000);
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].observer, "10.0.0.7:3000");
  assert.equal(snap.rows[0].reachable, false);
});

test("matrix: a buried member is distinguished from one never heard of", () => {
  const view = new ClusterView();

  view.update("a:3000", {
    reachable: true,
    members: {
      ...membersBody("a", [member("a")]),
      graves: [{ id: "b", generation: 5, buriedAt: 10 }],
    },
  }, 1000);
  view.update("b:3000", {
    reachable: true,
    members: membersBody("b", [member("a"), member("b")]),
  }, 1000);

  const snap = view.snapshot(1000);
  const aRow = snap.rows.find((r) => r.observer === "a");

  assert.equal(aRow.cells.find((c) => c.id === "b").status, "buried");
});

// --- rumors -----------------------------------------------------------------

test("rumors: spread is timed with the dashboard's own clock", () => {
  const view = new ClusterView();
  const rumor = (nodeHops) => ({
    id: "r-1",
    origin: "a",
    payload: { msg: "hi" },
    createdAt: 500,
    hops: nodeHops,
    // Each node's own wall clock, deliberately nonsense here (it is 2000 on
    // one node and 1 on the other) to prove it is not used for timing.
    receivedAt: nodeHops === 0 ? 999_999 : 1,
  });

  // The dashboard sees a holding it at t=1000...
  view.update("a:3000", {
    reachable: true,
    members: membersBody("a", [member("a"), member("b")]),
    rumors: { rumors: [rumor(0)] },
  }, 1000);

  let snap = view.snapshot(1000);
  assert.equal(snap.rumors[0].holderCount, 1);
  assert.equal(snap.rumors[0].observedSpreadMs, null, "one holder is not a spread yet");
  assert.match(snap.rumors[0].spreadNote, /only one node/);

  // ...and b holding it at t=1400.
  view.update("b:3000", {
    reachable: true,
    members: membersBody("b", [member("a"), member("b")]),
    rumors: { rumors: [rumor(1)] },
  }, 1400);

  snap = view.snapshot(1400);
  assert.equal(snap.rumors[0].holderCount, 2);
  assert.equal(snap.rumors[0].observedSpreadMs, 400, "400 ms on ONE clock, not a clock difference");
  assert.equal(snap.rumors[0].maxHops, 1);
  assert.equal(snap.rumors[0].complete, true, "both members hold it");
  assert.equal(snap.rumors[0].spreadNote, null);
});

test("rumors: holders all seen in one sweep report no number, not 0 ms", () => {
  // A rumor can easily beat a 1 s poll interval. Reporting "0 ms" would read
  // as "spread instantly", when all the dashboard can honestly say is that it
  // was faster than it can measure.
  const view = new ClusterView();
  const rumor = { id: "r-1", origin: "a", payload: 1, createdAt: 1, hops: 0, receivedAt: 1 };

  for (const id of ["a", "b", "c"]) {
    view.update(`${id}:3000`, {
      reachable: true,
      members: membersBody(id, [member(id)]),
      rumors: { rumors: [rumor] },
    }, 1000); // same sweep: one timestamp for all three
  }

  const snap = view.snapshot(1000);
  assert.equal(snap.rumors[0].holderCount, 3);
  assert.equal(snap.rumors[0].observedSpreadMs, null);
  assert.match(snap.rumors[0].spreadNote, /faster than one poll/);
});

test("rumors: the first observation of a holder is kept, not the latest", () => {
  const view = new ClusterView();
  const body = {
    reachable: true,
    members: membersBody("a", [member("a")]),
    rumors: { rumors: [{ id: "r-1", origin: "a", payload: 1, createdAt: 1, hops: 0, receivedAt: 1 }] },
  };

  view.update("a:3000", body, 1000);
  view.update("a:3000", body, 9000); // polled again, same rumor

  const snap = view.snapshot(9000);
  assert.equal(snap.rumors[0].holders[0].observedAt, 1000, "spread must not drift with each poll");
});

test("rumors: the store is bounded", () => {
  const view = new ClusterView({ maxRumors: 2 });

  for (let i = 0; i < 4; i += 1) {
    view.update("a:3000", {
      reachable: true,
      members: membersBody("a", [member("a")]),
      rumors: { rumors: [{ id: `r-${i}`, origin: "a", payload: i, createdAt: i, hops: 0, receivedAt: i }] },
    }, 1000 + i);
  }

  assert.equal(view.snapshot(2000).rumors.length, 2);
});

// --- polling ----------------------------------------------------------------

test("pollNode: a node is reachable only if both endpoints answer", async () => {
  const ok = await pollNode("x:3000", 100, async (url) => ({
    json: async () => (url.endsWith("/members") ? membersBody("x", [member("x")]) : { rumors: [] }),
  }));
  assert.equal(ok.reachable, true);
  assert.equal(ok.members.self.id, "x");

  // /members answers but /rumors fails: half a view would look like a
  // protocol bug, so the whole poll counts as failed.
  const half = await pollNode("x:3000", 100, async (url) => {
    if (url.endsWith("/rumors")) throw new Error("ECONNREFUSED");
    return { json: async () => membersBody("x", []) };
  });
  assert.equal(half.reachable, false);
  assert.match(half.error, /ECONNREFUSED/);
});

// --- routes -----------------------------------------------------------------

function newDashboard({ fetchImpl = async () => { throw new Error("no fetch in test"); }, nodes = "a:3000,b:3000" } = {}) {
  const config = loadDashboardConfig({ NODES: nodes });
  const view = new ClusterView();
  const logger = pino({ level: "silent" });

  const app = createDashboardServer({ config, view, logger, now: () => 5000, fetchImpl });
  return { app, view, config };
}

test("GET /api/cluster serves the whole snapshot the UI needs", async () => {
  const { app, view } = newDashboard();
  view.update("a:3000", {
    reachable: true,
    members: membersBody("a", [member("a"), member("b")]),
  }, 4000);

  const res = await request(app).get("/api/cluster").expect(200);

  assert.deepEqual(res.body.columns, ["a", "b"]);
  assert.equal(res.body.rows.length, 1);
  assert.equal(res.body.rows[0].ageMs, 1000);
  // `polling` is what is actually being polled, not what was configured: with
  // NODE_DNS the configured list is empty and the live set is the only truth.
  assert.deepEqual(res.body.polling, ["a:3000"]);
  assert.equal(res.body.discovery, "static list");
});

test("POST /api/broadcast asks a real node to originate the rumor", async () => {
  const calls = [];
  const { app, view } = newDashboard({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { status: 202, json: async () => ({ rumor: { id: "r-1" } }) };
    },
  });
  view.update("a:3000", { reachable: true, members: membersBody("a", [member("a")]) }, 4000);

  const res = await request(app).post("/api/broadcast").send({ payload: { msg: "x" } }).expect(202);

  // The dashboard never invents a rumor of its own: the origin has to be a
  // cluster member, so the rumor travels by gossip like any other.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://a:3000/broadcast");
  assert.deepEqual(calls[0].body, { payload: { msg: "x" } });
  assert.equal(res.body.target, "a:3000");
});

test("POST /api/broadcast reports 503 when no node is reachable", async () => {
  const { app } = newDashboard();

  const res = await request(app).post("/api/broadcast").send({ payload: 1 }).expect(503);
  assert.match(res.body.error, /no node is currently reachable/);
});

test("POST /api/broadcast surfaces a node's failure as 502, not a crash", async () => {
  const { app, view } = newDashboard({
    fetchImpl: async () => { throw new Error("socket hang up"); },
  });
  view.update("a:3000", { reachable: true, members: membersBody("a", [member("a")]) }, 4000);

  const res = await request(app).post("/api/broadcast").send({ payload: 1 }).expect(502);
  assert.match(res.body.error, /socket hang up/);
});

test("the dashboard serves its three static files and nothing else", async () => {
  const { app } = newDashboard();

  const page = await request(app).get("/").expect(200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.text, /Membership matrix/);

  await request(app).get("/app.js").expect(200);
  await request(app).get("/style.css").expect(200);

  // No directory listing, no reading outside public/.
  await request(app).get("/../package.json").expect(404);
  await request(app).get("/aggregator.js").expect(404);
});

test("GET /health is about the dashboard, not the cluster", async () => {
  const { app } = newDashboard();

  const res = await request(app).get("/health").expect(200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.polling, 2);
});
