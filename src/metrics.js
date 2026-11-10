/**
 * Metrics in Prometheus format.
 *
 * Each node gets its OWN registry rather than prom-client's global default
 * one. Same reason MemberList is a class: the integration test runs five nodes
 * inside one process, and a shared global registry would both throw on
 * duplicate metric names and mix five nodes' numbers into one.
 *
 * Choosing the metric type is the part worth understanding:
 *   - Counter   only ever goes up (rounds run, exchanges failed). Prometheus
 *               takes the rate; a restart back to 0 is detected, not averaged
 *               into nonsense.
 *   - Gauge     a value that moves both ways (members known right now).
 *   - Histogram a distribution, pre-bucketed, so p95 latency can be computed
 *               on the server instead of shipping every sample.
 *
 * A node that is inside a network partition still serves /metrics happily, so
 * these numbers are a per-node view - exactly like localStatus.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class Metrics {
  #registry;
  #instruments;

  /**
   * @param {object} options
   * @param {string} options.nodeId
   * @param {boolean} [options.collectDefaults] Node process/heap metrics too.
   */
  constructor({ nodeId, collectDefaults = true }) {
    const registry = new Registry();
    // Every series from this process carries its node id, so one Prometheus
    // can scrape the whole cluster and still tell the pods apart.
    registry.setDefaultLabels({ nodeId });

    if (collectDefaults) collectDefaultMetrics({ register: registry });

    const common = { registers: [registry] };

    this.#instruments = {
      roundsTotal: new Counter({
        name: "gossip_rounds_total",
        help: "Gossip rounds started by this node",
        ...common,
      }),
      exchangesTotal: new Counter({
        name: "gossip_exchanges_total",
        help: "Outgoing gossip exchanges, by outcome",
        labelNames: ["result"],
        ...common,
      }),
      exchangeDuration: new Histogram({
        name: "gossip_exchange_duration_seconds",
        help: "Time for one outgoing gossip exchange",
        // Buckets chosen around the default 500 ms request timeout: finer than
        // prom-client's defaults at the low end, since most exchanges are
        // local-network fast and the interesting tail is near the timeout.
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
        ...common,
      }),
      mergesTotal: new Counter({
        name: "gossip_member_merges_total",
        help: "Member entries that changed this node's view",
        ...common,
      }),
      statusChangesTotal: new Counter({
        name: "member_status_changes_total",
        help: "Local status transitions, by the status moved to",
        labelNames: ["to"],
        ...common,
      }),
      membersKnown: new Gauge({
        name: "cluster_members_known",
        help: "Members in this node's list, by local status",
        labelNames: ["localStatus"],
        ...common,
      }),
      gravesKnown: new Gauge({
        name: "cluster_graves_known",
        help: "Buried member ids still remembered, to refuse stale gossip",
        ...common,
      }),
      rumorsCreatedTotal: new Counter({
        name: "rumors_created_total",
        help: "Rumors started on this node",
        ...common,
      }),
      rumorsReceivedTotal: new Counter({
        name: "rumors_received_total",
        help: "Rumors first learned from a peer",
        ...common,
      }),
      rumorsActive: new Gauge({
        name: "rumors_active",
        help: "Rumors this node is still forwarding",
        ...common,
      }),
      rumorHops: new Histogram({
        name: "rumor_hops",
        help: "Forwards a rumor had taken when it reached this node",
        buckets: [0, 1, 2, 3, 4, 5, 6, 8, 10],
        ...common,
      }),
    };

    // A labelled counter has no time series until its first inc(), so
    // gossip_exchanges_total{result="failed"} simply would not exist on a
    // healthy node - and a dashboard or alert that divides by it would break
    // on "no data" instead of reading zero. Initialising the known label
    // values to 0 makes the absence of failures visible rather than missing.
    for (const result of ["ok", "failed", "blocked"]) {
      this.#instruments.exchangesTotal.inc({ result }, 0);
    }

    this.#registry = registry;
  }

  /** @returns {import("prom-client").Registry} */
  get registry() {
    return this.#registry;
  }

  roundStarted() {
    this.#instruments.roundsTotal.inc();
  }

  /**
   * @param {"ok" | "failed" | "blocked"} result
   * @param {number} [seconds]
   */
  exchangeFinished(result, seconds) {
    this.#instruments.exchangesTotal.inc({ result });
    if (result === "ok" && seconds !== undefined) {
      this.#instruments.exchangeDuration.observe(seconds);
    }
  }

  /** @param {number} count */
  membersMerged(count) {
    if (count > 0) this.#instruments.mergesTotal.inc(count);
  }

  /** @param {Array<{to: string}>} transitions */
  statusChanged(transitions) {
    for (const transition of transitions) {
      this.#instruments.statusChangesTotal.inc({ to: transition.to });
    }
  }

  rumorCreated() {
    this.#instruments.rumorsCreatedTotal.inc();
  }

  /** @param {number} hops */
  rumorLearned(hops) {
    this.#instruments.rumorsReceivedTotal.inc();
    this.#instruments.rumorHops.observe(hops);
  }

  /**
   * Refresh the gauges from current state. Called when /metrics is scraped:
   * a gauge describes "right now", so sampling it at scrape time is both
   * cheaper and more accurate than updating it on every change.
   *
   * @param {object} state
   * @param {import("./membership.js").MemberList} state.members
   * @param {import("./rumors.js").RumorStore} state.rumors
   */
  refreshGauges({ members, rumors }) {
    const counts = {};
    for (const member of members.snapshot()) {
      counts[member.localStatus] = (counts[member.localStatus] ?? 0) + 1;
    }

    // Reset first, so a status that dropped to zero reports 0 instead of
    // keeping its last value forever.
    this.#instruments.membersKnown.reset();
    for (const [localStatus, count] of Object.entries(counts)) {
      this.#instruments.membersKnown.set({ localStatus }, count);
    }

    this.#instruments.gravesKnown.set(members.graves().length);
    this.#instruments.rumorsActive.set(rumors.activeCount());
  }

  /** @returns {Promise<string>} the Prometheus text exposition. */
  async render() {
    return this.#registry.metrics();
  }

  get contentType() {
    return this.#registry.contentType;
  }
}

/**
 * A do-nothing Metrics stand-in, so unit tests can construct a Gossiper or a
 * detector without building a registry.
 *
 * @returns {Metrics}
 */
export function createNoopMetrics() {
  const noop = () => {};
  return /** @type {Metrics} */ ({
    registry: null,
    contentType: "text/plain",
    roundStarted: noop,
    exchangeFinished: noop,
    membersMerged: noop,
    statusChanged: noop,
    rumorCreated: noop,
    rumorLearned: noop,
    refreshGauges: noop,
    render: async () => "",
  });
}
