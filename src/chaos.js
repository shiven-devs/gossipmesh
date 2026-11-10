/**
 * Chaos: breaking this node on purpose, so the failure detector can be watched
 * doing its job instead of being taken on trust.
 *
 * Only mounted when CHAOS_ENABLED=true. A production image must not ship an
 * endpoint that kills the process.
 *
 * Three faults, each a different shape of failure:
 *
 *   partition  Refuse to talk to named peers, in both directions. The nodes
 *              are all healthy and the network between them is not, which is
 *              the case a single "is it up?" check cannot distinguish - and
 *              the reason suspect/dead opinions are never gossiped.
 *   freeze     Stop gossiping while still answering HTTP. To peers this looks
 *              exactly like a crash (no heartbeat), but the process is there.
 *   crash      Exit immediately, with no goodbye. The SIGKILL case.
 *
 * On `freeze`: the plan called for hanging the node. A real event-loop block
 * would also stall /health, so Kubernetes' liveness probe would fail and the
 * pod would be restarted - killing the very demo it is meant to show. Freezing
 * the gossip loop produces the same silence for peers, while leaving the pod
 * alive to be thawed. A true hang can still be had with /chaos/crash.
 */

export class Chaos {
  /** @type {Set<string>} node ids we refuse to exchange gossip with. */
  #blocked = new Set();

  #frozen = false;
  /** @type {NodeJS.Timeout | null} */
  #thawTimer = null;

  #members;
  #logger;

  /**
   * @param {object} deps
   * @param {import("./membership.js").MemberList} deps.members
   * @param {import("pino").Logger} deps.logger
   */
  constructor({ members, logger }) {
    this.#members = members;
    this.#logger = logger;
  }

  get frozen() {
    return this.#frozen;
  }

  /** @returns {string[]} blocked node ids. */
  get blocked() {
    return [...this.#blocked];
  }

  /**
   * Cut this node off from the named peers.
   *
   * @param {string[]} ids
   * @returns {string[]} the ids now blocked.
   */
  partition(ids) {
    for (const id of ids) {
      if (typeof id === "string" && id.trim() !== "" && id !== this.#members.selfId) {
        this.#blocked.add(id);
      }
    }
    this.#logger.warn({ blocked: this.blocked }, "chaos: partition applied");
    return this.blocked;
  }

  /** Undo everything: reconnect and unfreeze. */
  heal() {
    const was = { blocked: this.blocked, frozen: this.#frozen };

    this.#blocked.clear();
    this.thaw();

    this.#logger.warn(was, "chaos: healed");
    return was;
  }

  /**
   * Stop gossiping for a while (or until thawed).
   *
   * @param {number} [durationMs] 0 or undefined means "until /chaos/heal".
   */
  freeze(durationMs) {
    this.#frozen = true;
    if (this.#thawTimer) clearTimeout(this.#thawTimer);
    this.#thawTimer = null;

    if (durationMs && durationMs > 0) {
      this.#thawTimer = setTimeout(() => this.thaw(), durationMs);
      // Do not let a pending thaw timer be the only thing keeping the process
      // alive during shutdown.
      this.#thawTimer.unref?.();
    }

    this.#logger.warn({ durationMs: durationMs ?? null }, "chaos: gossip frozen");
  }

  thaw() {
    if (this.#thawTimer) {
      clearTimeout(this.#thawTimer);
      this.#thawTimer = null;
    }
    if (!this.#frozen) return;

    this.#frozen = false;
    this.#logger.warn("chaos: gossip thawed");
  }

  /**
   * Is this peer on the far side of a partition?
   *
   * Checked by BOTH sides of an exchange - the gossiper before sending and the
   * server before accepting. A one-directional block would be a strange fault
   * that real networks rarely produce, and it would let news leak across the
   * partition and quietly spoil the demo.
   *
   * Seeds are matched by address too, because a seed we have never spoken to
   * has no id yet.
   *
   * @param {{id?: string | null, address?: string}} peer
   * @returns {boolean}
   */
  isBlocked({ id, address } = {}) {
    if (this.#blocked.size === 0) return false;
    if (id && this.#blocked.has(id)) return true;

    if (address) {
      for (const blockedId of this.#blocked) {
        if (this.#members.get(blockedId)?.address === address) return true;
      }
    }
    return false;
  }

  /** @returns {{frozen: boolean, blocked: string[]}} */
  state() {
    return { frozen: this.#frozen, blocked: this.blocked };
  }
}

/**
 * Chaos that never does anything, used when CHAOS_ENABLED is false so the
 * gossiper and server need no conditional logic.
 *
 * @returns {Chaos}
 */
export function createNoopChaos() {
  return /** @type {Chaos} */ ({
    frozen: false,
    blocked: [],
    partition: () => [],
    heal: () => ({ blocked: [], frozen: false }),
    freeze: () => {},
    thaw: () => {},
    isBlocked: () => false,
    state: () => ({ frozen: false, blocked: [] }),
  });
}
