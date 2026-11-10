/**
 * MemberList: this node's address book - "who else is in the cluster, and how
 * do I know they are still alive".
 *
 * Phase 1 compared one wall-clock timestamp per member, exactly like
 * legacy/state.js did. Phase 2 replaces that number with a LOGICAL VERSION:
 *
 *     version = (generation, heartbeat)
 *
 *   - heartbeat   is a counter the owner increments once per gossip round.
 *   - generation  is a number the owner picks once at process start.
 *
 * Why not a timestamp? Two machines' clocks are never identical. With wall
 * clocks, a node whose clock runs 30 s fast makes every other node look stale,
 * and news from a slow node gets rejected for 30 s. Comparing counters needs
 * no agreement about what time it is - only that each owner counts upward.
 *
 * Why generation on top of heartbeat? A restarted process starts counting from
 * heartbeat 0 again. Without generation, peers holding (heartbeat 999) would
 * reject the fresh (heartbeat 0) as stale and the restarted node could never
 * rejoin. A higher generation beats any heartbeat.
 *
 * Still true from Phase 1, and still why this file is easy to test: nothing
 * here reads a clock. `now` is always a parameter.
 */

/** A member's own view of itself. Only the owner may write this field. */
export const STATUS = Object.freeze({
  ALIVE: "alive",
  /** Set by the owner on SIGTERM, so peers show "left" instead of "dead". */
  LEFT: "left",
});

const STATUS_VALUES = Object.freeze(Object.values(STATUS));

/**
 * This node's PRIVATE opinion about a member, derived from how long that
 * member has been silent. Never gossiped, on purpose: a timeout tells you
 * something about the path between two nodes, not about the member itself. If
 * opinions were gossiped, one node behind a bad link could convince the whole
 * cluster that a healthy member is dead. Cassandra draws the same line.
 */
export const LOCAL_STATUS = Object.freeze({
  ALIVE: "alive",
  SUSPECT: "suspect",
  DEAD: "dead",
  /**
   * Not a timeout at all: the member told us it was shutting down. Kept in
   * this field (rather than read off the gossiped `status`) so the dashboard
   * and /members have one field to colour by, and so timers skip it - a node
   * that announced its exit must never be reported as a failure.
   */
  LEFT: "left",
});

/**
 * @typedef {object} Version
 * @property {number} generation
 * @property {number} heartbeat
 */

/**
 * @typedef {object} MemberEntry
 * @property {string} id          Stable node name, e.g. "node-3002".
 * @property {string} address     `host:port` used to reach it.
 * @property {number} generation  Gossiped. Chosen by the owner at startup.
 * @property {number} heartbeat   Gossiped. Incremented by the owner each round.
 * @property {string} status      Gossiped. "alive" | "left", owner-written.
 * @property {object} metadata    Gossiped. Owner-written, e.g. version/startedAt.
 * @property {number} lastSeenAt  LOCAL ONLY: our monotonic clock when its
 *   version last grew.
 * @property {string} localStatus LOCAL ONLY: our own opinion, see LOCAL_STATUS.
 */

/**
 * Order two versions. Generation first, heartbeat only as a tie-break.
 *
 * @param {Version} a
 * @param {Version} b
 * @returns {-1 | 0 | 1} 1 if a is newer, -1 if older, 0 if identical.
 */
export function compareVersions(a, b) {
  if (a.generation !== b.generation) return a.generation > b.generation ? 1 : -1;
  if (a.heartbeat !== b.heartbeat) return a.heartbeat > b.heartbeat ? 1 : -1;
  return 0;
}

/**
 * @param {Version} candidate
 * @param {Version} known
 * @returns {boolean} true only if candidate carries strictly newer news.
 */
export function isNewerVersion(candidate, known) {
  return compareVersions(candidate, known) > 0;
}

export class MemberList {
  /** @type {Map<string, MemberEntry>} id -> entry */
  #members = new Map();

  /**
   * Graveyard: ids we removed, with the highest generation we ever saw for
   * them. This is the answer to the "zombie problem".
   *
   * When a dead member's tombstone is finally dropped from #members, some peer
   * may still be sitting on a stale copy of its entry and will happily gossip
   * it back at us - and we, having forgotten the member, would accept it as
   * news and resurrect a process that no longer exists. Remembering just the
   * generation is enough to refuse that, while costing one number per id
   * instead of a whole entry.
   *
   * A genuinely restarted node arrives with a HIGHER generation, so it is let
   * back in and its gravestone is cleared.
   *
   * @type {Map<string, {generation: number, buriedAt: number}>}
   */
  #graveyard = new Map();

  #selfId;
  #selfAddress;

  /**
   * @param {object} options
   * @param {string} options.selfId
   * @param {string} options.selfAddress
   * @param {number} options.generation  Must be larger on every restart.
   * @param {object} [options.metadata]
   * @param {number} options.now
   */
  constructor({ selfId, selfAddress, generation, metadata = {}, now }) {
    this.#selfId = selfId;
    this.#selfAddress = selfAddress;

    // We keep ourselves in our own list: the list we gossip is then already
    // complete, and this entry is where our own heartbeat lives.
    this.#members.set(selfId, {
      id: selfId,
      address: selfAddress,
      generation,
      heartbeat: 0,
      status: STATUS.ALIVE,
      metadata,
      lastSeenAt: now,
      localStatus: LOCAL_STATUS.ALIVE,
    });
  }

  get selfId() {
    return this.#selfId;
  }

  get selfAddress() {
    return this.#selfAddress;
  }

  get size() {
    return this.#members.size;
  }

  /** @returns {MemberEntry} a copy of our own entry. */
  get self() {
    return { ...this.#members.get(this.#selfId) };
  }

  /**
   * Prove we are alive: heartbeat + 1. Called once per gossip round, before we
   * talk to anybody. This is the only thing that keeps other nodes' failure
   * detectors (Phase 3) from marking us dead.
   *
   * @param {number} now
   * @returns {number} our new heartbeat.
   */
  beat(now) {
    const self = this.#members.get(this.#selfId);
    self.heartbeat += 1;
    self.lastSeenAt = now;
    return self.heartbeat;
  }

  /**
   * Announce that we are shutting down on purpose.
   *
   * The heartbeat is bumped as well, and that is the whole trick: `status` is
   * only believed as part of a newer version, so without the bump peers would
   * compare (same generation, same heartbeat), see no news, and never learn we
   * left. Called from the SIGTERM handler, immediately before one last gossip
   * round.
   *
   * @param {number} now
   * @returns {MemberEntry} our new self entry.
   */
  markSelfLeft(now) {
    const self = this.#members.get(this.#selfId);
    self.status = STATUS.LEFT;
    self.localStatus = LOCAL_STATUS.LEFT;
    self.heartbeat += 1;
    self.lastSeenAt = now;
    return { ...self };
  }

  /**
   * Record our private opinion about a member. Only the failure detector calls
   * this; it is never gossiped.
   *
   * @param {string} id
   * @param {string} localStatus
   * @returns {boolean} true if the opinion changed.
   */
  setLocalStatus(id, localStatus) {
    const entry = this.#members.get(id);
    if (!entry || entry.localStatus === localStatus) return false;

    entry.localStatus = localStatus;
    return true;
  }

  /**
   * Drop a member and remember its generation, so stale gossip cannot bring it
   * back. Self can never be buried.
   *
   * @param {string} id
   * @param {number} now
   * @returns {boolean} true if a member was removed.
   */
  bury(id, now) {
    if (id === this.#selfId) return false;

    const entry = this.#members.get(id);
    if (!entry) return false;

    this.#members.delete(id);
    this.#graveyard.set(id, { generation: entry.generation, buriedAt: now });
    return true;
  }

  /**
   * Forget a gravestone. Called by the detector once the stone is older than
   * any gossip that could still be in flight.
   *
   * @param {string} id
   * @returns {boolean}
   */
  forgetGrave(id) {
    return this.#graveyard.delete(id);
  }

  /** @returns {Array<{id: string, generation: number, buriedAt: number}>} copies. */
  graves() {
    return [...this.#graveyard.entries()].map(([id, grave]) => ({ id, ...grave }));
  }

  /**
   * Merge one entry heard from a peer: legacy registerFriend(), with the
   * timestamp comparison replaced by a version comparison.
   *
   * @param {Partial<MemberEntry>} incoming
   * @param {number} now Local clock; only used for the local lastSeenAt field.
   * @returns {boolean} true if our view actually changed.
   */
  merge(incoming, now) {
    const candidate = normalizeEntry(incoming);
    if (candidate === null) return false;

    // Protocol invariant: only the owner writes its own fields. Whatever a
    // peer claims about *us* is at best stale - our own heartbeat is always
    // ahead of any copy travelling through the network.
    if (candidate.id === this.#selfId) return false;

    // Zombie guard: this id was buried. Only a strictly higher generation -
    // i.e. an actual new process - gets back in.
    const grave = this.#graveyard.get(candidate.id);
    if (grave !== undefined) {
      if (candidate.generation <= grave.generation) return false;
      this.#graveyard.delete(candidate.id);
    }

    const existing = this.#members.get(candidate.id);

    // Stale or identical news never overwrites. Gossip delivers messages out
    // of order constantly, so this guard is what stops the cluster flapping
    // between an old and a new view of the same member.
    if (existing && !isNewerVersion(candidate, existing)) return false;

    this.#members.set(candidate.id, {
      ...candidate,
      // lastSeenAt moves only because the version grew, i.e. because the owner
      // proved it is still running. Re-receiving the same version proves
      // nothing: some peer merely repeated old news. The failure detector
      // reads nothing but this field.
      lastSeenAt: now,
      // A member we had written off is alive again the moment newer news
      // arrives, so suspicion is reversible. The detector re-derives this on
      // its next sweep anyway; setting it here means /members never shows a
      // stale "dead" next to a heartbeat that just advanced.
      localStatus:
        candidate.status === STATUS.LEFT ? LOCAL_STATUS.LEFT : LOCAL_STATUS.ALIVE,
    });
    return true;
  }

  /**
   * @param {Iterable<Partial<MemberEntry>>} entries
   * @param {number} now
   * @returns {number} how many entries changed our view.
   */
  mergeAll(entries, now) {
    if (!entries || typeof entries[Symbol.iterator] !== "function") return 0;

    let changed = 0;
    for (const entry of entries) {
      if (this.merge(entry, now)) changed += 1;
    }
    return changed;
  }

  /**
   * Full local view, local-only fields included. For /members and the
   * dashboard - never for the wire.
   *
   * @returns {MemberEntry[]} copies, sorted by id.
   */
  snapshot() {
    return [...this.#members.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * What we may send to other nodes.
   *
   * Both local fields are stripped here, in one place:
   *   - lastSeenAt   is a reading of OUR clock, meaningless elsewhere;
   *   - localStatus  is OUR opinion. Gossiping it would let one node with a
   *                  bad link talk the whole cluster into a false failure.
   *
   * @returns {Array<Omit<MemberEntry, "lastSeenAt" | "localStatus">>}
   */
  toWire() {
    return this.snapshot().map(
      ({ lastSeenAt: _lastSeenAt, localStatus: _localStatus, ...wire }) => wire,
    );
  }

  /**
   * @param {string} id
   * @returns {MemberEntry | undefined} a copy, or undefined.
   */
  get(id) {
    const entry = this.#members.get(id);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Pick up to k random peers to gossip with: never ourselves, never a member
   * that announced it is leaving, and never one we have already written off as
   * dead - all of those just waste a slot in the round.
   *
   * SUSPECT members are deliberately still gossiped at. Suspicion means "I
   * have not heard from you lately", and the cheapest way to resolve it is to
   * ask: one reply with a newer heartbeat clears it instantly. Skipping them
   * would turn every suspicion into a self-fulfilling death.
   *
   * Same Fisher-Yates shuffle as legacy/state.js:39-45: shuffle, then take the
   * first k. Taking k independent random picks would sometimes return the same
   * peer twice and waste a round.
   *
   * @param {number} k
   * @returns {MemberEntry[]}
   */
  randomPeers(k) {
    const unreachable = new Set([LOCAL_STATUS.DEAD, LOCAL_STATUS.LEFT]);
    const candidates = [...this.#members.values()]
      .filter((entry) => entry.id !== this.#selfId && !unreachable.has(entry.localStatus))
      .map((entry) => ({ ...entry }));

    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, Math.max(0, k));
  }

  /**
   * Members we have written off: dead, or gone on purpose.
   *
   * A verdict has to stay revisitable. If "dead" simply removed a member from
   * every code path, a healed network partition could never be noticed: both
   * sides would be permanently convinced the other was gone and would never
   * speak to it again. So the gossiper keeps a slot for re-probing these -
   * rarely, because they usually really are gone. SWIM and Cassandra do the
   * same thing for the same reason.
   *
   * @param {number} k
   * @returns {MemberEntry[]} up to k of them, shuffled.
   */
  randomUnreachable(k) {
    const unreachable = new Set([LOCAL_STATUS.DEAD, LOCAL_STATUS.LEFT]);
    const candidates = [...this.#members.values()]
      .filter((entry) => entry.id !== this.#selfId && unreachable.has(entry.localStatus))
      .map((entry) => ({ ...entry }));

    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, Math.max(0, k));
  }
}

/**
 * Gossip arrives over HTTP from another process, so it is untrusted input: one
 * malformed entry must not poison the list or crash the node.
 *
 * Returns a clean entry (never the caller's object) or null if unusable.
 *
 * @param {unknown} entry
 * @returns {Omit<MemberEntry, "lastSeenAt"> | null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const { id, address, generation, heartbeat, status, metadata } =
    /** @type {MemberEntry} */ (entry);

  if (typeof id !== "string" || id.trim() === "") return null;
  if (typeof address !== "string" || address.trim() === "") return null;

  // Counters, not timestamps: integers, never negative. Rejecting junk here is
  // what keeps compareVersions() total - a NaN would make every comparison
  // false and silently freeze that member's entry forever.
  if (!isCounter(generation) || !isCounter(heartbeat)) return null;

  // A missing status is read as "alive", so a node that does not send the field
  // still merges; an unknown value is refused rather than guessed at.
  const resolvedStatus = status === undefined ? STATUS.ALIVE : status;
  if (!STATUS_VALUES.includes(resolvedStatus)) return null;

  const resolvedMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};

  return {
    id,
    address,
    generation,
    heartbeat,
    status: resolvedStatus,
    metadata: { ...resolvedMetadata },
  };
}

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-negative integer.
 */
function isCounter(value) {
  return Number.isInteger(value) && value >= 0;
}
