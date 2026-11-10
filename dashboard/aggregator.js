/**
 * ClusterView: the dashboard's model of the cluster.
 *
 * The dashboard is a READER, not a participant. It never gossips, never
 * votes, and nothing it does can change what the cluster believes. It polls
 * every node's /members and /rumors and keeps the latest answer from each.
 *
 * The interesting consequence: there is no single "cluster state" to show.
 * Every node has its own opinion, and for a few rounds after any change those
 * opinions legitimately differ. So the centrepiece is an N x N matrix - one
 * row per observer, one column per member - which makes eventual consistency
 * something you can watch instead of something you take on faith. During a
 * partition the rows split into blocks; after a heal they go green again.
 *
 * Measuring rumor spread, honestly: each node stamps its own `receivedAt` with
 * its own wall clock, so subtracting one node's from another's measures the
 * difference between two clocks as much as the spread. This file therefore
 * times spread with ONE clock - the dashboard's own, recorded when it first
 * SEES a node holding the rumor. That is a pessimistic measurement, bounded
 * below by the poll interval, and it is honest; the per-node receivedAt values
 * are passed through for display only.
 *
 * As in src/, `now` is injected, so the tests drive a fake clock.
 */

/**
 * @typedef {object} NodeReport
 * @property {boolean} reachable
 * @property {object} [members]   Body of GET /members.
 * @property {object} [rumors]    Body of GET /rumors.
 * @property {string} [error]     Why the poll failed.
 */

export class ClusterView {
  /**
   * Latest report per polled address.
   * @type {Map<string, object>}
   */
  #nodes = new Map();

  /**
   * First time THIS dashboard saw a given node holding a given rumor.
   * Key: `${rumorId}\u0000${nodeId}`.
   * @type {Map<string, number>}
   */
  #firstObserved = new Map();

  /** @type {Map<string, object>} rumorId -> what we know about it. */
  #rumors = new Map();

  #maxRumors;

  /** @param {{maxRumors?: number}} [options] */
  constructor({ maxRumors = 50 } = {}) {
    this.#maxRumors = maxRumors;
  }

  /**
   * Record one poll result.
   *
   * @param {string} address        host:port that was polled.
   * @param {NodeReport} report
   * @param {number} now            Dashboard clock (wall, for display).
   */
  update(address, report, now) {
    const previous = this.#nodes.get(address);

    if (!report.reachable) {
      // Keep the last known view, flagged stale. A node that cannot be reached
      // is not necessarily down - the dashboard's own link may be the problem,
      // which is the same ambiguity the nodes themselves live with. Showing
      // the last view greyed out beats blanking the row.
      this.#nodes.set(address, {
        address,
        reachable: false,
        error: report.error ?? "unreachable",
        polledAt: now,
        nodeId: previous?.nodeId ?? null,
        members: previous?.members ?? [],
        byLocalStatus: previous?.byLocalStatus ?? {},
        graves: previous?.graves ?? [],
        stale: true,
      });
      return;
    }

    const members = report.members ?? {};
    this.#nodes.set(address, {
      address,
      reachable: true,
      error: null,
      polledAt: now,
      nodeId: members.self?.id ?? null,
      members: members.members ?? [],
      byLocalStatus: members.byLocalStatus ?? {},
      graves: members.graves ?? [],
      stale: false,
    });

    this.#absorbRumors(members.self?.id ?? address, report.rumors?.rumors ?? [], now);
  }

  /**
   * @param {string} nodeId
   * @param {Array<object>} rumors
   * @param {number} now
   */
  #absorbRumors(nodeId, rumors, now) {
    for (const rumor of rumors) {
      if (!rumor?.id) continue;

      const known = this.#rumors.get(rumor.id) ?? {
        id: rumor.id,
        origin: rumor.origin,
        payload: rumor.payload,
        createdAt: rumor.createdAt,
        /** @type {Map<string, object>} nodeId -> how it looks on that node. */
        holders: new Map(),
      };

      const key = `${rumor.id}\u0000${nodeId}`;
      if (!this.#firstObserved.has(key)) this.#firstObserved.set(key, now);

      known.holders.set(nodeId, {
        nodeId,
        hops: rumor.hops,
        // The node's own wall clock. Display only - see the file header.
        receivedAt: rumor.receivedAt,
        // The dashboard's clock, which is the one we are allowed to subtract.
        observedAt: this.#firstObserved.get(key),
      });

      this.#rumors.set(rumor.id, known);
    }

    // Bounded, oldest first: the dashboard is a long-running process too.
    while (this.#rumors.size > this.#maxRumors) {
      const oldest = this.#rumors.keys().next().value;
      const dropped = this.#rumors.get(oldest);
      for (const holder of dropped.holders.keys()) {
        this.#firstObserved.delete(`${oldest}\u0000${holder}`);
      }
      this.#rumors.delete(oldest);
    }
  }

  /**
   * Everything the UI needs, in one JSON document.
   *
   * @param {number} now
   * @returns {object}
   */
  snapshot(now) {
    // A restarted pod comes back with the same node id and a NEW IP, so for a
    // while two addresses report the same observer: the dead one we have not
    // forgotten yet, and the live one. Showing both puts two rows labelled
    // "gossip-3" in the table, which during a demo reads as a bug in the
    // protocol rather than a detail of pod networking. Keep the freshest
    // report per node id, and only fall back to the address when a node has
    // never answered at all.
    const freshest = new Map();
    for (const node of this.#nodes.values()) {
      const key = node.nodeId ?? `address:${node.address}`;
      const held = freshest.get(key);
      if (!held || node.polledAt > held.polledAt || (node.reachable && !held.reachable)) {
        freshest.set(key, node);
      }
    }

    const nodes = [...freshest.values()].sort((a, b) =>
      (a.nodeId ?? a.address).localeCompare(b.nodeId ?? b.address),
    );

    // Columns are the union of every member any observer knows about - so a
    // member only one node has heard of still gets a column, which is exactly
    // what a half-propagated join looks like.
    const memberIds = new Set();
    for (const node of nodes) {
      for (const member of node.members) memberIds.add(member.id);
    }
    const columns = [...memberIds].sort((a, b) => a.localeCompare(b));

    const rows = nodes.map((node) => {
      const byId = new Map(node.members.map((m) => [m.id, m]));

      return {
        observer: node.nodeId ?? node.address,
        address: node.address,
        reachable: node.reachable,
        stale: node.stale,
        error: node.error,
        ageMs: Math.max(0, Math.round(now - node.polledAt)),
        cells: columns.map((id) => {
          const member = byId.get(id);
          if (!member) {
            // Either this observer has not heard of that member yet, or it
            // buried it. Both are "no opinion", and both are worth seeing.
            const buried = node.graves.some((g) => g.id === id);
            return { id, status: buried ? "buried" : "unknown" };
          }
          return {
            id,
            // localStatus is the observer's own verdict; status is what the
            // member said about itself. Both matter: "alive/dead" means a
            // healthy member this observer cannot hear.
            status: member.localStatus,
            selfStatus: member.status,
            heartbeat: member.heartbeat,
            generation: member.generation,
            self: member.id === node.nodeId,
          };
        }),
      };
    });

    return {
      generatedAt: now,
      summary: summarize(rows, columns),
      columns,
      rows,
      rumors: this.#rumorSnapshot(columns.length),
    };
  }

  /**
   * @param {number} clusterSize
   * @returns {Array<object>} newest rumor first.
   */
  #rumorSnapshot(clusterSize) {
    const rumors = [...this.#rumors.values()].map((rumor) => {
      const holders = [...rumor.holders.values()].sort((a, b) => a.observedAt - b.observedAt);
      const first = holders[0]?.observedAt ?? null;
      const last = holders.at(-1)?.observedAt ?? null;

      return {
        id: rumor.id,
        origin: rumor.origin,
        payload: rumor.payload,
        createdAt: rumor.createdAt,
        holders,
        holderCount: holders.length,
        clusterSize,
        complete: clusterSize > 0 && holders.length >= clusterSize,
        // One clock, the dashboard's - the only one it may subtract from
        // itself. Two cases produce no number at all, and saying so beats
        // printing a misleading zero:
        //   - a single holder: there is no interval yet;
        //   - every holder first seen in the SAME poll sweep: the rumor beat
        //     the poll interval, so all this measurement can honestly say is
        //     "faster than one poll".
        observedSpreadMs: holders.length >= 2 && last > first ? Math.round(last - first) : null,
        spreadNote:
          holders.length < 2
            ? "only one node has it so far"
            : last > first
              ? null
              : "faster than one poll interval",
        maxHops: holders.reduce((max, h) => Math.max(max, h.hops ?? 0), 0),
      };
    });

    return rumors.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /** @returns {string[]} addresses currently answering. */
  reachableAddresses() {
    return [...this.#nodes.values()].filter((n) => n.reachable).map((n) => n.address);
  }

  /** @returns {string[]} every address we hold a report for. */
  polledAddresses() {
    return [...this.#nodes.keys()];
  }

  /**
   * Drop rows for addresses that are no longer discovered at all.
   *
   * With DNS discovery an address disappears for two different reasons, and
   * they must not look the same: a pod that is merely unreachable keeps its
   * row (greyed out, because our own link may be the problem), while a pod
   * that has been scaled away stops being resolved and should leave the page.
   * A grace period means a single failed lookup cannot blank the whole table.
   *
   * @param {string[]} stillDiscovered
   * @param {number} now
   * @param {number} [graceMs]
   * @returns {string[]} addresses forgotten.
   */
  forgetAddressesExcept(stillDiscovered, now, graceMs = 30_000) {
    const keep = new Set(stillDiscovered);
    const forgotten = [];

    for (const [address, node] of this.#nodes) {
      if (keep.has(address)) continue;
      if (now - node.polledAt < graceMs) continue;

      this.#nodes.delete(address);
      forgotten.push(address);
    }
    return forgotten;
  }
}

/**
 * Counts for the header tiles.
 *
 * `disagreements` is the number of columns where observers do not all say the
 * same thing. It is the single most useful number on the page: it is nonzero
 * while the cluster is converging and zero once it has, which is what
 * "eventual consistency" means in one integer.
 *
 * @param {Array<object>} rows
 * @param {string[]} columns
 */
function summarize(rows, columns) {
  const reachable = rows.filter((r) => r.reachable);

  let disagreements = 0;
  for (let i = 0; i < columns.length; i += 1) {
    const opinions = new Set(
      reachable.map((row) => row.cells[i].status).filter((status) => status !== "unknown"),
    );
    if (opinions.size > 1) disagreements += 1;
  }

  // Worst opinion anyone holds about each member, so one node's "dead" is
  // never hidden by four nodes' "alive".
  const severity = { alive: 0, left: 1, suspect: 2, dead: 3, buried: 4, unknown: -1 };
  const worst = {};
  for (let i = 0; i < columns.length; i += 1) {
    let pick = "unknown";
    for (const row of reachable) {
      const status = row.cells[i].status;
      if ((severity[status] ?? -1) > (severity[pick] ?? -1)) pick = status;
    }
    worst[pick] = (worst[pick] ?? 0) + 1;
  }

  return {
    observers: rows.length,
    observersReachable: reachable.length,
    members: columns.length,
    disagreements,
    worstCase: worst,
  };
}
