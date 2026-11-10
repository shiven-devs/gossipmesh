/**
 * Failure detector tests. Every one runs on a FAKE clock: `now` is a number we
 * choose, so a 15-second timeout is tested in microseconds and the result is
 * never flaky. This is the payoff for keeping `now` a parameter everywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MemberList, LOCAL_STATUS, STATUS } from "../src/membership.js";
import { classify, isReadyToBury, sweep, BURIED, FailureDetector } from "../src/failureDetector.js";

const THRESHOLDS = Object.freeze({ suspectMs: 5000, deadMs: 15000, cleanupMs: 60000 });

function newList(now = 0) {
  return new MemberList({
    selfId: "node-3001",
    selfAddress: "localhost:3001",
    generation: 100,
    now,
  });
}

/** Add node-3002 to the list, last seen at `lastSeenAt`. */
function withPeer(members, { lastSeenAt = 0, heartbeat = 1, status = STATUS.ALIVE } = {}) {
  members.merge(
    { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat, status },
    lastSeenAt,
  );
  return members;
}

const entry = (overrides) => ({
  id: "node-3002",
  address: "localhost:3002",
  generation: 1,
  heartbeat: 1,
  status: STATUS.ALIVE,
  metadata: {},
  lastSeenAt: 0,
  localStatus: LOCAL_STATUS.ALIVE,
  ...overrides,
});

// --- classify: the pure decision ------------------------------------------

test("classify: silence crosses alive -> suspect -> dead at the thresholds", () => {
  const e = entry({ lastSeenAt: 1000 });

  assert.equal(classify(e, 1000, THRESHOLDS), LOCAL_STATUS.ALIVE);
  // Exactly at the threshold is still alive: the comparison is strict, so a
  // member is only suspect once it is genuinely past SUSPECT_MS.
  assert.equal(classify(e, 6000, THRESHOLDS), LOCAL_STATUS.ALIVE);
  assert.equal(classify(e, 6001, THRESHOLDS), LOCAL_STATUS.SUSPECT);

  assert.equal(classify(e, 16000, THRESHOLDS), LOCAL_STATUS.SUSPECT);
  assert.equal(classify(e, 16001, THRESHOLDS), LOCAL_STATUS.DEAD);
});

test("classify: a member that announced its exit is never a failure", () => {
  // Quiet for an hour, but it told us it was going. Reporting that as dead
  // would erase the entire graceful-vs-crash distinction.
  const left = entry({ lastSeenAt: 0, status: STATUS.LEFT });

  assert.equal(classify(left, 3_600_000, THRESHOLDS), LOCAL_STATUS.LEFT);
});

test("isReadyToBury: dead waits DEAD_MS + CLEANUP_MS, left waits CLEANUP_MS", () => {
  const dead = entry({ lastSeenAt: 0 });
  assert.equal(isReadyToBury(dead, 75_000, THRESHOLDS), false); // 15000 + 60000
  assert.equal(isReadyToBury(dead, 75_001, THRESHOLDS), true);

  const left = entry({ lastSeenAt: 0, status: STATUS.LEFT });
  assert.equal(isReadyToBury(left, 60_000, THRESHOLDS), false);
  assert.equal(isReadyToBury(left, 60_001, THRESHOLDS), true);
});

// --- sweep: applying the decision to a list -------------------------------

test("sweep: walks a member through suspect, dead and burial", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0 });
  const run = (now) => sweep({ members, now, thresholds: THRESHOLDS });

  assert.deepEqual(run(1000), [], "nothing to report while it is alive");
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.ALIVE);

  const toSuspect = run(6001);
  assert.equal(toSuspect.length, 1);
  assert.deepEqual(
    { from: toSuspect[0].from, to: toSuspect[0].to },
    { from: LOCAL_STATUS.ALIVE, to: LOCAL_STATUS.SUSPECT },
  );

  // Still suspect on the next pass: a transition is reported once, not every
  // tick, so logs and metrics do not drown in repeats.
  assert.deepEqual(run(7000), []);

  const toDead = run(16001);
  assert.equal(toDead.length, 1);
  assert.equal(toDead[0].to, LOCAL_STATUS.DEAD);
  assert.equal(members.size, 2, "a dead member stays as a tombstone");

  const toBuried = run(75_001);
  assert.equal(toBuried.length, 1);
  assert.equal(toBuried[0].to, BURIED);
  assert.equal(members.size, 1, "the tombstone is gone");
  assert.deepEqual(members.graves().map((g) => g.id), ["node-3002"]);
});

test("sweep: suspicion is reversible - one newer heartbeat clears it", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0, heartbeat: 1 });

  sweep({ members, now: 6001, thresholds: THRESHOLDS });
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.SUSPECT);

  // The member answers a gossip round: newer version, so lastSeenAt moves.
  members.merge(
    { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 2 },
    6500,
  );
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.ALIVE, "cleared on merge");

  assert.deepEqual(sweep({ members, now: 7000, thresholds: THRESHOLDS }), []);
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.ALIVE);
});

test("sweep: even a member already declared dead comes back on newer news", () => {
  // Nothing about "dead" is final - it is one node's opinion, and a network
  // partition that heals produces exactly this.
  const members = withPeer(newList(0), { lastSeenAt: 0, heartbeat: 1 });
  sweep({ members, now: 16_001, thresholds: THRESHOLDS });
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.DEAD);

  members.merge(
    { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 2 },
    16_500,
  );

  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.ALIVE);
  assert.deepEqual(sweep({ members, now: 17_000, thresholds: THRESHOLDS }), []);
});

test("sweep: never judges its own entry", () => {
  const members = newList(0);

  // Pretend our own gossip loop stalled for an hour. Declaring ourselves dead
  // would help nobody, and our own heartbeat is not news we receive.
  const transitions = sweep({ members, now: 3_600_000, thresholds: THRESHOLDS });

  assert.deepEqual(transitions, []);
  assert.equal(members.self.localStatus, LOCAL_STATUS.ALIVE);
  assert.equal(members.size, 1);
});

test("sweep: a member that left is buried without ever being called dead", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0, status: STATUS.LEFT });
  const seen = [];

  for (const now of [1000, 6001, 16_001, 60_001]) {
    for (const t of sweep({ members, now, thresholds: THRESHOLDS })) seen.push(t.to);
  }

  assert.deepEqual(seen, [BURIED], "left -> buried, with no dead in between");
  assert.equal(members.size, 1);
});

// --- the zombie problem ----------------------------------------------------

test("sweep + merge: stale gossip cannot resurrect a buried member", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0, heartbeat: 7 });

  // Bury it.
  sweep({ members, now: 75_001, thresholds: THRESHOLDS });
  assert.equal(members.size, 1);

  // Some peer was holding an old copy and gossips it back at us. Without the
  // graveyard we would have no record of this id and would happily accept it
  // as a brand new member: a zombie.
  const resurrected = members.merge(
    { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 9999 },
    76_000,
  );

  assert.equal(resurrected, false);
  assert.equal(members.size, 1);
});

test("sweep + merge: a genuinely restarted member is let back in", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0, heartbeat: 7 });
  sweep({ members, now: 75_001, thresholds: THRESHOLDS });

  // Same id, HIGHER generation: this is a new process, not an echo.
  const readmitted = members.merge(
    { id: "node-3002", address: "localhost:3002", generation: 2, heartbeat: 0 },
    76_000,
  );

  assert.equal(readmitted, true);
  assert.equal(members.get("node-3002").generation, 2);
  assert.deepEqual(members.graves(), [], "the gravestone is cleared on readmission");
});

test("sweep: gravestones are forgotten once no stale gossip can exist", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0 });

  sweep({ members, now: 75_001, thresholds: THRESHOLDS });
  assert.equal(members.graves().length, 1);

  // Not yet: within one cleanup window an old copy could still be in flight.
  sweep({ members, now: 130_000, thresholds: THRESHOLDS });
  assert.equal(members.graves().length, 1);

  // Past it, the stone is dropped so the graveyard cannot grow forever in a
  // cluster that scales up and down all day.
  sweep({ members, now: 135_002, thresholds: THRESHOLDS });
  assert.deepEqual(members.graves(), []);
});

// --- peer selection interaction -------------------------------------------

test("sweep: dead members stop being gossiped at, suspect ones do not", () => {
  const members = newList(0);
  for (const port of [3002, 3003]) {
    members.merge(
      { id: `node-${port}`, address: `localhost:${port}`, generation: 1, heartbeat: 1 },
      0,
    );
  }
  // Both go quiet long enough to look suspect...
  sweep({ members, now: 6001, thresholds: THRESHOLDS });
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.SUSPECT);
  assert.equal(members.get("node-3003").localStatus, LOCAL_STATUS.SUSPECT);
  assert.deepEqual(
    members.randomPeers(5).map((p) => p.id).sort(),
    ["node-3002", "node-3003"],
    "suspect peers must still be asked - that is how suspicion gets cleared",
  );

  // ...then node-3003 answers, while node-3002 stays silent past DEAD_MS.
  members.merge(
    { id: "node-3003", address: "localhost:3003", generation: 1, heartbeat: 2 },
    6500,
  );

  sweep({ members, now: 16_001, thresholds: THRESHOLDS });
  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.DEAD);
  assert.equal(members.get("node-3003").localStatus, LOCAL_STATUS.SUSPECT);

  // Only the dead one drops out of peer selection. The suspect one is still
  // worth a round: that is how it gets a chance to prove itself.
  assert.deepEqual(members.randomPeers(5).map((p) => p.id), ["node-3003"]);
});

// --- graceful leave on the owner's side -----------------------------------

test("markSelfLeft: bumps the heartbeat, because status alone is not news", () => {
  const members = newList(0);
  members.beat(1000);
  const before = members.self;

  const self = members.markSelfLeft(2000);

  assert.equal(self.status, STATUS.LEFT);
  assert.equal(self.localStatus, LOCAL_STATUS.LEFT);
  assert.equal(
    self.heartbeat,
    before.heartbeat + 1,
    "without a newer version, peers would compare equal versions and ignore the news",
  );
  assert.equal(self.generation, before.generation, "leaving is not a new incarnation");
});

test("merge: a peer's 'left' is adopted as our local opinion immediately", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0, heartbeat: 1 });

  members.merge(
    {
      id: "node-3002",
      address: "localhost:3002",
      generation: 1,
      heartbeat: 2,
      status: STATUS.LEFT,
    },
    1000,
  );

  assert.equal(members.get("node-3002").localStatus, LOCAL_STATUS.LEFT);
});

// --- the timer wrapper ------------------------------------------------------

test("FailureDetector: ticks on its own clock and logs each transition", () => {
  const members = withPeer(newList(0), { lastSeenAt: 0 });
  const logged = [];
  const logger = {
    info: (obj, msg) => logged.push({ obj, msg }),
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  let fakeNow = 1000;
  const detector = new FailureDetector({
    config: { suspectMs: 5000, deadMs: 15_000, cleanupMs: 60_000, gossipIntervalMs: 1000 },
    members,
    logger,
    now: () => fakeNow,
  });

  assert.deepEqual(detector.tick(), []);

  fakeNow = 6001;
  const transitions = detector.tick();
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].to, LOCAL_STATUS.SUSPECT);
  assert.equal(logged.at(-1).msg, "member status changed");
  assert.equal(logged.at(-1).obj.member, "node-3002");

  // start()/stop() only manage the interval; no timer is left behind.
  assert.equal(detector.running, false);
  detector.start();
  assert.equal(detector.running, true);
  detector.stop();
  assert.equal(detector.running, false);
});
