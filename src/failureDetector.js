/**
 * Failure detection: deciding, locally and alone, that a member has stopped.
 *
 * The whole mechanism rests on one number per member: `lastSeenAt`, the
 * monotonic clock reading from the moment that member's version last grew.
 * Nothing else is consulted - not a ping, not another node's opinion.
 *
 *     silence = now - lastSeenAt
 *
 *     silence <= SUSPECT_MS ............... alive
 *     SUSPECT_MS < silence <= DEAD_MS ..... suspect   (reversible)
 *     silence > DEAD_MS ................... dead      (reversible, but we stop
 *                                                      gossiping at it)
 *     silence > DEAD_MS + CLEANUP_MS ...... buried    (dropped from the list,
 *                                                      generation remembered)
 *
 * Why two thresholds instead of one? A single dropped packet, a GC pause or a
 * slow round should not mean death. `suspect` is the cheap, reversible warning
 * the dashboard shows in amber while the cluster tries again; `dead` is the
 * conclusion. Any newer version from that member clears either state at once,
 * because merge() moves lastSeenAt forward again.
 *
 * Why is none of this gossiped? Because a timeout measures the PATH between
 * two nodes, not the member at the far end of it. If node A cannot reach B,
 * that may well be A's problem. Letting A broadcast "B is dead" would let one
 * bad link kill a healthy member cluster-wide. So every node decides for
 * itself and the opinions stay local - the same choice Cassandra makes, and
 * what makes the Phase 6 dashboard's N x N matrix interesting: rows disagree.
 *
 * Like membership.js, this file never reads a clock: `now` is a parameter, so
 * the tests drive a fake one and run in microseconds.
 */

import { LOCAL_STATUS, STATUS } from "./membership.js";
import { createNoopMetrics } from "./metrics.js";

/**
 * @typedef {object} Thresholds
 * @property {number} suspectMs
 * @property {number} deadMs
 * @property {number} cleanupMs
 */

/**
 * @typedef {object} Transition
 * @property {string} id
 * @property {string} from
 * @property {string} to      A LOCAL_STATUS value, or "buried".
 * @property {number} silenceMs
 */

/** Pseudo-status used in transition records when an entry is dropped. */
export const BURIED = "buried";

/**
 * What our opinion of this member should be, given how long it has been quiet.
 *
 * @param {import("./membership.js").MemberEntry} entry
 * @param {number} now Monotonic clock reading.
 * @param {Thresholds} thresholds
 * @returns {string} a LOCAL_STATUS value.
 */
export function classify(entry, now, thresholds) {
  // A member that announced its own exit is not a failure and must never be
  // reported as one, however long it has been quiet since - it is quiet
  // because we asked it to stop.
  if (entry.status === STATUS.LEFT) return LOCAL_STATUS.LEFT;

  const silenceMs = now - entry.lastSeenAt;

  if (silenceMs > thresholds.deadMs) return LOCAL_STATUS.DEAD;
  if (silenceMs > thresholds.suspectMs) return LOCAL_STATUS.SUSPECT;
  return LOCAL_STATUS.ALIVE;
}

/**
 * True once a tombstone has outlived any gossip that could still be carrying
 * this member's old entry.
 *
 * @param {import("./membership.js").MemberEntry} entry
 * @param {number} now
 * @param {Thresholds} thresholds
 * @returns {boolean}
 */
export function isReadyToBury(entry, now, thresholds) {
  const silenceMs = now - entry.lastSeenAt;

  // A member that left is dropped after CLEANUP_MS of its own: it told us it
  // was going, so there is nothing to wait for beyond letting the news spread.
  if (entry.status === STATUS.LEFT) return silenceMs > thresholds.cleanupMs;

  return silenceMs > thresholds.deadMs + thresholds.cleanupMs;
}

/**
 * One pass over the member list: update every opinion, bury what is overdue,
 * and forget gravestones that no longer protect anything.
 *
 * Pure with respect to time (nothing here reads a clock) and returns what it
 * changed, so the caller can log it and Phase 4 can count it as a metric.
 *
 * @param {object} options
 * @param {import("./membership.js").MemberList} options.members
 * @param {number} options.now
 * @param {Thresholds} options.thresholds
 * @returns {Transition[]}
 */
export function sweep({ members, now, thresholds }) {
  /** @type {Transition[]} */
  const transitions = [];

  for (const entry of members.snapshot()) {
    // Our own entry is ours to write. The gossip loop bumps it every round, so
    // a detector verdict on ourselves would be meaningless - and if the loop
    // ever stalls, declaring ourselves dead would help nobody.
    if (entry.id === members.selfId) continue;

    const silenceMs = now - entry.lastSeenAt;

    if (isReadyToBury(entry, now, thresholds)) {
      if (members.bury(entry.id, now)) {
        transitions.push({ id: entry.id, from: entry.localStatus, to: BURIED, silenceMs });
      }
      continue;
    }

    const verdict = classify(entry, now, thresholds);
    if (members.setLocalStatus(entry.id, verdict)) {
      transitions.push({ id: entry.id, from: entry.localStatus, to: verdict, silenceMs });
    }
  }

  // A gravestone only has to outlive gossip that still carries the dead
  // member's entry. Every other node drops that member on the same schedule,
  // so after a second cleanup window no such gossip can exist and the stone
  // can go - otherwise the graveyard would grow forever in a cluster that
  // scales up and down repeatedly.
  for (const grave of members.graves()) {
    if (now - grave.buriedAt > thresholds.cleanupMs) members.forgetGrave(grave.id);
  }

  return transitions;
}

/**
 * The timer around sweep().
 *
 * It runs on its own interval rather than at the end of each gossip round: if
 * the gossip loop stalls, detection must still happen - that stall is exactly
 * when members go quiet.
 */
export class FailureDetector {
  #members;
  #logger;
  #metrics;
  #thresholds;
  #intervalMs;
  #now;

  /** @type {NodeJS.Timeout | null} */
  #timer = null;

  /**
   * @param {object} deps
   * @param {import("./config.js").Config} deps.config
   * @param {import("./membership.js").MemberList} deps.members
   * @param {import("pino").Logger} deps.logger
   * @param {() => number} deps.now Monotonic clock, e.g. performance.now.
   * @param {import("./metrics.js").Metrics} [deps.metrics]
   */
  constructor({ config, members, logger, now, metrics = createNoopMetrics() }) {
    this.#members = members;
    this.#logger = logger;
    this.#metrics = metrics;
    this.#thresholds = {
      suspectMs: config.suspectMs,
      deadMs: config.deadMs,
      cleanupMs: config.cleanupMs,
    };
    // Checking once per gossip round is enough resolution: nothing can change
    // faster than news arrives.
    this.#intervalMs = config.gossipIntervalMs;
    this.#now = now;
  }

  get running() {
    return this.#timer !== null;
  }

  /** @returns {Transition[]} what this pass changed. */
  tick() {
    const transitions = sweep({
      members: this.#members,
      now: this.#now(),
      thresholds: this.#thresholds,
    });

    this.#metrics.statusChanged(transitions);

    for (const transition of transitions) {
      // Status changes are the interesting events in the whole system, so they
      // are logged at info: this is what you read during the demo.
      this.#logger.info(
        {
          member: transition.id,
          from: transition.from,
          to: transition.to,
          silenceMs: Math.round(transition.silenceMs),
        },
        "member status changed",
      );
    }
    return transitions;
  }

  start() {
    if (this.#timer) return;

    this.#timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        // Detection must never be the thing that kills the node.
        this.#logger.error({ err: err.message }, "failure detector tick threw");
      }
    }, this.#intervalMs);

    this.#logger.info({ ...this.#thresholds }, "failure detector started");
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#logger.info("failure detector stopped");
  }
}
