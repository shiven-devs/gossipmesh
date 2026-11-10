/**
 * Rumors: getting one message to every node, using the same gossip rounds the
 * membership list already rides on.
 *
 * The algorithm is the one epidemics use. A node that hears something new
 * repeats it to the peers it talks to for the next RUMOR_ROUNDS rounds, then
 * shuts up about it. Nobody keeps a list of who has been told, nobody
 * acknowledges anything, and no node is in charge. With fanout k, the number
 * of informed nodes multiplies every round, so the whole cluster hears it in
 * roughly log_k(N) rounds - which is why this scales to hundreds of nodes
 * while a central broadcaster does not.
 *
 * Why stop forwarding at all? Because after a few rounds almost every peer
 * already has it, and continuing just burns bandwidth re-telling news. The
 * round counter is the cheapest possible stopping rule: no coordination, no
 * counting of acknowledgements.
 *
 * Two clocks appear here, for two different jobs, and mixing them up is a real
 * trap:
 *   - `createdAt` / `receivedAt` are WALL clock, for a human and the dashboard
 *     to read. Comparing one node's receivedAt with another's also measures
 *     the difference between their clocks, so they are display values, not a
 *     benchmark. Phase 9 must measure spread from a single observer.
 *   - `hops` is clock-free: how many forwards it took to reach this node. That
 *     is the honest per-node measure of how the rumor travelled.
 *
 * As everywhere else in src/, `now` is a parameter: no clock is read here.
 */

import { randomUUID } from "node:crypto";

/**
 * @typedef {object} Rumor
 * @property {string} id           Unique id, minted by the originating node.
 * @property {string} origin       Node id that started it.
 * @property {unknown} payload     Whatever was broadcast.
 * @property {number} createdAt    Origin's wall clock, gossiped, display only.
 * @property {number} hops         Forwards taken to reach us. Gossiped.
 * @property {number} receivedAt    LOCAL ONLY: our wall clock when it arrived.
 * @property {number} roundsLeft    LOCAL ONLY: rounds we will still forward it.
 */

export class RumorStore {
  /** @type {Map<string, Rumor>} id -> rumor, insertion-ordered. */
  #rumors = new Map();

  /**
   * Every rumor id we have ever held, including ones evicted from #rumors.
   *
   * This is what makes the protocol idempotent: the same rumor arrives from
   * several peers in the same round, and from more peers for rounds after
   * that. Without a seen-set we would "re-learn" it each time, reset its round
   * counter and keep it alive forever - an epidemic that never burns out.
   *
   * @type {Set<string>}
   */
  #seen = new Set();

  #selfId;
  #rumorRounds;
  #maxRumors;

  /**
   * @param {object} options
   * @param {string} options.selfId
   * @param {number} options.rumorRounds
   * @param {number} [options.maxRumors]
   */
  constructor({ selfId, rumorRounds, maxRumors = 100 }) {
    this.#selfId = selfId;
    this.#rumorRounds = rumorRounds;
    this.#maxRumors = maxRumors;
  }

  get size() {
    return this.#rumors.size;
  }

  /**
   * Start a new rumor here. This is what POST /broadcast does.
   *
   * @param {object} options
   * @param {unknown} options.payload
   * @param {number} options.now Wall clock, for createdAt/receivedAt.
   * @param {() => string} [options.newId] Injectable for deterministic tests.
   * @returns {Rumor} a copy.
   */
  create({ payload, now, newId = randomUUID }) {
    const rumor = {
      id: newId(),
      origin: this.#selfId,
      payload,
      createdAt: now,
      hops: 0,
      receivedAt: now,
      roundsLeft: this.#rumorRounds,
    };

    this.#seen.add(rumor.id);
    this.#rumors.set(rumor.id, rumor);
    this.#evictOverflow();

    return { ...rumor };
  }

  /**
   * Take in one rumor heard from a peer.
   *
   * @param {Partial<Rumor>} incoming
   * @param {number} now Wall clock.
   * @returns {boolean} true only if this is news to us.
   */
  receive(incoming, now) {
    const candidate = normalizeRumor(incoming);
    if (candidate === null) return false;

    // Already known - including rumors we have long stopped forwarding, and
    // ones we started ourselves coming back around the cluster.
    if (this.#seen.has(candidate.id)) return false;

    this.#seen.add(candidate.id);
    this.#rumors.set(candidate.id, {
      ...candidate,
      // One more forward than the peer that told us. Clock-free, and it says
      // how far from the origin we are.
      hops: candidate.hops + 1,
      receivedAt: now,
      roundsLeft: this.#rumorRounds,
    });
    this.#evictOverflow();

    return true;
  }

  /**
   * @param {Iterable<Partial<Rumor>>} rumors
   * @param {number} now
   * @returns {number} how many were new to us.
   */
  receiveAll(rumors, now) {
    if (!rumors || typeof rumors[Symbol.iterator] !== "function") return 0;

    let learned = 0;
    for (const rumor of rumors) {
      if (this.receive(rumor, now)) learned += 1;
    }
    return learned;
  }

  /**
   * The rumors we still pass on, in wire form. Local bookkeeping
   * (receivedAt, roundsLeft) is stripped: those are our numbers, not news.
   *
   * @returns {Array<{id: string, origin: string, payload: unknown, createdAt: number, hops: number}>}
   */
  forwardable() {
    const wire = [];
    for (const rumor of this.#rumors.values()) {
      if (rumor.roundsLeft <= 0) continue;
      const { id, origin, payload, createdAt, hops } = rumor;
      wire.push({ id, origin, payload, createdAt, hops });
    }
    return wire;
  }

  /**
   * Called once per completed gossip round: every rumor we are still spreading
   * gets one round closer to silence.
   *
   * @returns {number} how many rumors are still being forwarded.
   */
  afterRound() {
    let active = 0;
    for (const rumor of this.#rumors.values()) {
      if (rumor.roundsLeft > 0) {
        rumor.roundsLeft -= 1;
        if (rumor.roundsLeft > 0) active += 1;
      }
    }
    return active;
  }

  /** @returns {number} rumors still being forwarded. */
  activeCount() {
    let active = 0;
    for (const rumor of this.#rumors.values()) {
      if (rumor.roundsLeft > 0) active += 1;
    }
    return active;
  }

  /**
   * Local view for GET /rumors and the dashboard: newest arrival first.
   *
   * @returns {Rumor[]} copies.
   */
  snapshot() {
    return [...this.#rumors.values()]
      .map((rumor) => ({ ...rumor }))
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  /**
   * @param {string} id
   * @returns {Rumor | undefined} a copy.
   */
  get(id) {
    const rumor = this.#rumors.get(id);
    return rumor ? { ...rumor } : undefined;
  }

  /**
   * Keep the store bounded. The oldest entry goes first; its id stays in
   * #seen, so dropping it cannot make the rumor spreadable again.
   */
  #evictOverflow() {
    while (this.#rumors.size > this.#maxRumors) {
      const oldest = this.#rumors.keys().next().value;
      this.#rumors.delete(oldest);
    }
  }
}

/**
 * Rumors arrive over HTTP from other processes, so they are untrusted: one
 * malformed entry must not poison the store or crash the node.
 *
 * @param {unknown} rumor
 * @returns {{id: string, origin: string, payload: unknown, createdAt: number, hops: number} | null}
 */
function normalizeRumor(rumor) {
  if (!rumor || typeof rumor !== "object" || Array.isArray(rumor)) return null;

  const { id, origin, payload, createdAt, hops } = /** @type {Rumor} */ (rumor);

  if (typeof id !== "string" || id.trim() === "") return null;
  if (typeof origin !== "string" || origin.trim() === "") return null;
  if (!Number.isFinite(createdAt)) return null;
  if (!Number.isInteger(hops) || hops < 0) return null;

  return { id, origin, payload, createdAt, hops };
}
