/**
 * RumorStore tests. Fake clock and injected ids, so every assertion is exact:
 * no randomUUID, no Date.now, no sleeping while a counter ticks down.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RumorStore } from "../src/rumors.js";

function newStore({ rumorRounds = 3, maxRumors = 100, selfId = "node-3001" } = {}) {
  return new RumorStore({ selfId, rumorRounds, maxRumors });
}

/** A rumor as it arrives on the wire. */
const incoming = (overrides = {}) => ({
  id: "r-1",
  origin: "node-3002",
  payload: "hello",
  createdAt: 1000,
  hops: 0,
  ...overrides,
});

// --- starting a rumor -------------------------------------------------------

test("rumors: create() stamps the origin, zero hops and a full round budget", () => {
  const store = newStore({ rumorRounds: 3 });

  const rumor = store.create({ payload: { msg: "hi" }, now: 5000, newId: () => "r-local" });

  assert.equal(rumor.id, "r-local");
  assert.equal(rumor.origin, "node-3001");
  assert.deepEqual(rumor.payload, { msg: "hi" });
  assert.equal(rumor.hops, 0, "the origin is zero hops from itself");
  assert.equal(rumor.createdAt, 5000);
  assert.equal(rumor.receivedAt, 5000);
  assert.equal(rumor.roundsLeft, 3);
  assert.equal(store.size, 1);
});

test("rumors: a rumor we started comes back around and is not re-learned", () => {
  const store = newStore();
  const mine = store.create({ payload: "mine", now: 1000, newId: () => "r-mine" });

  // A peer dutifully gossips it back at us, one hop along.
  const relearned = store.receive({ ...mine, hops: 1 }, 2000);

  assert.equal(relearned, false);
  assert.equal(store.size, 1);
  assert.equal(store.get("r-mine").hops, 0, "our own rumor keeps its own hop count");
});

// --- receiving --------------------------------------------------------------

test("rumors: receive() counts one more hop and restarts the round budget", () => {
  const store = newStore({ rumorRounds: 3 });

  assert.equal(store.receive(incoming({ hops: 2 }), 9000), true);

  const rumor = store.get("r-1");
  assert.equal(rumor.hops, 3, "two hops to the peer, one more to us");
  assert.equal(rumor.origin, "node-3002");
  assert.equal(rumor.createdAt, 1000, "the origin's timestamp travels unchanged");
  assert.equal(rumor.receivedAt, 9000, "receivedAt is OUR clock");
  assert.equal(rumor.roundsLeft, 3);
});

test("rumors: the same rumor from many peers is learned exactly once", () => {
  const store = newStore();

  assert.equal(store.receive(incoming(), 1000), true);
  // Same round, three more peers tell us the same thing.
  assert.equal(store.receive(incoming({ hops: 1 }), 1001), false);
  assert.equal(store.receive(incoming({ hops: 5 }), 1002), false);
  assert.equal(store.receive(incoming(), 1003), false);

  assert.equal(store.size, 1);
  // Crucially the round budget was NOT reset, or the epidemic would never
  // burn out: peers keep re-telling it for as long as anyone is spreading it.
  assert.equal(store.get("r-1").roundsLeft, 3);
  assert.equal(store.get("r-1").receivedAt, 1000, "first arrival is the one that counts");
});

test("rumors: a rumor is not re-learned even after it stopped spreading", () => {
  const store = newStore({ rumorRounds: 2 });
  store.receive(incoming(), 1000);

  store.afterRound();
  store.afterRound();
  assert.equal(store.activeCount(), 0, "its budget is spent");

  // It is still in the store for display, and still refused as "news".
  assert.equal(store.receive(incoming(), 5000), false);
  assert.equal(store.get("r-1").receivedAt, 1000);
});

test("rumors: malformed rumors are dropped, not crashed on", () => {
  const store = newStore();
  const garbage = [
    null,
    undefined,
    "not an object",
    [],
    {},
    incoming({ id: "" }),
    incoming({ id: 42 }),
    incoming({ origin: "" }),
    incoming({ createdAt: "soon" }),
    incoming({ createdAt: NaN }),
    incoming({ hops: -1 }),
    incoming({ hops: 1.5 }),
    incoming({ hops: undefined }),
  ];

  for (const entry of garbage) {
    assert.equal(store.receive(entry, 1000), false, `accepted ${JSON.stringify(entry)}`);
  }
  assert.equal(store.size, 0);
});

test("rumors: a null or false payload is still a valid rumor", () => {
  // Only the envelope is validated. The payload is the user's business, and
  // `false` or `null` must not be mistaken for "missing".
  const store = newStore();

  assert.equal(store.receive(incoming({ id: "r-null", payload: null }), 1000), true);
  assert.equal(store.receive(incoming({ id: "r-false", payload: false }), 1000), true);
  assert.equal(store.size, 2);
});

test("rumors: receiveAll counts only what was new", () => {
  const store = newStore();

  const learned = store.receiveAll(
    [incoming({ id: "a" }), incoming({ id: "b" }), incoming({ id: "a" }), "garbage"],
    1000,
  );

  assert.equal(learned, 2);
  assert.equal(store.size, 2);
  assert.equal(store.receiveAll(undefined, 1000), 0);
  assert.equal(store.receiveAll(42, 1000), 0);
});

// --- spreading and burning out ---------------------------------------------

test("rumors: forwardable() stops after RUMOR_ROUNDS rounds", () => {
  const store = newStore({ rumorRounds: 3 });
  store.create({ payload: "x", now: 1000, newId: () => "r-x" });

  const budgets = [];
  for (let round = 0; round < 5; round += 1) {
    budgets.push(store.forwardable().length);
    store.afterRound();
  }

  // Forwarded in 3 rounds, then silence - without any coordination.
  assert.deepEqual(budgets, [1, 1, 1, 0, 0]);
  assert.equal(store.activeCount(), 0);
  assert.equal(store.size, 1, "still remembered, just no longer repeated");
});

test("rumors: afterRound() reports how many rumors are still spreading", () => {
  const store = newStore({ rumorRounds: 2 });
  store.create({ payload: "a", now: 1000, newId: () => "a" });
  store.create({ payload: "b", now: 1000, newId: () => "b" });

  assert.equal(store.afterRound(), 2);
  assert.equal(store.afterRound(), 0);
  assert.equal(store.afterRound(), 0);
});

test("rumors: forwardable() hides local bookkeeping", () => {
  const store = newStore();
  store.create({ payload: "x", now: 1000, newId: () => "r-x" });

  for (const wire of store.forwardable()) {
    assert.deepEqual(
      Object.keys(wire).sort(),
      ["createdAt", "hops", "id", "origin", "payload"],
    );
    assert.equal("roundsLeft" in wire, false, "our round budget is nobody else's business");
    assert.equal("receivedAt" in wire, false, "receivedAt is our clock reading");
  }
});

// --- bounded memory ---------------------------------------------------------

test("rumors: the store is bounded, and eviction cannot revive a rumor", () => {
  const store = newStore({ rumorRounds: 1, maxRumors: 3 });

  for (let i = 0; i < 5; i += 1) {
    store.receive(incoming({ id: `r-${i}` }), 1000 + i);
  }

  assert.equal(store.size, 3, "oldest entries dropped");
  assert.deepEqual(store.snapshot().map((r) => r.id).sort(), ["r-2", "r-3", "r-4"]);

  // r-0 was evicted, but its id is still in the seen-set, so it cannot come
  // back and start spreading again.
  assert.equal(store.receive(incoming({ id: "r-0" }), 9000), false);
  assert.equal(store.size, 3);
});

test("rumors: snapshot is newest-first and hands out copies", () => {
  const store = newStore();
  store.receive(incoming({ id: "old" }), 1000);
  store.receive(incoming({ id: "new" }), 2000);

  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.map((r) => r.id), ["new", "old"]);

  snapshot[0].payload = "tampered";
  assert.equal(store.get("new").payload, "hello");
});

test("rumors: two stores in one process stay independent", () => {
  // Same reason MemberList is a class: five nodes share one test process.
  const a = newStore({ selfId: "a" });
  const b = newStore({ selfId: "b" });

  a.create({ payload: "x", now: 1000, newId: () => "r-x" });

  assert.equal(a.size, 1);
  assert.equal(b.size, 0);
  assert.equal(b.receive({ ...a.get("r-x"), hops: 0 }, 2000), true, "b has never seen it");
});
