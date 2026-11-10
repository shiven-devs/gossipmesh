import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, ConfigError } from "../src/config.js";

test("config: sensible defaults with only PORT set", () => {
  const config = loadConfig({ PORT: "3001" });

  assert.equal(config.port, 3001);
  assert.equal(config.host, "localhost");
  assert.equal(config.nodeId, "node-3001");
  assert.equal(config.address, "localhost:3001");
  assert.equal(config.gossipIntervalMs, 1000);
  assert.equal(config.fanout, 3);
  assert.deepEqual(config.seeds, []);
  assert.equal(config.appVersion, "0.1.0");
});

test("config: generation defaults to a fresh value per process, and is overridable", () => {
  // The only contract generation has to keep is "larger after every restart",
  // which Date.now() gives us without a disk or any coordination.
  const before = Date.now();
  const generation = loadConfig({ PORT: "3001" }).generation;
  const after = Date.now();

  assert.ok(Number.isInteger(generation));
  assert.ok(generation >= before && generation <= after, `${generation} not within [${before}, ${after}]`);

  // Tests and demos pin an exact incarnation instead.
  assert.equal(loadConfig({ PORT: "3001", GENERATION: "42" }).generation, 42);
});

test("config: env values override defaults", () => {
  const config = loadConfig({
    PORT: "3002",
    HOST: "node2",
    NODE_ID: "gossip-2",
    GOSSIP_INTERVAL_MS: "250",
    FANOUT: "1",
    REQUEST_TIMEOUT_MS: "100",
    GENERATION: "7",
    APP_VERSION: "1.2.3",
    LOG_LEVEL: "debug",
  });

  assert.equal(config.nodeId, "gossip-2");
  assert.equal(config.address, "node2:3002");
  assert.equal(config.gossipIntervalMs, 250);
  assert.equal(config.fanout, 1);
  assert.equal(config.generation, 7);
  assert.equal(config.appVersion, "1.2.3");
  assert.equal(config.logLevel, "debug");
});

test("config: SEEDS is split, trimmed, de-duplicated, and self is dropped", () => {
  const config = loadConfig({
    PORT: "3001",
    SEEDS: " localhost:3001 , localhost:3002,localhost:3002 ,,localhost:3003",
  });

  // localhost:3001 is us, so it must not appear.
  assert.deepEqual(config.seeds, ["localhost:3002", "localhost:3003"]);
});

test("config: reports every problem at once, not just the first", () => {
  // assert.throws() does not hand back the error, so catch it to inspect it.
  let err;
  try {
    loadConfig({ PORT: "99999", FANOUT: "abc", LOG_LEVEL: "loud", SEEDS: "nope" });
  } catch (caught) {
    err = caught;
  }

  assert.ok(err instanceof ConfigError, "expected a ConfigError");
  assert.equal(err.problems.length, 4);
  assert.match(err.message, /PORT must be <= 65535/);
  assert.match(err.message, /FANOUT must be an integer/);
  assert.match(err.message, /SEEDS entry "nope"/);
  assert.match(err.message, /LOG_LEVEL must be one of/);
});

test("config: refuses a request timeout longer than the gossip interval", () => {
  // Rounds would overlap, so this must fail at startup rather than under load.
  assert.throws(
    () => loadConfig({ PORT: "3001", GOSSIP_INTERVAL_MS: "200", REQUEST_TIMEOUT_MS: "500" }),
    /gossip rounds overlap/,
  );
});

test("config: the returned object is frozen", () => {
  const config = loadConfig({ PORT: "3001" });
  assert.throws(() => {
    config.fanout = 99;
  }, TypeError);
});
