/**
 * Config: every tunable value comes from environment variables, is parsed
 * once here, and is validated before the node is allowed to start.
 *
 * Replaces legacy/config.json + the constants at the top of legacy/index.js.
 * `env` is a parameter (not a direct read of process.env) so tests can pass a
 * fake environment without mutating the real one.
 */

/** Thrown when the environment is unusable. Carries every problem at once. */
export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * @typedef {object} Config
 * @property {string} nodeId         Stable name for this node, e.g. "node-3001".
 * @property {string} host           Hostname other nodes should use to reach us.
 * @property {number} port           HTTP port to listen on.
 * @property {string} address        `host:port`, how we advertise ourselves.
 * @property {number} gossipIntervalMs  Gap between gossip rounds.
 * @property {number} fanout         How many peers per round (the "k" in gossip).
 * @property {number} requestTimeoutMs  Per-request timeout for outgoing gossip.
 * @property {string[]} seeds        Bootstrap peer addresses (never includes self).
 * @property {string|null} seedDns   DNS name whose A records are peers.
 * @property {number} seedDnsTtlMs   How long a DNS answer is reused.
 * @property {string|null} podIp     Our own IP, so DNS seeds can exclude it.
 * @property {number} generation     Incarnation number for this process.
 * @property {string} appVersion     Reported in gossiped metadata.
 * @property {number} suspectMs      Silence after which a member looks suspect.
 * @property {number} deadMs         Silence after which a member is declared dead.
 * @property {number} cleanupMs      How long a dead/left tombstone is kept.
 * @property {number} shutdownTimeoutMs  Hard deadline for a graceful leave.
 * @property {number} rumorRounds    Rounds a rumor keeps being forwarded.
 * @property {number} maxRumors      Cap on remembered rumors.
 * @property {boolean} chaosEnabled  Whether the fault-injection routes exist.
 * @property {string} logLevel       pino level.
 */

/**
 * Read and validate configuration.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to process.env.
 * @returns {Config}
 * @throws {ConfigError} if anything is missing or out of range.
 */
export function loadConfig(env = process.env) {
  const problems = [];

  const port = parseIntegerEnv(env.PORT, "PORT", 3000, { min: 1, max: 65535 }, problems);
  const host = (env.HOST ?? "localhost").trim() || "localhost";

  // NODE_ID defaults to node-<port> so a local 5-node cluster gets readable,
  // distinct names with zero setup. In Kubernetes (Phase 7) it comes from the
  // Downward API as the pod name, e.g. "gossip-2".
  const nodeId = (env.NODE_ID ?? `node-${port}`).trim();
  if (!nodeId) problems.push("NODE_ID must not be empty");

  const gossipIntervalMs = parseIntegerEnv(
    env.GOSSIP_INTERVAL_MS, "GOSSIP_INTERVAL_MS", 1000, { min: 50 }, problems,
  );
  const fanout = parseIntegerEnv(env.FANOUT, "FANOUT", 3, { min: 1 }, problems);
  const requestTimeoutMs = parseIntegerEnv(
    env.REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT_MS", 500, { min: 50 }, problems,
  );

  // A request timeout longer than the round interval would let rounds pile up
  // on top of each other, so refuse that combination instead of debugging it
  // later under load.
  if (requestTimeoutMs > gossipIntervalMs) {
    problems.push(
      `REQUEST_TIMEOUT_MS (${requestTimeoutMs}) must be <= GOSSIP_INTERVAL_MS ` +
        `(${gossipIntervalMs}), otherwise gossip rounds overlap`,
    );
  }

  const address = `${host}:${port}`;
  const seeds = parseSeedList(env.SEEDS, address, problems);

  // SEED_DNS is the Kubernetes path: a headless Service's name resolves to one
  // A record per pod, so the seed list is whatever is running right now rather
  // than a list fixed at deploy time. That is what lets a pod created by
  // scaling up find the cluster, and lets the cluster survive its two named
  // seeds being the ones that died.
  const seedDns = (env.SEED_DNS ?? "").trim() || null;

  // DNS is cached for a moment rather than resolved every round: CoreDNS would
  // otherwise get FANOUT lookups per node per second, and pod membership does
  // not change that fast.
  const seedDnsTtlMs = parseIntegerEnv(
    env.SEED_DNS_TTL_MS, "SEED_DNS_TTL_MS", 5000, { min: 100 }, problems,
  );

  // From the Downward API (status.podIP). A headless Service resolves to pod
  // IPs including our own, and without this we would gossip at ourselves every
  // round and log a 400 each time.
  const podIp = (env.POD_IP ?? "").trim() || null;

  // generation = this process's incarnation number. The only requirement is
  // that it is LARGER after every restart, because a restarted node starts its
  // heartbeat at 0 again and needs something that still beats the old entry.
  //
  // Date.now() satisfies that for free and needs no disk and no coordination.
  // Its honest weakness: if the clock jumps backwards across a restart, the
  // new generation can be lower and peers will ignore the node until their old
  // entry is cleaned up (Phase 3). Real systems persist a counter instead;
  // GENERATION lets tests and demos pin an exact value.
  const generation = parseIntegerEnv(
    env.GENERATION, "GENERATION", Date.now(), { min: 0 }, problems,
  );

  // Gossiped as metadata so the dashboard can show a rolling upgrade; the
  // Docker build (Phase 5) passes the real version in.
  const appVersion = (env.APP_VERSION ?? "0.1.0").trim() || "0.1.0";

  // Failure detection thresholds, all measured as "silence since this member's
  // version last grew". They are per-node local policy: nothing here is
  // gossiped, and two nodes may legitimately use different numbers.
  const suspectMs = parseIntegerEnv(env.SUSPECT_MS, "SUSPECT_MS", 5000, { min: 1 }, problems);
  const deadMs = parseIntegerEnv(env.DEAD_MS, "DEAD_MS", 15000, { min: 1 }, problems);
  const cleanupMs = parseIntegerEnv(env.CLEANUP_MS, "CLEANUP_MS", 60000, { min: 1 }, problems);

  // One missed round must not be enough to look suspect: a single dropped
  // packet or a slow GC pause would then flap the whole cluster.
  if (suspectMs <= gossipIntervalMs) {
    problems.push(
      `SUSPECT_MS (${suspectMs}) must be > GOSSIP_INTERVAL_MS (${gossipIntervalMs}), ` +
        "otherwise one missed round marks a healthy node suspect",
    );
  }
  if (deadMs <= suspectMs) {
    problems.push(`DEAD_MS (${deadMs}) must be > SUSPECT_MS (${suspectMs})`);
  }

  // A graceful leave has to finish inside the orchestrator's grace period:
  // Kubernetes sends SIGTERM, waits terminationGracePeriodSeconds, then SIGKILL.
  const shutdownTimeoutMs = parseIntegerEnv(
    env.SHUTDOWN_TIMEOUT_MS, "SHUTDOWN_TIMEOUT_MS", 3000, { min: 50 }, problems,
  );

  // How many rounds a node keeps passing a rumor on before going quiet about
  // it. This is the "epidemic" dial: too low and the last few nodes never hear
  // it, too high and the cluster keeps re-sending news everybody already has.
  const rumorRounds = parseIntegerEnv(env.RUMOR_ROUNDS, "RUMOR_ROUNDS", 10, { min: 1 }, problems);

  // Rumors are remembered after they stop spreading, so /rumors can show what
  // arrived and when. Bounded, because an unbounded store is a slow memory
  // leak in a process meant to run for days.
  const maxRumors = parseIntegerEnv(env.MAX_RUMORS, "MAX_RUMORS", 100, { min: 1 }, problems);

  // Fault injection is off unless asked for: /chaos/crash kills the process,
  // which is not something a production image should offer.
  const chaosEnabled = parseBooleanEnv(env.CHAOS_ENABLED, "CHAOS_ENABLED", false, problems);

  const logLevel = (env.LOG_LEVEL ?? "info").trim();
  const allowedLevels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
  if (!allowedLevels.includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${allowedLevels.join(", ")}, got "${logLevel}"`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    nodeId,
    host,
    port,
    address,
    gossipIntervalMs,
    fanout,
    requestTimeoutMs,
    seeds,
    seedDns,
    seedDnsTtlMs,
    podIp,
    generation,
    appVersion,
    suspectMs,
    deadMs,
    cleanupMs,
    shutdownTimeoutMs,
    rumorRounds,
    maxRumors,
    chaosEnabled,
    logLevel,
  });
}

/**
 * Parse one integer env var, collecting (not throwing) any problem so the
 * caller can report every mistake in a single error.
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @param {number} fallback
 * @param {{min?: number, max?: number}} bounds
 * @param {string[]} problems
 * @returns {number}
 */
function parseIntegerEnv(raw, name, fallback, bounds, problems) {
  if (raw === undefined || String(raw).trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(`${name} must be an integer, got "${raw}"`);
    return fallback;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    problems.push(`${name} must be >= ${bounds.min}, got ${value}`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    problems.push(`${name} must be <= ${bounds.max}, got ${value}`);
    return fallback;
  }
  return value;
}

/**
 * Parse a boolean env var. Only the obvious spellings are accepted: a typo
 * like CHAOS_ENABLED=yes should fail loudly, not silently leave chaos off (or
 * worse, silently turn it on in production).
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @param {boolean} fallback
 * @param {string[]} problems
 * @returns {boolean}
 */
function parseBooleanEnv(raw, name, fallback, problems) {
  if (raw === undefined || String(raw).trim() === "") return fallback;

  const value = String(raw).trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;

  problems.push(`${name} must be true or false, got "${raw}"`);
  return fallback;
}

/**
 * SEEDS is a comma-separated list of `host:port` addresses.
 *
 * @param {string | undefined} raw
 * @param {string} selfAddress
 * @param {string[]} problems
 * @returns {string[]}
 */
function parseSeedList(raw, selfAddress, problems) {
  if (!raw || raw.trim() === "") return [];

  const seeds = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (candidate === "") continue;

    if (!/^[A-Za-z0-9._-]+:\d+$/.test(candidate)) {
      problems.push(`SEEDS entry "${candidate}" is not in host:port form`);
      continue;
    }
    // Dropping ourselves here is what legacy/index.js:29 did with isMe(), and
    // de-duplicating keeps a copy-pasted SEEDS list harmless.
    if (candidate === selfAddress) continue;
    if (!seeds.includes(candidate)) seeds.push(candidate);
  }
  return seeds;
}
