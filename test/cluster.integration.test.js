/**
 * Integration test: a real 5-node cluster, all inside this one process, each
 * node on its own port, talking over real HTTP.
 *
 * This test is only possible because of the Phase 1 refactor: MemberList is a
 * class instead of legacy/state.js's shared module-level Map, and createServer()
 * returns an app instead of calling listen() itself. With the tutorial layout,
 * five nodes in one process would all have shared one address book.
 *
 * Ports are in the 31xx range so this never collides with a cluster left
 * running on 3001-3005 from `npm run cluster:local`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { startNode } from "../src/index.js";
import { STATUS } from "../src/membership.js";

const BASE_PORT = 3141;
const NODE_COUNT = 5;
const INTERVAL_MS = 100; // fast rounds keep the test quick but still real
const PORTS = Array.from({ length: NODE_COUNT }, (_, i) => BASE_PORT + i);
const SEEDS = `localhost:${PORTS[0]},localhost:${PORTS[1]}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every node this test ever starts, in start order. Teardown stops all of
 * them, so a subtest that replaces a node keeps its reference locally and
 * never writes back into shared state after an await.
 *
 * @type {Array<ReturnType<typeof startNode>>}
 */
const launched = [];

/**
 * @param {{port: number, generation?: number}} options
 * @returns {ReturnType<typeof startNode>}
 */
function launch({ port, generation }) {
  const node = startNode({
    PORT: String(port),
    HOST: "localhost",
    NODE_ID: `node-${port}`,
    SEEDS,
    GOSSIP_INTERVAL_MS: String(INTERVAL_MS),
    REQUEST_TIMEOUT_MS: "80",
    FANOUT: "3",
    // Thresholds scaled down to the same ratio as the defaults (5x and 15x the
    // round interval), so this exercises the real policy, just faster.
    SUSPECT_MS: String(5 * INTERVAL_MS),
    DEAD_MS: String(15 * INTERVAL_MS),
    CLEANUP_MS: String(30 * INTERVAL_MS),
    SHUTDOWN_TIMEOUT_MS: "500",
    RUMOR_ROUNDS: "6",
    CHAOS_ENABLED: "true",
    LOG_LEVEL: "silent",
    ...(generation === undefined ? {} : { GENERATION: String(generation) }),
  });

  launched.push(node);
  return node;
}

/**
 * Stop a node the way a crash does: kill it without saying goodbye.
 *
 * Both timers must be cleared, or an interval would keep this test process
 * alive after the last assertion and `npm test` would simply hang.
 */
async function crash(node) {
  node.gossiper.stop();
  node.detector.stop();
  // close() on an already-closed server hands an error to the callback rather
  // than throwing, so this is safe to call twice during teardown.
  await new Promise((resolve) => node.server.close(() => resolve()));
}

/**
 * POST JSON to a node and return its status and parsed body.
 *
 * @param {number} port
 * @param {string} path
 * @param {object} [body]
 */
async function post(port, path, body = {}) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** @returns {Promise<{count: number, active: number, rumors: object[]} | null>} */
async function fetchRumors(port) {
  try {
    const res = await fetch(`http://localhost:${port}/rumors`);
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * A node that is mid-restart refuses connections for a few milliseconds, and
 * that is normal rather than a test failure - so an unreachable node reads as
 * "no view yet" instead of throwing.
 *
 * @returns {Promise<{self: object, members: object[]} | null>}
 */
async function fetchMembers(port) {
  try {
    const res = await fetch(`http://localhost:${port}/members`);
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Poll until `predicate` holds on every polled node, or give up.
 *
 * Polling (rather than one fixed sleep) is what keeps this test honest: it
 * measures how long convergence actually took instead of hiding it behind a
 * generous wait. A node that cannot be reached never satisfies the predicate,
 * so this can't pass by talking to nobody.
 *
 * @returns {Promise<{ok: boolean, elapsedMs: number, views: Array<object|null>}>}
 */
async function waitForAll(predicate, { ports = PORTS, timeoutMs = 5000, stepMs = 50 } = {}) {
  const started = Date.now();

  for (;;) {
    const views = await Promise.all(ports.map(fetchMembers));
    if (views.every((view) => view !== null && predicate(view))) {
      return { ok: true, elapsedMs: Date.now() - started, views };
    }
    if (Date.now() - started > timeoutMs) {
      return { ok: false, elapsedMs: Date.now() - started, views };
    }
    await sleep(stepMs);
  }
}

test("a 5-node cluster converges, keeps beating, and readmits a restarted node", async (t) => {
  /** The original five. Replacements are local to the subtest that makes them. */
  const nodes = PORTS.map((port) => launch({ port }));

  t.after(async () => {
    await Promise.all(launched.map(crash));
  });

  await t.test("every node learns every member", async () => {
    const { ok, elapsedMs, views } = await waitForAll((view) => view.members.length === NODE_COUNT);

    assert.ok(
      ok,
      `not converged after ${elapsedMs}ms; sizes: ${views.map((v) => v.members.length).join(",")}`,
    );

    // Each node's view must contain exactly the five ids, with no duplicates
    // and nobody missing - including itself.
    const expected = PORTS.map((port) => `node-${port}`).sort();
    for (const view of views) {
      assert.deepEqual(view.members.map((m) => m.id).sort(), expected);
      assert.equal(view.members.every((m) => m.status === STATUS.ALIVE), true);
    }

    // Convergence should take a handful of rounds, not dozens. With fanout 3
    // this is the O(log N) claim, measured rather than assumed.
    assert.ok(elapsedMs < 20 * INTERVAL_MS, `convergence took ${elapsedMs}ms`);
  });

  await t.test("heartbeats keep rising, so every member stays provably alive", async () => {
    const before = await fetchMembers(PORTS[0]);
    const heartbeatOf = (view, id) => view.members.find((m) => m.id === id).heartbeat;

    await sleep(6 * INTERVAL_MS);
    const after = await fetchMembers(PORTS[0]);

    for (const port of PORTS) {
      const id = `node-${port}`;
      assert.ok(
        heartbeatOf(after, id) > heartbeatOf(before, id),
        `${id} heartbeat did not advance (${heartbeatOf(before, id)} -> ${heartbeatOf(after, id)})`,
      );
    }
  });

  await t.test("local-only fields are never gossiped", async () => {
    // Ask node A what it thinks of node B. lastSeenAt is A's own clock
    // reading, so it must have been produced locally - and the number A holds
    // for B cannot have come off the wire.
    const view = await fetchMembers(PORTS[0]);

    for (const member of view.members) {
      assert.ok(Number.isFinite(member.lastSeenAt), "lastSeenAt missing from the local view");
    }

    // The wire format is what /gossip returns: it must not contain lastSeenAt.
    const res = await fetch(`http://localhost:${PORTS[0]}/gossip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { id: "probe", address: "localhost:1" }, members: [] }),
    });
    const body = await res.json();

    assert.ok(body.members.length > 0);
    for (const member of body.members) {
      assert.equal("lastSeenAt" in member, false, "lastSeenAt leaked onto the wire");
    }
  });

  await t.test("a rumor broadcast on one node reaches all five", async () => {
    const started = await post(PORTS[0], "/broadcast", { payload: { msg: "phase-4" } });
    assert.equal(started.status, 202);
    const rumorId = started.body.rumor.id;
    const sentAt = Date.now();

    // Poll until every node has it. Nothing acknowledges a rumor, so "has it"
    // is only observable by asking each node.
    let elapsedMs = 0;
    let views = [];
    for (;;) {
      views = await Promise.all(PORTS.map(fetchRumors));
      const everyone = views.every((v) => v?.rumors.some((r) => r.id === rumorId));
      elapsedMs = Date.now() - sentAt;
      if (everyone) break;

      assert.ok(elapsedMs < 40 * INTERVAL_MS, `rumor reached only some nodes after ${elapsedMs}ms`);
      await sleep(25);
    }

    // With fanout 3 this should take a handful of rounds, not dozens: the
    // O(log N) claim, measured rather than assumed.
    assert.ok(elapsedMs < 15 * INTERVAL_MS, `rumor spread took ${elapsedMs}ms`);

    // The payload survives the trip unchanged, and the origin is preserved all
    // the way out - only the hop count grows.
    for (const view of views) {
      const rumor = view.rumors.find((r) => r.id === rumorId);
      assert.deepEqual(rumor.payload, { msg: "phase-4" });
      assert.equal(rumor.origin, `node-${PORTS[0]}`);
      assert.ok(rumor.hops >= 0 && rumor.hops < NODE_COUNT, `implausible hop count ${rumor.hops}`);
    }
    // The originator is zero hops from itself; everyone else is at least one.
    const originView = views[0].rumors.find((r) => r.id === rumorId);
    assert.equal(originView.hops, 0);

    // And it burns out: after RUMOR_ROUNDS rounds nobody is forwarding it, so
    // the cluster stops spending bandwidth on news everyone already has.
    await sleep(12 * INTERVAL_MS);
    for (const port of PORTS) {
      const view = await fetchRumors(port);
      assert.equal(view.active, 0, `node-${port} is still forwarding a stale rumor`);
      assert.ok(
        view.rumors.some((r) => r.id === rumorId),
        "the rumor should still be remembered for /rumors",
      );
    }
  });

  await t.test("the same rumor arriving from several peers is learned once", async () => {
    const before = await fetchRumors(PORTS[1]);

    // Push an identical rumor straight into one node three times, the way
    // three different peers would in the same round.
    const rumor = {
      id: "duplicate-rumor",
      origin: "probe",
      payload: "dup",
      createdAt: Date.now(),
      hops: 0,
    };
    for (let i = 0; i < 3; i += 1) {
      await post(PORTS[1], "/gossip", {
        from: { id: "probe", address: "localhost:1" },
        members: [],
        rumors: [rumor],
      });
    }

    const after = await fetchRumors(PORTS[1]);
    assert.equal(after.count, before.count + 1, "a duplicate rumor was stored twice");
  });

  await t.test("metrics count real work and carry this node's id", async () => {
    const res = await fetch(`http://localhost:${PORTS[0]}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();

    const value = (pattern) => {
      const match = text.match(pattern);
      return match ? Number(match[1]) : null;
    };

    const rounds = value(/gossip_rounds_total\{[^}]*\} (\d+)/);
    assert.ok(rounds > 0, `expected rounds to have been counted, got ${rounds}`);

    const ok = value(/gossip_exchanges_total\{result="ok"[^}]*\} (\d+)/);
    assert.ok(ok > 0, `expected successful exchanges, got ${ok}`);

    assert.match(text, new RegExp(`nodeId="node-${PORTS[0]}"`));
    assert.match(text, /cluster_members_known\{localStatus="alive"/);
    assert.match(text, /rumors_created_total/);

    // Counters only go up: scrape twice and the round count must not shrink.
    await sleep(3 * INTERVAL_MS);
    const second = await (await fetch(`http://localhost:${PORTS[0]}/metrics`)).text();
    const roundsAgain = Number(second.match(/gossip_rounds_total\{[^}]*\} (\d+)/)[1]);
    assert.ok(roundsAgain > rounds, `rounds did not advance: ${rounds} -> ${roundsAgain}`);
  });

  await t.test("health is local, readiness reflects having met the cluster", async () => {
    for (const port of PORTS) {
      const health = await (await fetch(`http://localhost:${port}/health`)).json();
      assert.equal(health.status, "ok");

      const ready = await fetch(`http://localhost:${port}/ready`);
      assert.equal(ready.status, 200, `node-${port} should be ready by now`);
    }
  });

  await t.test("gossip is transitive: one reachable node keeps a split healthy", async () => {
    // Cut {0,1} off from {3,4}, but leave node 2 talking to everybody.
    const left = [PORTS[0], PORTS[1]];
    const right = [PORTS[3], PORTS[4]];
    const leftIds = left.map((p) => `node-${p}`);
    const rightIds = right.map((p) => `node-${p}`);

    try {
      for (const port of left) await post(port, "/chaos/partition", { block: rightIds });
      for (const port of right) await post(port, "/chaos/partition", { block: leftIds });

      // Wait well past DEAD_MS. Nobody should be declared anything: node 2
      // relays each side's rising heartbeats to the other, and a heartbeat
      // that arrives via a third party is just as good as a direct one. This
      // is why "can I reach X myself?" is the wrong question for membership -
      // and why a partition has to be total before it shows up as death.
      await sleep(25 * INTERVAL_MS);

      for (const port of PORTS) {
        const view = await fetchMembers(port);
        assert.deepEqual(
          view.members.filter((m) => m.localStatus !== "alive").map((m) => m.id),
          [],
          `node-${port} wrote someone off even though node-${PORTS[2]} was relaying`,
        );
      }
    } finally {
      // Heal in a finally, so one failed assertion cannot leave the cluster
      // partitioned for every later subtest.
      for (const port of PORTS) await post(port, "/chaos/heal");
    }
  });

  await t.test("a total partition makes each side declare the other dead, and healing reverses it", async () => {
    // Now a complete split, with no node able to bridge it: {0,1,2} | {3,4}.
    const left = [PORTS[0], PORTS[1], PORTS[2]];
    const right = [PORTS[3], PORTS[4]];
    const leftIds = left.map((p) => `node-${p}`);
    const rightIds = right.map((p) => `node-${p}`);

    try {
      for (const port of left) await post(port, "/chaos/partition", { block: rightIds });
      for (const port of right) await post(port, "/chaos/partition", { block: leftIds });

      const statusOf = (view, id) => view.members.find((m) => m.id === id)?.localStatus;

      // Each side concludes the other is dead - and nobody told them to. The
      // verdict is never gossiped, so these are five independent conclusions
      // drawn from silence. Both halves keep serving happily: this is what
      // choosing availability over consistency looks like in practice.
      const split = await waitForAll(
        (view) => {
          const others = leftIds.includes(view.self.id) ? rightIds : leftIds;
          return others.every((id) => statusOf(view, id) === "dead");
        },
        { ports: PORTS, timeoutMs: 40 * INTERVAL_MS },
      );
      assert.ok(
        split.ok,
        `the two sides never declared each other dead; views: ${split.views
          .map((v) => JSON.stringify(v?.byLocalStatus))
          .join(" ")}`,
      );

      // Both halves are still live and still ready - an isolated node does not
      // need restarting, which is exactly why /health ignores the cluster.
      for (const port of PORTS) {
        const health = await (await fetch(`http://localhost:${port}/health`)).json();
        assert.equal(health.status, "ok");
      }
    } finally {
      for (const port of PORTS) await post(port, "/chaos/heal");
    }

    // Healing needs no reconciliation step at all: the next heartbeat each
    // side receives is simply a newer version, which clears the verdict.
    const healed = await waitForAll(
      (view) => view.members.every((m) => m.localStatus === "alive"),
      { ports: PORTS, timeoutMs: 40 * INTERVAL_MS },
    );
    assert.ok(
      healed.ok,
      `cluster did not re-converge; views: ${healed.views
        .map((v) => JSON.stringify(v?.byLocalStatus))
        .join(" ")}`,
    );
  });

  await t.test("a crashed node is reported suspect, then dead", async () => {
    const victimPort = PORTS[4];
    const victimId = `node-${victimPort}`;
    const survivors = PORTS.filter((port) => port !== victimPort);

    // Kill it the rude way: no goodbye, exactly like `kill -9` or a pod being
    // deleted without a grace period. The only signal left is silence.
    await crash(nodes[PORTS.indexOf(victimPort)]);
    const crashedAt = Date.now();

    const localStatusOf = (view) => view.members.find((m) => m.id === victimId)?.localStatus;

    const suspected = await waitForAll(
      (view) => localStatusOf(view) === "suspect",
      { ports: survivors, timeoutMs: 30 * INTERVAL_MS },
    );
    assert.ok(
      suspected.ok,
      `never suspected; statuses: ${suspected.views.map((v) => localStatusOf(v)).join(",")}`,
    );
    const suspectAfterMs = Date.now() - crashedAt;

    const declaredDead = await waitForAll(
      (view) => localStatusOf(view) === "dead",
      { ports: survivors, timeoutMs: 40 * INTERVAL_MS },
    );
    assert.ok(
      declaredDead.ok,
      `never declared dead; statuses: ${declaredDead.views.map((v) => localStatusOf(v)).join(",")}`,
    );
    const deadAfterMs = Date.now() - crashedAt;

    // The ordering is the point: suspect must come first, and dead must not
    // arrive before DEAD_MS of actual silence has passed.
    assert.ok(suspectAfterMs < deadAfterMs, `suspect ${suspectAfterMs}ms, dead ${deadAfterMs}ms`);
    // DEAD_MS is measured from the member's last version, which arrived a
    // round or two before we killed it - so allow that much slack rather than
    // asserting the full DEAD_MS and inviting a flake.
    assert.ok(
      deadAfterMs >= 13 * INTERVAL_MS,
      `declared dead after only ${deadAfterMs}ms, DEAD_MS is ${15 * INTERVAL_MS}ms`,
    );

    // A dead member is kept as a tombstone, not deleted, so stale gossip
    // cannot reintroduce it as a brand new member.
    const view = await fetchMembers(survivors[0]);
    assert.equal(view.members.length, NODE_COUNT, "the tombstone should still be listed");

    // Nobody gossips the verdict: it is each node's own conclusion, reached
    // from silence, and it must never travel on the wire.
    const res = await fetch(`http://localhost:${survivors[0]}/gossip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: { id: "probe", address: "localhost:1" }, members: [] }),
    });
    const body = await res.json();
    for (const member of body.members) {
      assert.equal("localStatus" in member, false, "localStatus leaked onto the wire");
    }

    // Put it back so the remaining subtests see a whole cluster.
    launch({ port: victimPort });
    const healed = await waitForAll(
      (view2) => localStatusOf(view2) === "alive",
      { ports: survivors, timeoutMs: 40 * INTERVAL_MS },
    );
    assert.ok(healed.ok, "a restarted node should clear the dead verdict");
  });

  await t.test("a node that leaves gracefully is marked left, never dead", async () => {
    const leaverPort = PORTS[3];
    const leaverId = `node-${leaverPort}`;
    const survivors = PORTS.filter((port) => port !== leaverPort);

    // shutdown() is exactly what the SIGTERM handler calls: announce, bump the
    // heartbeat, gossip once, then close. (The signal itself cannot be tested
    // here - on Windows SIGTERM is not a real signal.)
    await nodes[PORTS.indexOf(leaverPort)].shutdown("test");

    const entryOf = (view) => view.members.find((m) => m.id === leaverId);

    const left = await waitForAll(
      (view) => entryOf(view)?.status === "left",
      { ports: survivors, timeoutMs: 20 * INTERVAL_MS },
    );
    assert.ok(
      left.ok,
      `never announced left; statuses: ${left.views.map((v) => entryOf(v)?.status).join(",")}`,
    );

    for (const view of left.views) {
      assert.equal(entryOf(view).localStatus, "left");
    }

    // And it stays "left": the silence that follows must not be reinterpreted
    // as a failure, however long it lasts.
    await sleep(20 * INTERVAL_MS);
    for (const port of survivors) {
      const entry = entryOf(await fetchMembers(port));
      assert.ok(entry === undefined || entry.localStatus === "left", "a leaver turned into a failure");
    }

    launch({ port: leaverPort });
    const rejoined = await waitForAll(
      (view) => entryOf(view)?.localStatus === "alive",
      { ports: survivors, timeoutMs: 40 * INTERVAL_MS },
    );
    assert.ok(rejoined.ok, "a node that left should be able to come back");
  });

  await t.test("a restarted node is readmitted thanks to its new generation", async () => {
    const victimPort = PORTS[2];
    const victimId = `node-${victimPort}`;

    // Let the victim build up a high heartbeat, then note what its peers hold.
    await sleep(10 * INTERVAL_MS);
    const beforeRestart = await fetchMembers(PORTS[0]);
    const oldEntry = beforeRestart.members.find((m) => m.id === victimId);
    assert.ok(oldEntry.heartbeat > 5, `expected a built-up heartbeat, got ${oldEntry.heartbeat}`);

    // Kill it and start it again with a HIGHER generation and heartbeat 0 -
    // exactly what a real process restart looks like.
    const victimIndex = PORTS.indexOf(victimPort);
    await crash(nodes[victimIndex]);

    const newGeneration = oldEntry.generation + 1;
    launch({ port: victimPort, generation: newGeneration });

    // Every SURVIVING node must accept (newGeneration, 0) over (oldGeneration,
    // high heartbeat). Without the generation field this would look like a
    // huge step backwards and be rejected as stale forever.
    //
    // The victim itself is excluded from the poll on purpose: it trivially
    // knows its own new generation, so including it would weaken the check.
    const survivors = PORTS.filter((port) => port !== victimPort);
    const { ok, elapsedMs, views } = await waitForAll(
      (view) => {
        const entry = view.members.find((m) => m.id === victimId);
        return entry !== undefined && entry.generation === newGeneration;
      },
      { ports: survivors },
    );

    assert.ok(
      ok,
      `restarted node not readmitted after ${elapsedMs}ms; generations: ` +
        views.map((v) => v?.members.find((m) => m.id === victimId)?.generation ?? "unreachable").join(","),
    );

    const peerView = await fetchMembers(PORTS[0]);
    const newEntry = peerView.members.find((m) => m.id === victimId);
    assert.equal(newEntry.generation, newGeneration);
    assert.ok(
      newEntry.heartbeat < oldEntry.heartbeat,
      "the fresh incarnation should have restarted its heartbeat from 0",
    );
  });
});
