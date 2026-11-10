/**
 * Phase 0 smoke test.
 *
 * Point of this file is not to test GossipMesh (there is no src/ code yet).
 * It proves two boring-but-essential things:
 *   1. the toolchain is wired up: `npm test` finds node:test, ES Modules load;
 *   2. the one rule we are about to rebuild - "newer news wins, older news is
 *      ignored" - really does hold in the tutorial code we are growing from.
 *
 * In Phase 2 that same rule becomes a (generation, heartbeat) comparison in
 * src/membership.js, and this test becomes its ancestor.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerFriend, getMyFriends } from "../legacy/state.js";

test("toolchain: running on Node 20+ with ES Modules", () => {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 20, `expected Node >= 20, got ${process.versions.node}`);

  // import.meta only exists inside a real ES Module, so this asserts
  // "type": "module" is actually taking effect.
  assert.ok(import.meta.url.endsWith("smoke.test.js"));
});

test("legacy membership: newer timestamp wins, older one is ignored", () => {
  const host = "localhost";
  const port = 3001;

  // First news about this friend.
  registerFriend(host, port, 1000);
  assert.equal(findFriend(host, port).lastPingTimestamp, 1000);

  // Stale news arrives late (out-of-order delivery). It must NOT overwrite.
  registerFriend(host, port, 500);
  assert.equal(findFriend(host, port).lastPingTimestamp, 1000);

  // Genuinely newer news wins.
  registerFriend(host, port, 2000);
  assert.equal(findFriend(host, port).lastPingTimestamp, 2000);

  // Equal timestamp is also ignored (state.js uses >=), so no needless churn.
  registerFriend(host, port, 2000);
  assert.equal(findFriend(host, port).lastPingTimestamp, 2000);
});

test("legacy membership: a second friend is tracked separately", () => {
  registerFriend("localhost", 3002, 1500);

  const addresses = getMyFriends().map((f) => f.address);
  assert.ok(addresses.includes("localhost:3001"));
  assert.ok(addresses.includes("localhost:3002"));
});

/** @returns {{address: string, lastPingTimestamp: number}} */
function findFriend(hostname, port) {
  const found = getMyFriends().find((f) => f.address === `${hostname}:${port}`);
  assert.ok(found, `friend ${hostname}:${port} not found in the list`);
  return found;
}
