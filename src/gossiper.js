/**
 * Gossiper: the round loop. Once per GOSSIP_INTERVAL_MS it picks k peers,
 * pushes its whole member list plus any active rumors to each, and merges
 * whatever comes back.
 *
 * This is legacy/index.js:37-66 (gossipRound + setInterval), with four
 * changes:
 *
 *  1. Push-pull of the *whole state*. The tutorial pushed only `{hostname,
 *     port}` and learned other members from the reply, so news travelled in
 *     one direction and slowly. Sending everything both ways is what makes the
 *     cluster converge in roughly O(log N) rounds.
 *  2. Peers are contacted in parallel. With a 1 s round and fanout 3, three
 *     sequential awaits could outlast the interval and make rounds pile up.
 *  3. Rumors ride along on the same rounds. Broadcast then needs no
 *     connections, no topic list and no broker of its own - which is the whole
 *     point of building it on gossip.
 *  4. Clocks, HTTP, metrics and fault injection are injected, so a test can
 *     run a round with a fake clock and a fake client - no sockets, no waiting.
 */

import axios from "axios";

import { createNoopChaos } from "./chaos.js";
import { selectTargets } from "./discovery.js";
import { createNoopMetrics } from "./metrics.js";

export class Gossiper {
  #config;
  #members;
  #rumors;
  #logger;
  #metrics;
  #chaos;
  #http;
  #now;
  #wallNow;
  #seedSource;

  /** @type {NodeJS.Timeout | null} */
  #timer = null;
  #roundsRun = 0;
  #successfulExchanges = 0;

  /**
   * @param {object} deps
   * @param {import("./config.js").Config} deps.config
   * @param {import("./membership.js").MemberList} deps.members
   * @param {import("./rumors.js").RumorStore} deps.rumors
   * @param {import("pino").Logger} deps.logger
   * @param {() => number} deps.now  Monotonic clock. Required on purpose: a
   *   wall-clock default here would quietly break the invariant that
   *   lastSeenAt is monotonic, and nothing would fail loudly.
   * @param {() => number} [deps.wallNow]  Wall clock, for rumor timestamps.
   * @param {import("./metrics.js").Metrics} [deps.metrics]
   * @param {import("./chaos.js").Chaos} [deps.chaos]
   * @param {{addresses: () => Promise<string[]>}} [deps.seedSource] Where the
   *   bootstrap list comes from; DNS-backed in Kubernetes.
   * @param {{post: Function}} [deps.http]  Defaults to axios.
   */
  constructor({
    config,
    members,
    rumors,
    logger,
    now,
    wallNow = Date.now,
    metrics = createNoopMetrics(),
    chaos = createNoopChaos(),
    seedSource = null,
    http = axios,
  }) {
    this.#config = config;
    this.#members = members;
    this.#rumors = rumors;
    this.#logger = logger;
    this.#metrics = metrics;
    this.#chaos = chaos;
    this.#http = http;
    // From Phase 2 the clock no longer decides who is newer - (generation,
    // heartbeat) does. `now` is only used for the LOCAL lastSeenAt field, so a
    // skewed clock can no longer make another node's news look stale.
    this.#now = now;
    // Rumor timestamps are for humans and the dashboard, so they are wall
    // clock on purpose - and therefore not a benchmark (see rumors.js).
    this.#wallNow = wallNow;
    // Without a source, the fixed SEEDS list is the whole story.
    this.#seedSource = seedSource ?? { addresses: async () => config.seeds };
  }

  get roundsRun() {
    return this.#roundsRun;
  }

  /**
   * Successful exchanges since start. Readiness is derived from this: a node
   * that has never completed an exchange has not actually joined anything yet.
   */
  get successfulExchanges() {
    return this.#successfulExchanges;
  }

  get running() {
    return this.#timer !== null;
  }

  /**
   * One gossip round. Never throws: a round that fails must not kill the node.
   *
   * @returns {Promise<{targets: number, merged: number, learned: number, failed: number, frozen?: boolean}>}
   */
  async round() {
    // A frozen node does not even bump its own heartbeat. That is the point:
    // to peers it becomes indistinguishable from a crashed process, which is
    // what makes it a useful fault to inject.
    if (this.#chaos.frozen) {
      this.#logger.debug("gossip round skipped: frozen");
      return { targets: 0, merged: 0, learned: 0, failed: 0, frozen: true };
    }

    this.#roundsRun += 1;
    this.#metrics.roundStarted();

    // Step 1: prove we are alive before anyone asks, by incrementing our own
    // heartbeat. Phase 1 wrote a wall-clock timestamp here; a counter needs no
    // agreement between machines about what time it is.
    const heartbeat = this.#members.beat(this.#now());

    const targets = selectTargets({
      members: this.#members,
      // Resolved per round (cached inside the source), so a pod that appeared
      // a second ago is already a candidate.
      seeds: await this.#seedSource.addresses(),
      fanout: this.#config.fanout,
    }).filter((target) => {
      if (!this.#chaos.isBlocked(target)) return true;
      this.#metrics.exchangeFinished("blocked");
      return false;
    });

    if (targets.length === 0) {
      this.#logger.debug({ round: this.#roundsRun }, "no reachable peers or seeds this round");
      this.#rumors.afterRound();
      return { targets: 0, merged: 0, learned: 0, failed: 0 };
    }

    // Step 2: the push half. One payload, built once, sent to every target.
    const payload = {
      from: { id: this.#members.selfId, address: this.#members.selfAddress },
      members: this.#members.toWire(),
      rumors: this.#rumors.forwardable(),
    };

    const results = await Promise.allSettled(
      targets.map((target) => this.#exchange(target, payload)),
    );

    // Step 3: the pull half. Merge every reply we got.
    let merged = 0;
    let learned = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        merged += result.value.merged;
        learned += result.value.learned;
      } else {
        failed += 1;
      }
    }

    // Step 4: every rumor we are spreading moves one round closer to silence.
    // Once per round, not once per peer - otherwise fanout would decide how
    // long a rumor lives.
    const activeRumors = this.#rumors.afterRound();

    this.#logger.debug(
      {
        round: this.#roundsRun,
        heartbeat,
        targets: targets.length,
        merged,
        learned,
        failed,
        size: this.#members.size,
        activeRumors,
      },
      "gossip round complete",
    );
    return { targets: targets.length, merged, learned, failed };
  }

  /**
   * Talk to one peer and merge its reply.
   *
   * @param {{id: string | null, address: string}} target
   * @param {object} payload
   * @returns {Promise<{merged: number, learned: number}>}
   */
  async #exchange(target, payload) {
    const startedAt = this.#now();

    try {
      const response = await this.#http.post(
        `http://${target.address}/gossip`,
        payload,
        { timeout: this.#config.requestTimeoutMs },
      );

      this.#successfulExchanges += 1;
      this.#metrics.exchangeFinished("ok", (this.#now() - startedAt) / 1000);

      const merged = this.#members.mergeAll(response?.data?.members ?? [], this.#now());
      this.#metrics.membersMerged(merged);

      const learned = this.#receiveRumors(response?.data?.rumors ?? []);

      return { merged, learned };
    } catch (err) {
      // A dead peer is normal, not exceptional: it is exactly what the failure
      // detector turns into a suspect/dead verdict. Log it and carry on.
      this.#metrics.exchangeFinished("failed");
      this.#logger.warn(
        { peer: target.address, err: err.code ?? err.message },
        "gossip exchange failed",
      );
      throw err; // counted as `failed` by round(); allSettled keeps it contained.
    }
  }

  /**
   * @param {Array<object>} incoming
   * @returns {number} rumors that were news to us.
   */
  #receiveRumors(incoming) {
    const wallNow = this.#wallNow();
    let learned = 0;

    for (const rumor of incoming) {
      if (!this.#rumors.receive(rumor, wallNow)) continue;

      learned += 1;
      const stored = this.#rumors.get(rumor.id);
      this.#metrics.rumorLearned(stored?.hops ?? 0);
      this.#logger.info(
        { rumor: rumor.id, origin: rumor.origin, hops: stored?.hops },
        "rumor learned",
      );
    }
    return learned;
  }

  /** Start the periodic loop. */
  start() {
    if (this.#timer) return;

    this.#timer = setInterval(() => {
      // round() already swallows per-peer errors; this catch is the last net so
      // an unexpected bug can never become an unhandled rejection that kills
      // the process.
      this.round().catch((err) => {
        this.#logger.error({ err: err.message }, "gossip round threw");
      });
    }, this.#config.gossipIntervalMs);

    this.#logger.info(
      { intervalMs: this.#config.gossipIntervalMs, fanout: this.#config.fanout },
      "gossip loop started",
    );
  }

  /** Stop the loop. Needed by tests and by the graceful shutdown. */
  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#logger.info("gossip loop stopped");
  }
}
