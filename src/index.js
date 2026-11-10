/**
 * Entry point: wire the pieces together, start listening, and shut down
 * politely.
 *
 * This file is the only place allowed to touch process.env, create the real
 * clocks, open a socket or install signal handlers. Everything else receives
 * what it needs as an argument, which is why the rest of src/ is testable
 * without a network.
 *
 * Replaces legacy/index.js:89-91 (app.listen) plus all of its top-level setup.
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Chaos, createNoopChaos } from "./chaos.js";
import { loadConfig, ConfigError } from "./config.js";
import { SeedSource } from "./discovery.js";
import { createLogger } from "./logger.js";
import { FailureDetector } from "./failureDetector.js";
import { Gossiper } from "./gossiper.js";
import { MemberList } from "./membership.js";
import { Metrics } from "./metrics.js";
import { RumorStore } from "./rumors.js";
import { createServer } from "./server.js";

/**
 * Monotonic clock, for every "how long has this been quiet?" question.
 *
 * Date.now() is the wrong tool for measuring elapsed time: NTP corrections, a
 * resuming VM or a daylight-saving jump can move it backwards, and a single
 * backwards jump would make a member look silent for hours and get it declared
 * dead. performance.now() only ever counts forward from process start.
 *
 * The wall clock is still used for `generation`, where the requirement is the
 * opposite: a value that keeps growing ACROSS restarts, which a per-process
 * monotonic counter cannot give.
 */
const monotonicNow = () => performance.now();

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{
 *   config: import("./config.js").Config,
 *   logger: import("pino").Logger,
 *   members: MemberList,
 *   rumors: RumorStore,
 *   metrics: Metrics,
 *   chaos: import("./chaos.js").Chaos,
 *   gossiper: Gossiper,
 *   detector: FailureDetector,
 *   server: import("node:http").Server,
 *   shutdown: (reason?: string) => Promise<void>,
 * }}
 */
export function startNode(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ nodeId: config.nodeId, logLevel: config.logLevel });

  const members = new MemberList({
    selfId: config.nodeId,
    selfAddress: config.address,
    // Incarnation number for this process. Peers use it to tell "the node I
    // knew, still running" apart from "the node I knew, restarted".
    generation: config.generation,
    metadata: { version: config.appVersion, startedAt: new Date().toISOString() },
    now: monotonicNow(),
  });

  const rumors = new RumorStore({
    selfId: config.nodeId,
    rumorRounds: config.rumorRounds,
    maxRumors: config.maxRumors,
  });

  // One registry per node, not prom-client's global default one: five nodes in
  // one process (the integration test) would otherwise collide on metric names
  // and mix their numbers together.
  const metrics = new Metrics({ nodeId: config.nodeId });

  // Fault injection exists only when asked for. The no-op keeps the gossiper
  // and the routes free of "if chaos enabled" branches.
  const chaos = config.chaosEnabled ? new Chaos({ members, logger }) : createNoopChaos();

  const seedSource = new SeedSource({ config, logger, now: monotonicNow });

  const gossiper = new Gossiper({
    config, members, rumors, logger, metrics, chaos, seedSource, now: monotonicNow,
  });
  const detector = new FailureDetector({
    config, members, logger, metrics, now: monotonicNow,
  });
  const app = createServer({
    config, members, rumors, logger, metrics, chaos, gossiper, now: monotonicNow,
  });

  const server = app.listen(config.port, () => {
    logger.info(
      {
        address: config.address,
        generation: config.generation,
        seeds: config.seeds,
        seedDns: config.seedDns,
        fanout: config.fanout,
      },
      "gossip node listening",
    );
    // The loops start only once the port is open, so a peer that answers our
    // very first round can reach us straight back.
    gossiper.start();
    detector.start();
  });

  let shuttingDown = false;

  /**
   * Graceful leave.
   *
   * The order matters: announce first, tell somebody, only then stop. If we
   * exited first, peers would see nothing but silence and would (correctly)
   * report a failure - which is exactly the distinction this project is about.
   *
   * @param {string} [reason]
   */
  async function shutdown(reason = "shutdown") {
    // A second SIGTERM (or SIGINT after SIGTERM) must not restart the sequence.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ reason }, "graceful leave starting");

    // 1. Mark ourselves left and bump the heartbeat, so this is a NEWER
    //    version and peers will actually accept it.
    const self = members.markSelfLeft(monotonicNow());

    // 2. Stop the timers, so no further rounds or verdicts start behind the
    //    farewell we are about to send. (The farewell round below is called
    //    directly, not by the timer.)
    gossiper.stop();
    detector.stop();

    // 3. One last round carrying the news. Capped, because Kubernetes will
    //    SIGKILL us when terminationGracePeriodSeconds runs out, and a half
    //    sent goodbye is better than being killed mid-sentence.
    try {
      await Promise.race([
        gossiper.round(),
        new Promise((resolve) => setTimeout(resolve, config.shutdownTimeoutMs)),
      ]);
      logger.info({ heartbeat: self.heartbeat }, "left announced to peers");
    } catch (err) {
      logger.warn({ err: err.message }, "farewell round failed");
    }

    // 4. Close the socket. Peers that are mid-request get a clean answer
    //    rather than a reset connection.
    await new Promise((resolve) => server.close(resolve));
    logger.info("graceful leave complete");
  }

  return { config, logger, members, rumors, metrics, chaos, gossiper, detector, server, shutdown };
}

// Only run when executed directly (`node src/index.js`), not when imported by
// a test. import.meta.main is Node 24+, so compare resolved file URLs instead.
// pathToFileURL handles Windows drive letters and spaces correctly; hand-built
// "file://" + path strings do not.
const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  try {
    const node = startNode();

    // SIGTERM is what Kubernetes and `docker stop` send; SIGINT is Ctrl+C.
    // Both mean "please stop", so both get the same farewell.
    //
    // Honest caveat: on Windows these are not real POSIX signals. Node
    // emulates SIGINT for Ctrl+C, but a SIGTERM from another process
    // terminates this one outright and this handler never runs. The graceful
    // path therefore has to be demonstrated on Linux (WSL, Docker, kind).
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.on(signal, () => {
        node.shutdown(signal)
          .then(() => process.exit(0))
          .catch((err) => {
            node.logger.error({ err: err.message }, "graceful leave failed");
            process.exit(1);
          });
      });
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      // Config problems are the user's, not a crash: print them plainly
      // instead of a stack trace, then exit non-zero so Docker and Kubernetes
      // see the failure.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
