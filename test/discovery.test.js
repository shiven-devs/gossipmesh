/**
 * Seed discovery tests. DNS is injected, so there is no resolver, no network
 * and no waiting - the same discipline as the injected clocks elsewhere.
 */

import test from "node:test";
import assert from "node:assert/strict";

import pino from "pino";

import { loadConfig } from "../src/config.js";
import { SeedSource, selectTargets } from "../src/discovery.js";
import { MemberList } from "../src/membership.js";

const logger = pino({ level: "silent" });

function newSource(env, resolve, now = () => 0) {
  const config = loadConfig({ PORT: "3000", HOST: "me", ...env });
  return { source: new SeedSource({ config, logger, resolve, now }), config };
}

test("seeds: with no SEED_DNS the fixed list is used verbatim", async () => {
  const { source } = newSource({ SEEDS: "a:3000,b:3000" }, async () => {
    throw new Error("DNS must not be consulted");
  });

  assert.deepEqual(await source.addresses(), ["a:3000", "b:3000"]);
});

test("seeds: SEED_DNS resolves to one address per pod", async () => {
  const { source } = newSource(
    { SEED_DNS: "gossip-headless.gossip.svc.cluster.local" },
    async () => ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
  );

  assert.deepEqual(await source.addresses(), ["10.0.0.1:3000", "10.0.0.2:3000", "10.0.0.3:3000"]);
});

test("seeds: our own pod IP is filtered out of the DNS answer", async () => {
  // A headless Service resolves to every pod including this one. Without this
  // filter the node would gossip at itself every round and log a 400 each time.
  const { source } = newSource(
    { SEED_DNS: "gossip-headless", POD_IP: "10.0.0.2" },
    async () => ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
  );

  assert.deepEqual(await source.addresses(), ["10.0.0.1:3000", "10.0.0.3:3000"]);
});

test("seeds: static seeds and DNS results are merged and de-duplicated", async () => {
  const { source } = newSource(
    { SEEDS: "10.0.0.1:3000,extra:3000", SEED_DNS: "gossip-headless" },
    async () => ["10.0.0.1", "10.0.0.9"],
  );

  assert.deepEqual(await source.addresses(), ["10.0.0.1:3000", "extra:3000", "10.0.0.9:3000"]);
});

test("seeds: DNS answers are cached for the TTL, then refreshed", async () => {
  let lookups = 0;
  let clock = 0;
  const { source } = newSource(
    { SEED_DNS: "gossip-headless", SEED_DNS_TTL_MS: "5000" },
    async () => {
      lookups += 1;
      return lookups === 1 ? ["10.0.0.1"] : ["10.0.0.1", "10.0.0.2"];
    },
    () => clock,
  );

  assert.deepEqual(await source.addresses(), ["10.0.0.1:3000"]);
  clock = 4999;
  await source.addresses();
  assert.equal(lookups, 1, "inside the TTL, DNS must not be asked again");

  // Otherwise every node would send FANOUT lookups per second at CoreDNS for
  // information that changes only when a pod comes or goes.
  clock = 5001;
  assert.deepEqual(await source.addresses(), ["10.0.0.1:3000", "10.0.0.2:3000"]);
  assert.equal(lookups, 2);
});

test("seeds: a DNS failure keeps the last answer and is never fatal", async () => {
  let fail = false;
  let clock = 0;
  const { source } = newSource(
    { SEEDS: "static:3000", SEED_DNS: "gossip-headless", SEED_DNS_TTL_MS: "1000" },
    async () => {
      if (fail) throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
      return ["10.0.0.1"];
    },
    () => clock,
  );

  assert.deepEqual(await source.addresses(), ["static:3000", "10.0.0.1:3000"]);

  fail = true;
  clock = 2000;
  // A node already in the cluster has peers and needs no seeds at all, so a
  // DNS outage must not stop it gossiping.
  assert.deepEqual(await source.addresses(), ["static:3000", "10.0.0.1:3000"]);
});

test("selectTargets: one written-off member is re-probed each round", () => {
  // Without this, a partition would be permanent: each side excludes the other
  // from peer selection, so nothing would ever contact them again to find out
  // that the network came back.
  const members = new MemberList({
    selfId: "me", selfAddress: "me:3000", generation: 1, now: 0,
  });
  for (const id of ["p1", "p2", "p3", "gone"]) {
    members.merge({ id, address: `${id}:3000`, generation: 1, heartbeat: 1 }, 0);
  }
  members.setLocalStatus("gone", "dead");

  const targets = selectTargets({ members, seeds: [], fanout: 3 });
  const addresses = targets.map((t) => t.address);

  // The three live peers still get their full fanout...
  assert.equal(addresses.filter((a) => a !== "gone:3000").length, 3);
  // ...and the dead member is probed in addition, not instead.
  assert.equal(addresses.includes("gone:3000"), true);
  assert.equal(targets.length, 4);
});

test("selectTargets: revive can be switched off", () => {
  const members = new MemberList({
    selfId: "me", selfAddress: "me:3000", generation: 1, now: 0,
  });
  members.merge({ id: "gone", address: "gone:3000", generation: 1, heartbeat: 1 }, 0);
  members.setLocalStatus("gone", "dead");

  assert.deepEqual(selectTargets({ members, seeds: [], fanout: 3, revive: 0 }), []);
});

test("selectTargets: the seed list is shuffled, not read in order", () => {
  // A DNS answer comes back sorted by pod IP. Always taking the first entries
  // would make one half of a partition keep probing its own half.
  const members = new MemberList({
    selfId: "me", selfAddress: "me:3000", generation: 1, now: 0,
  });
  const seeds = Array.from({ length: 8 }, (_, i) => `10.0.0.${i}:3000`);

  const firstPicks = new Set();
  for (let i = 0; i < 200; i += 1) {
    firstPicks.add(selectTargets({ members, seeds, fanout: 1 })[0].address);
  }
  assert.ok(firstPicks.size > 1, `always picked the same seed: ${[...firstPicks]}`);
});

test("selectTargets: seeds only top up what peers cannot fill", () => {
  const members = new MemberList({
    selfId: "me", selfAddress: "me:3000", generation: 1, now: 0,
  });
  // No peers yet: all three targets come from the seed list. Which three is
  // deliberately random, so assert the count and the set, not the order.
  const seeds = ["a:3000", "b:3000", "c:3000", "d:3000"];
  const picked = selectTargets({ members, seeds, fanout: 3 });
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((t) => t.address)).size, 3);
  assert.equal(picked.every((t) => seeds.includes(t.address) && t.id === null), true);

  for (const id of ["p1", "p2", "p3"]) {
    members.merge({ id, address: `${id}:3000`, generation: 1, heartbeat: 1 }, 0);
  }
  // Fanout filled by real peers: seeds are not needed, and their ids are known.
  const targets = selectTargets({ members, seeds: ["a:3000"], fanout: 3 });
  assert.equal(targets.length, 3);
  assert.equal(targets.every((t) => t.id !== null), true);
});
