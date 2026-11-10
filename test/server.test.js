/**
 * Route tests via supertest: it drives the Express app in-process, so no real
 * port is opened and nothing can collide with a node you left running.
 */

import test from "node:test";
import assert from "node:assert/strict";

import request from "supertest";
import pino from "pino";

import { Chaos } from "../src/chaos.js";
import { loadConfig } from "../src/config.js";
import { MemberList } from "../src/membership.js";
import { Metrics } from "../src/metrics.js";
import { RumorStore } from "../src/rumors.js";
import { createServer } from "../src/server.js";

/**
 * Build a node's app with fake clocks and a silent logger.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env] Extra config env.
 * @param {() => number} [options.now] Monotonic clock.
 * @param {() => number} [options.wallNow] Wall clock.
 * @param {number} [options.successfulExchanges] What readiness reads.
 */
function newApp({ env = {}, now = () => 5000, wallNow = () => 1_700_000_000_000, successfulExchanges = 0 } = {}) {
  const config = loadConfig({ PORT: "3001", NODE_ID: "node-3001", ...env });
  const members = new MemberList({
    selfId: config.nodeId,
    selfAddress: config.address,
    generation: 100,
    now: 1000,
  });
  const rumors = new RumorStore({
    selfId: config.nodeId,
    rumorRounds: config.rumorRounds,
    maxRumors: config.maxRumors,
  });
  const logger = pino({ level: "silent" });
  const metrics = new Metrics({ nodeId: config.nodeId, collectDefaults: false });
  const chaos = new Chaos({ members, logger });

  const app = createServer({
    config, members, rumors, logger, metrics, chaos, now, wallNow,
    gossiper: { successfulExchanges },
  });

  return { app, config, members, rumors, metrics, chaos };
}

// --- /gossip ----------------------------------------------------------------

test("GET /members returns this node's own view", async () => {
  const { app } = newApp();

  const res = await request(app).get("/members").expect(200);

  assert.equal(res.body.self.id, "node-3001");
  assert.equal(res.body.count, 1);
  assert.equal(res.body.members[0].id, "node-3001");
  assert.deepEqual(res.body.byLocalStatus, { alive: 1 });
  assert.deepEqual(res.body.graves, []);
});

test("POST /gossip merges the pushed list and replies with our own", async () => {
  const { app, members } = newApp();

  const res = await request(app)
    .post("/gossip")
    .send({
      from: { id: "node-3002", address: "localhost:3002" },
      members: [
        { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 4 },
        { id: "node-3003", address: "localhost:3003", generation: 1, heartbeat: 4 },
      ],
    })
    .expect(200);

  // The reply is our view from BEFORE the merge, so we don't echo the peer's
  // own entries straight back at it.
  assert.equal(res.body.from.id, "node-3001");
  assert.deepEqual(res.body.members.map((m) => m.id), ["node-3001"]);
  assert.deepEqual(res.body.rumors, []);

  // ...but we did learn both of them.
  assert.equal(members.size, 3);
  assert.equal(members.get("node-3003").heartbeat, 4);
  assert.equal(members.get("node-3003").lastSeenAt, 5000); // our injected clock
});

test("POST /gossip never lets a peer rewrite our own entry", async () => {
  const { app, members } = newApp();

  await request(app)
    .post("/gossip")
    .send({
      from: { id: "node-3002", address: "localhost:3002" },
      members: [
        { id: "node-3001", address: "evil:9999", generation: 999999, heartbeat: 999999 },
      ],
    })
    .expect(200);

  assert.equal(members.get("node-3001").address, "localhost:3001");
  assert.equal(members.size, 1);
});

test("POST /gossip rejects a missing sender and self-gossip", async () => {
  const { app } = newApp();

  await request(app).post("/gossip").send({}).expect(400);
  await request(app).post("/gossip").send({ from: { id: "   " } }).expect(400);

  const res = await request(app)
    .post("/gossip")
    .send({ from: { id: "node-3001", address: "localhost:3001" } })
    .expect(400);
  assert.match(res.body.error, /cannot gossip with self/);
});

test("POST /gossip survives a body with no member list", async () => {
  const { app, members } = newApp();

  await request(app)
    .post("/gossip")
    .send({ from: { id: "node-3002", address: "localhost:3002" } })
    .expect(200);

  // One dead or malformed request must never take the node down.
  assert.equal(members.size, 1);
});

test("POST /gossip carries rumors in both directions", async () => {
  const { app, rumors } = newApp();

  // Something we already know, so the peer gets it in the reply.
  rumors.create({ payload: "ours", now: 1_700_000_000_000 });

  const res = await request(app)
    .post("/gossip")
    .send({
      from: { id: "node-3002", address: "localhost:3002" },
      members: [],
      rumors: [
        { id: "r-1", origin: "node-3002", payload: "theirs", createdAt: 1_600_000_000_000, hops: 0 },
      ],
    })
    .expect(200);

  assert.deepEqual(res.body.rumors.map((r) => r.payload), ["ours"]);

  // We learned theirs, and counted it as one hop further from the origin.
  const learned = rumors.get("r-1");
  assert.equal(learned.payload, "theirs");
  assert.equal(learned.hops, 1);
});

// --- /broadcast and /rumors -------------------------------------------------

test("POST /broadcast starts a rumor and returns it", async () => {
  const { app, rumors } = newApp();

  const res = await request(app).post("/broadcast").send({ payload: { msg: "hello" } }).expect(202);

  assert.equal(res.body.rumor.origin, "node-3001");
  assert.equal(res.body.rumor.hops, 0);
  assert.deepEqual(res.body.rumor.payload, { msg: "hello" });
  assert.equal(rumors.size, 1);
});

test("POST /broadcast requires a payload", async () => {
  const { app } = newApp();

  const res = await request(app).post("/broadcast").send({}).expect(400);
  assert.match(res.body.error, /payload is required/);
});

test("GET /rumors lists what this node has heard, newest first", async () => {
  const { app, rumors } = newApp();

  rumors.create({ payload: "first", now: 1000 });
  rumors.create({ payload: "second", now: 2000 });

  const res = await request(app).get("/rumors").expect(200);

  assert.equal(res.body.count, 2);
  assert.equal(res.body.active, 2);
  assert.deepEqual(res.body.rumors.map((r) => r.payload), ["second", "first"]);
});

// --- /health and /ready -----------------------------------------------------

test("GET /health reports liveness without consulting the cluster", async () => {
  // Even with no peers at all, a running process is live. If this failed on
  // peer loss, a partition would make Kubernetes restart every pod.
  const { app } = newApp();

  const res = await request(app).get("/health").expect(200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.nodeId, "node-3001");
});

test("GET /ready is 503 until an exchange has happened", async () => {
  const withSeeds = newApp({ env: { SEEDS: "localhost:3002" }, successfulExchanges: 0 });
  const notReady = await request(withSeeds.app).get("/ready").expect(503);
  assert.equal(notReady.body.ready, false);
  assert.match(notReady.body.reason, /no exchange yet/);

  const joined = newApp({ env: { SEEDS: "localhost:3002" }, successfulExchanges: 1 });
  const ready = await request(joined.app).get("/ready").expect(200);
  assert.equal(ready.body.ready, true);
});

test("GET /ready stays 503 when seeds come from DNS and nothing was reached", async () => {
  // The Kubernetes case: SEEDS is empty but SEED_DNS is set, so this node is
  // expected to join something. Reporting ready here would let a cluster of
  // five lonely nodes pass its readiness probes.
  const { app } = newApp({ env: { SEED_DNS: "gossip-headless" }, successfulExchanges: 0 });

  const res = await request(app).get("/ready").expect(503);
  assert.match(res.body.reason, /no exchange yet/);
});

test("GET /ready is immediately ready with no seeds - it is the cluster", async () => {
  const { app } = newApp({ successfulExchanges: 0 });

  const res = await request(app).get("/ready").expect(200);
  assert.match(res.body.reason, /no seeds configured/);
});

// --- /metrics ---------------------------------------------------------------

test("GET /metrics exposes Prometheus text with this node's labels", async () => {
  const { app, metrics } = newApp();

  metrics.roundStarted();
  metrics.roundStarted();
  metrics.exchangeFinished("ok", 0.01);
  metrics.exchangeFinished("failed");

  const res = await request(app).get("/metrics").expect(200);

  assert.match(res.headers["content-type"], /text\/plain/);
  assert.match(res.text, /gossip_rounds_total\{nodeId="node-3001"\} 2/);
  assert.match(res.text, /gossip_exchanges_total\{result="ok",nodeId="node-3001"\} 1/);
  assert.match(res.text, /gossip_exchanges_total\{result="failed",nodeId="node-3001"\} 1/);
  // Gauges are sampled at scrape time, so this reflects the list right now.
  assert.match(res.text, /cluster_members_known\{localStatus="alive",nodeId="node-3001"\} 1/);
});

// --- /chaos -----------------------------------------------------------------

test("chaos routes do not exist unless CHAOS_ENABLED", async () => {
  const { app } = newApp();

  await request(app).get("/chaos").expect(404);
  await request(app).post("/chaos/partition").send({ block: ["node-3002"] }).expect(404);
  await request(app).post("/chaos/crash").expect(404);
});

test("chaos partition blocks inbound gossip in both directions", async () => {
  const { app, chaos } = newApp({ env: { CHAOS_ENABLED: "true" } });

  const applied = await request(app)
    .post("/chaos/partition")
    .send({ block: ["node-3002"] })
    .expect(200);
  assert.deepEqual(applied.body.blocked, ["node-3002"]);

  // The blocked peer's gossip is refused, not merged: a one-way block would
  // let news leak across the partition.
  const refused = await request(app)
    .post("/gossip")
    .send({ from: { id: "node-3002", address: "localhost:3002" }, members: [] })
    .expect(503);
  assert.match(refused.body.error, /partitioned/);

  // Anyone else still gets through.
  await request(app)
    .post("/gossip")
    .send({ from: { id: "node-3003", address: "localhost:3003" }, members: [] })
    .expect(200);

  assert.equal(chaos.isBlocked({ id: "node-3002" }), true);

  await request(app).post("/chaos/heal").expect(200);
  await request(app)
    .post("/gossip")
    .send({ from: { id: "node-3002", address: "localhost:3002" }, members: [] })
    .expect(200);
});

test("chaos partition rejects an empty block list", async () => {
  const { app } = newApp({ env: { CHAOS_ENABLED: "true" } });

  await request(app).post("/chaos/partition").send({ block: [] }).expect(400);
  await request(app).post("/chaos/partition").send({}).expect(400);
});

test("chaos freeze and thaw are reported in /chaos", async () => {
  const { app } = newApp({ env: { CHAOS_ENABLED: "true" } });

  await request(app).post("/chaos/freeze").send({}).expect(200);
  const frozen = await request(app).get("/chaos").expect(200);
  assert.equal(frozen.body.frozen, true);

  // A frozen node still answers HTTP on purpose: a real event-loop hang would
  // fail the liveness probe and get the pod restarted mid-demo.
  await request(app).get("/health").expect(200);

  await request(app).post("/chaos/thaw").expect(200);
  const thawed = await request(app).get("/chaos").expect(200);
  assert.equal(thawed.body.frozen, false);
});

// --- fallbacks --------------------------------------------------------------

test("unknown routes answer with JSON, not an HTML error page", async () => {
  const { app } = newApp();

  const res = await request(app).get("/friends").expect(404);

  assert.match(res.headers["content-type"], /application\/json/);
  assert.match(res.body.error, /unknown route GET \/friends/);
});
