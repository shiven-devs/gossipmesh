/**
 * MemberList tests. Every one of them drives a FAKE clock: `now` is just a
 * number we choose. No timers, no waiting, no flakiness - the habit that makes
 * Phase 3's failure detector testable in milliseconds instead of 15 seconds.
 *
 * From Phase 2 the clock has nothing to do with who wins a merge: that is
 * decided purely by (generation, heartbeat).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MemberList, STATUS, compareVersions, isNewerVersion } from "../src/membership.js";

/** @returns {MemberList} a fresh list owned by node-3001, generation 100. */
function newList({ generation = 100, now = 1000 } = {}) {
  return new MemberList({
    selfId: "node-3001",
    selfAddress: "localhost:3001",
    generation,
    metadata: { version: "0.1.0" },
    now,
  });
}

/** A gossiped entry for node-3002. */
function peer({ generation = 1, heartbeat = 0, status = STATUS.ALIVE, address = "localhost:3002" } = {}) {
  return { id: "node-3002", address, generation, heartbeat, status, metadata: {} };
}

// --- version comparison -----------------------------------------------------

test("compareVersions: generation is compared before heartbeat", () => {
  // Same generation: heartbeat decides.
  assert.equal(compareVersions({ generation: 5, heartbeat: 2 }, { generation: 5, heartbeat: 1 }), 1);
  assert.equal(compareVersions({ generation: 5, heartbeat: 1 }, { generation: 5, heartbeat: 2 }), -1);
  assert.equal(compareVersions({ generation: 5, heartbeat: 1 }, { generation: 5, heartbeat: 1 }), 0);

  // Different generation: heartbeat is irrelevant, however large.
  assert.equal(compareVersions({ generation: 6, heartbeat: 0 }, { generation: 5, heartbeat: 999 }), 1);
  assert.equal(compareVersions({ generation: 5, heartbeat: 999 }, { generation: 6, heartbeat: 0 }), -1);
});

test("isNewerVersion: equal is not newer", () => {
  const v = { generation: 2, heartbeat: 7 };
  assert.equal(isNewerVersion({ ...v }, v), false);
  assert.equal(isNewerVersion({ generation: 2, heartbeat: 8 }, v), true);
  assert.equal(isNewerVersion({ generation: 1, heartbeat: 99 }, v), false);
});

// --- self entry -------------------------------------------------------------

test("membership: starts out knowing only itself, heartbeat 0, alive", () => {
  const members = newList({ generation: 100, now: 1000 });

  assert.equal(members.size, 1);
  const self = members.self;
  assert.equal(self.id, "node-3001");
  assert.equal(self.generation, 100);
  assert.equal(self.heartbeat, 0);
  assert.equal(self.status, STATUS.ALIVE);
  assert.equal(self.lastSeenAt, 1000);
  assert.deepEqual(members.randomPeers(3), []);
});

test("membership: beat() increments only our own heartbeat", () => {
  const members = newList({ generation: 100 });
  members.merge(peer({ generation: 1, heartbeat: 5 }), 1000);

  assert.equal(members.beat(2000), 1);
  assert.equal(members.beat(3000), 2);

  assert.equal(members.self.heartbeat, 2);
  assert.equal(members.self.generation, 100, "beat must never touch generation");
  assert.equal(members.self.lastSeenAt, 3000);
  assert.equal(members.get("node-3002").heartbeat, 5, "a peer's heartbeat is not ours to move");
});

// --- merge rules ------------------------------------------------------------

test("membership: learns a new member from gossip", () => {
  const members = newList();

  const changed = members.merge(peer({ generation: 7, heartbeat: 3 }), 2000);

  assert.equal(changed, true);
  assert.equal(members.size, 2);
  const entry = members.get("node-3002");
  assert.equal(entry.generation, 7);
  assert.equal(entry.heartbeat, 3);
  // lastSeenAt is OUR clock reading, not theirs.
  assert.equal(entry.lastSeenAt, 2000);
});

test("membership: a higher heartbeat in the same generation wins", () => {
  const members = newList();
  members.merge(peer({ generation: 1, heartbeat: 10 }), 5000);

  assert.equal(members.merge(peer({ generation: 1, heartbeat: 11 }), 6000), true);
  assert.equal(members.get("node-3002").heartbeat, 11);
  assert.equal(members.get("node-3002").lastSeenAt, 6000);
});

test("membership: stale and identical news is ignored, and does not move lastSeenAt", () => {
  const members = newList();
  members.merge(peer({ generation: 2, heartbeat: 10 }), 5000);

  // Out-of-order delivery: an older heartbeat arriving late must not win.
  assert.equal(members.merge(peer({ generation: 2, heartbeat: 9 }), 6000), false);
  // An older generation loses even with a huge heartbeat.
  assert.equal(members.merge(peer({ generation: 1, heartbeat: 99999 }), 6000), false);
  // The exact same version again carries no news at all.
  assert.equal(members.merge(peer({ generation: 2, heartbeat: 10 }), 7000), false);

  const entry = members.get("node-3002");
  assert.equal(entry.generation, 2);
  assert.equal(entry.heartbeat, 10);
  // Nothing was proven, so our "last time this member moved" must not advance.
  // Phase 3's failure detector reads exactly this field.
  assert.equal(entry.lastSeenAt, 5000);
});

test("membership: a restarted node rejoins - new generation beats heartbeat 999", () => {
  // The scenario generation exists for. node-3002 ran for a long time...
  const members = newList();
  assert.equal(members.merge(peer({ generation: 1, heartbeat: 999 }), 5000), true);

  // ...then its process restarted: brand new generation, heartbeat back to 0.
  // Without generation this would look like 999 -> 0, i.e. ancient news, and
  // the restarted node could never rejoin the cluster.
  const changed = members.merge(peer({ generation: 2, heartbeat: 0 }), 9000);

  assert.equal(changed, true);
  const entry = members.get("node-3002");
  assert.equal(entry.generation, 2);
  assert.equal(entry.heartbeat, 0);
  assert.equal(entry.lastSeenAt, 9000);
});

test("membership: a lower generation is refused even after a restart claim", () => {
  // The flip side: an old copy of the node's entry still floating around the
  // cluster must not drag a freshly restarted member backwards.
  const members = newList();
  members.merge(peer({ generation: 5, heartbeat: 0 }), 5000);

  assert.equal(members.merge(peer({ generation: 4, heartbeat: 100 }), 6000), false);
  assert.equal(members.get("node-3002").generation, 5);
});

test("membership: the local clock has no vote - merges are decided by version alone", () => {
  // This is the whole point of Phase 2. In Phase 1 the gossiped field WAS a
  // wall-clock timestamp, so a node whose clock ran fast could make everyone
  // else's news look stale. Here the local clock jumps backwards by an hour
  // between merges and the outcome does not change at all.
  const members = newList();

  assert.equal(members.merge(peer({ generation: 1, heartbeat: 1 }), 5_000_000), true);

  // Clock jumps BACKWARDS (NTP correction, a container migrating, a VM
  // resuming). Newer news is still accepted...
  assert.equal(members.merge(peer({ generation: 1, heartbeat: 2 }), 1000), true);
  assert.equal(members.get("node-3002").heartbeat, 2);
  assert.equal(members.get("node-3002").lastSeenAt, 1000);

  // ...and older news is still rejected, however "recent" our clock says it is.
  assert.equal(members.merge(peer({ generation: 1, heartbeat: 1 }), 9_000_000), false);
  assert.equal(members.get("node-3002").heartbeat, 2);
});

test("membership: a newer version also carries address, status and metadata", () => {
  const members = newList();
  members.merge(peer({ generation: 1, heartbeat: 1 }), 1000);

  members.merge(
    {
      id: "node-3002",
      address: "localhost:4002",
      generation: 1,
      heartbeat: 2,
      status: STATUS.LEFT,
      metadata: { version: "0.2.0" },
    },
    2000,
  );

  const entry = members.get("node-3002");
  assert.equal(entry.address, "localhost:4002");
  assert.equal(entry.status, STATUS.LEFT);
  assert.equal(entry.metadata.version, "0.2.0");
});

test("membership: ignores what peers claim about us", () => {
  const members = newList({ generation: 100 });

  // Protocol invariant: only the owner writes its own fields. Our heartbeat is
  // always ahead of any copy travelling through the network.
  const changed = members.merge(
    {
      id: "node-3001",
      address: "evil:9999",
      generation: 999999,
      heartbeat: 999999,
      status: STATUS.LEFT,
    },
    2000,
  );

  assert.equal(changed, false);
  assert.equal(members.self.address, "localhost:3001");
  assert.equal(members.self.generation, 100);
  assert.equal(members.self.status, STATUS.ALIVE);
});

test("membership: malformed gossip is dropped, not crashed on", () => {
  const members = newList();
  const garbage = [
    null,
    undefined,
    "not an object",
    [],
    {},
    { id: "", address: "localhost:1", generation: 1, heartbeat: 1 },
    { id: "node-3002", address: "", generation: 1, heartbeat: 1 },
    // Counters must be non-negative integers. A NaN or a string would make
    // every later comparison false and freeze this member's entry forever.
    { id: "node-3002", address: "localhost:3002", generation: "soon", heartbeat: 1 },
    { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: NaN },
    { id: "node-3002", address: "localhost:3002", generation: 1.5, heartbeat: 1 },
    { id: "node-3002", address: "localhost:3002", generation: -1, heartbeat: 1 },
    { id: "node-3002", address: "localhost:3002", generation: 1 }, // no heartbeat
    // Unknown status is refused rather than guessed at.
    { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 1, status: "zombie" },
  ];

  for (const entry of garbage) {
    assert.equal(members.merge(entry, 2000), false, `accepted ${JSON.stringify(entry)}`);
  }
  assert.equal(members.size, 1);
});

test("membership: a missing status is read as alive", () => {
  const members = newList();

  assert.equal(
    members.merge({ id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 1 }, 2000),
    true,
  );
  assert.equal(members.get("node-3002").status, STATUS.ALIVE);
});

test("membership: mergeAll counts only the entries that changed our view", () => {
  const members = newList();

  const changed = members.mergeAll(
    [
      { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 1 },
      { id: "node-3003", address: "localhost:3003", generation: 1, heartbeat: 1 },
      { id: "node-3001", address: "localhost:3001", generation: 9, heartbeat: 9 }, // us
      "garbage",
    ],
    5000,
  );
  assert.equal(changed, 2);
  assert.equal(members.size, 3);

  // The same list again: no new versions, so nothing changed.
  assert.equal(
    members.mergeAll(
      [
        { id: "node-3002", address: "localhost:3002", generation: 1, heartbeat: 1 },
        { id: "node-3003", address: "localhost:3003", generation: 1, heartbeat: 1 },
      ],
      6000,
    ),
    0,
  );

  assert.equal(members.mergeAll(undefined, 7000), 0);
  assert.equal(members.mergeAll(42, 7000), 0);
});

// --- what goes on the wire --------------------------------------------------

test("membership: toWire sends the version and status, never local fields", () => {
  const members = newList();
  members.merge(peer({ generation: 1, heartbeat: 1 }), 2000);

  for (const entry of members.toWire()) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["address", "generation", "heartbeat", "id", "metadata", "status"],
    );
    assert.equal("lastSeenAt" in entry, false, "lastSeenAt must never be gossiped");
  }
  // snapshot(), the local view, still has it.
  assert.ok("lastSeenAt" in members.snapshot()[0]);
});

test("membership: snapshot hands out copies, not internal objects", () => {
  const members = newList({ generation: 100 });

  const snapshot = members.snapshot();
  snapshot[0].heartbeat = 123456;
  snapshot[0].address = "tampered";

  assert.equal(members.self.heartbeat, 0);
  assert.equal(members.self.address, "localhost:3001");
});

// --- peer selection ---------------------------------------------------------

test("membership: randomPeers excludes self, skips 'left' members, never repeats", () => {
  const members = newList();
  for (let port = 3002; port <= 3006; port += 1) {
    members.merge(
      { id: `node-${port}`, address: `localhost:${port}`, generation: 1, heartbeat: 1 },
      2000,
    );
  }
  // node-3006 announced it is shutting down.
  members.merge(
    {
      id: "node-3006",
      address: "localhost:3006",
      generation: 1,
      heartbeat: 2,
      status: STATUS.LEFT,
    },
    3000,
  );

  // Shuffles are random, so one pass proves little - run it many times.
  for (let i = 0; i < 200; i += 1) {
    const ids = members.randomPeers(3).map((p) => p.id);

    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, "a peer was returned twice");
    assert.equal(ids.includes("node-3001"), false, "self was returned as a peer");
    assert.equal(ids.includes("node-3006"), false, "a member that left was gossiped at");
  }

  // Asking for more peers than exist returns everyone reachable, not padding.
  assert.equal(members.randomPeers(99).length, 4);
  assert.deepEqual(members.randomPeers(0), []);
});

test("membership: two lists in one process stay independent", () => {
  // The whole reason MemberList is a class: legacy/state.js kept one shared
  // module-level Map, so five nodes could never run inside one test process.
  const a = new MemberList({ selfId: "a", selfAddress: "localhost:1", generation: 1, now: 1000 });
  const b = new MemberList({ selfId: "b", selfAddress: "localhost:2", generation: 1, now: 1000 });

  a.merge({ id: "c", address: "localhost:3", generation: 1, heartbeat: 1 }, 1000);

  assert.equal(a.size, 2);
  assert.equal(b.size, 1);
});
