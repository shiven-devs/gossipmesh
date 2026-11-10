/**
 * HTTP server: the routes from legacy/index.js:69-87, grown into the node's
 * whole public surface.
 *
 * The important change is the shape, not the routes: createServer() builds and
 * returns the Express app but never calls listen(). Starting a real socket is
 * src/index.js's job. That lets supertest exercise every route in-process, and
 * it lets an integration test run five nodes inside one test file.
 *
 * Everything the routes need is injected, so there is no hidden module-level
 * state anywhere - the thing that made legacy/state.js untestable.
 */

import express from "express";

import { createNoopChaos } from "./chaos.js";
import { createNoopMetrics } from "./metrics.js";

/**
 * @param {object} deps
 * @param {import("./config.js").Config} deps.config
 * @param {import("./membership.js").MemberList} deps.members
 * @param {import("./rumors.js").RumorStore} deps.rumors
 * @param {import("pino").Logger} deps.logger
 * @param {() => number} deps.now Monotonic clock. Required on purpose: a
 *   wall-clock default would quietly break the invariant that lastSeenAt is
 *   monotonic, and nothing would fail loudly.
 * @param {() => number} [deps.wallNow] Wall clock, for rumor timestamps.
 * @param {{successfulExchanges: number}} [deps.gossiper] Readiness source.
 * @param {import("./metrics.js").Metrics} [deps.metrics]
 * @param {import("./chaos.js").Chaos} [deps.chaos]
 * @returns {import("express").Express}
 */
export function createServer({
  config,
  members,
  rumors,
  logger,
  now,
  wallNow = Date.now,
  gossiper = { successfulExchanges: 0 },
  metrics = createNoopMetrics(),
  chaos = createNoopChaos(),
}) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  /**
   * POST /gossip - the server half of a push-pull exchange.
   *
   * A peer pushes its state, we reply with ours, and both sides merge. Note
   * the order below: we snapshot our own view BEFORE merging, like
   * legacy/index.js:79 did. Replying after the merge would echo the peer's own
   * entries back at it for no reason.
   */
  app.post("/gossip", (req, res) => {
    const body = req.body ?? {};
    const from = body.from ?? {};

    if (typeof from.id !== "string" || from.id.trim() === "") {
      return res.status(400).json({ error: "from.id is required" });
    }
    if (from.id === members.selfId) {
      // Same guard as legacy's "cannot gossip self": a node asking itself is a
      // configuration mistake (usually a bad SEEDS entry) and worth surfacing.
      return res.status(400).json({ error: "cannot gossip with self" });
    }

    // A partition has to bite in both directions. If only the sender refused,
    // news would still leak across the split and the demo would show nothing.
    if (chaos.isBlocked({ id: from.id, address: from.address })) {
      logger.warn({ from: from.id }, "chaos: refused inbound gossip (partitioned)");
      return res.status(503).json({ error: "partitioned from this node" });
    }

    const reply = { members: members.toWire(), rumors: rumors.forwardable() };

    const merged = members.mergeAll(body.members, now());
    metrics.membersMerged(merged);

    let learned = 0;
    for (const rumor of body.rumors ?? []) {
      if (!rumors.receive(rumor, wallNow())) continue;
      learned += 1;
      metrics.rumorLearned(rumors.get(rumor.id)?.hops ?? 0);
      logger.info({ rumor: rumor.id, origin: rumor.origin }, "rumor learned");
    }

    logger.debug({ from: from.id, merged, learned, size: members.size }, "handled inbound gossip");

    return res.json({
      from: { id: members.selfId, address: members.selfAddress },
      members: reply.members,
      rumors: reply.rumors,
    });
  });

  /**
   * GET /members - this node's own view, local fields included.
   *
   * legacy's /friends renamed, because these are cluster members now, and
   * because the response carries localStatus (alive/suspect/dead/left).
   * "This node's view" matters: two nodes may legitimately disagree for a few
   * rounds, and the Phase 6 dashboard is built to show that.
   */
  app.get("/members", (req, res) => {
    const snapshot = members.snapshot();

    // A pre-counted summary so the dashboard (Phase 6) and a human with curl
    // can see the shape of the cluster without reducing the list themselves.
    const byLocalStatus = {};
    for (const member of snapshot) {
      byLocalStatus[member.localStatus] = (byLocalStatus[member.localStatus] ?? 0) + 1;
    }

    res.json({
      self: { id: members.selfId, address: members.selfAddress },
      count: snapshot.length,
      byLocalStatus,
      members: snapshot,
      // Buried members: ids we dropped, kept only as "do not resurrect below
      // this generation". Exposed because during the demo it answers "where
      // did gossip-3 go?".
      graves: members.graves(),
    });
  });

  /**
   * POST /broadcast - start a rumor here and let gossip carry it everywhere.
   *
   * Returns immediately. There is nothing to wait for: delivery is not
   * acknowledged by anyone, it just becomes increasingly likely each round.
   * That is the trade this design makes - no broker, no connections, no
   * delivery guarantee.
   */
  app.post("/broadcast", (req, res) => {
    const body = req.body ?? {};
    if (body.payload === undefined) {
      return res.status(400).json({ error: "payload is required" });
    }

    const rumor = rumors.create({ payload: body.payload, now: wallNow() });
    metrics.rumorCreated();
    logger.info({ rumor: rumor.id }, "rumor created");

    return res.status(202).json({ rumor });
  });

  /** GET /rumors - what this node has heard, newest first, with hop counts. */
  app.get("/rumors", (req, res) => {
    const snapshot = rumors.snapshot();

    res.json({
      self: { id: members.selfId },
      count: snapshot.length,
      active: rumors.activeCount(),
      rumors: snapshot,
    });
  });

  /**
   * GET /health - liveness. "Is this process working at all?"
   *
   * Deliberately says nothing about the cluster. If this returned unhealthy
   * because peers were unreachable, then a network partition would make
   * Kubernetes restart every pod on both sides - turning a network problem
   * into an outage. Liveness failure means "restart me"; an isolated node does
   * not need restarting.
   */
  app.get("/health", (req, res) => {
    res.json({ status: "ok", nodeId: members.selfId, uptimeMs: Math.round(now()) });
  });

  /**
   * GET /ready - readiness. "Should traffic and peers rely on me yet?"
   *
   * A node is ready once it has completed at least one exchange, i.e. it has
   * actually met the cluster. A node with no seeds is ready immediately -
   * it is the cluster.
   *
   * Unready is not a failure: Kubernetes keeps the pod running and simply
   * waits, which is exactly right for a node still catching up.
   */
  app.get("/ready", (req, res) => {
    const joined = gossiper.successfulExchanges > 0;
    // "Alone" means no bootstrap of ANY kind was configured. Checking only the
    // static SEEDS list used to be enough; under Kubernetes the seeds come
    // from SEED_DNS, and ignoring that made a pod that had met nobody report
    // itself ready - the probe passed while the cluster was five clusters of
    // one. A readiness probe that cannot fail is worse than no probe.
    const alone = config.seeds.length === 0 && !config.seedDns;
    const ready = joined || alone;

    res.status(ready ? 200 : 503).json({
      ready,
      reason: ready ? (joined ? "exchanged with a peer" : "no seeds configured") : "no exchange yet",
      members: members.size,
    });
  });

  /** GET /metrics - Prometheus text exposition. */
  app.get("/metrics", async (req, res, next) => {
    try {
      // Gauges describe "right now", so they are sampled at scrape time
      // rather than written on every change.
      metrics.refreshGauges({ members, rumors });
      res.set("Content-Type", metrics.contentType);
      res.send(await metrics.render());
    } catch (err) {
      next(err);
    }
  });

  // Fault injection, mounted only when asked for: /chaos/crash kills the
  // process, which no production image should offer.
  if (config.chaosEnabled) {
    logger.warn("chaos endpoints are ENABLED");

    app.post("/chaos/partition", (req, res) => {
      const ids = Array.isArray(req.body?.block) ? req.body.block : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: "block must be a non-empty array of node ids" });
      }
      return res.json({ blocked: chaos.partition(ids) });
    });

    app.post("/chaos/heal", (req, res) => {
      res.json({ healed: chaos.heal(), state: chaos.state() });
    });

    app.post("/chaos/freeze", (req, res) => {
      const durationMs = Number(req.body?.durationMs ?? 0);
      chaos.freeze(Number.isFinite(durationMs) ? durationMs : 0);
      res.json({ state: chaos.state() });
    });

    app.post("/chaos/thaw", (req, res) => {
      chaos.thaw();
      res.json({ state: chaos.state() });
    });

    app.get("/chaos", (req, res) => {
      res.json(chaos.state());
    });

    app.post("/chaos/crash", (req, res) => {
      logger.error("chaos: crashing on request, no graceful leave");
      // Answer first, then die, so the caller gets a reply instead of a reset
      // connection. exit(1) skips the SIGTERM handler entirely: peers get
      // silence and must work it out for themselves.
      res.json({ crashing: true });
      setTimeout(() => process.exit(1), 50);
    });
  }

  // Unknown path: a plain JSON 404 keeps every response on this port JSON, so
  // curl and the dashboard never have to parse Express's HTML error page.
  app.use((req, res) => {
    res.status(404).json({ error: `unknown route ${req.method} ${req.path}` });
  });

  // Express error handler. Four parameters is what marks it as one, so the
  // unused `next` has to stay - hence the underscore for ESLint.
  app.use((err, req, res, _next) => {
    logger.error({ err: err.message, path: req.path }, "request failed");
    res.status(err.status ?? 500).json({ error: err.message });
  });

  logger.debug({ port: config.port, chaos: config.chaosEnabled }, "http app built");
  return app;
}
