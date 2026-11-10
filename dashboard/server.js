/**
 * The dashboard: a small aggregator that polls every node and serves one page.
 *
 * It is deliberately NOT part of the protocol. It does not gossip, it is never
 * a seed, and no node's view depends on it being up. That separation is what
 * lets it be wrong or absent without affecting the cluster - and it is why
 * every request it makes has a timeout and every failure is just a greyed-out
 * row rather than an error page.
 *
 * Same shape as src/: config from env, clocks and fetch injected, the
 * aggregation logic in a separate file that can be tested without a network.
 */

import { promises as dnsPromises } from "node:dns";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import express from "express";
import pino from "pino";

import { ClusterView } from "./aggregator.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} DashboardConfig
 * @property {number} port
 * @property {string[]} nodes          Fixed addresses to poll.
 * @property {string|null} nodeDns     Headless Service name to resolve instead.
 * @property {number} nodePort         Port to use for DNS-discovered pods.
 * @property {number} pollIntervalMs
 * @property {number} requestTimeoutMs
 * @property {string} logLevel
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {DashboardConfig}
 */
export function loadDashboardConfig(env = process.env) {
  const problems = [];

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be a port number, got "${env.PORT}"`);
  }

  // NODES is a fixed list (Compose, laptop). NODE_DNS is the Kubernetes path:
  // a headless Service name resolves to one A record per pod, so scaling the
  // StatefulSet from 5 to 10 shows up on the page without redeploying the
  // dashboard. Exactly one of them is needed.
  const nodes = (env.NODES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const nodeDns = (env.NODE_DNS ?? "").trim() || null;

  if (nodes.length === 0 && nodeDns === null) {
    problems.push("set NODES (host:port list) or NODE_DNS (headless Service name)");
  }

  const nodePort = Number(env.NODE_PORT ?? 3000);
  if (!Number.isInteger(nodePort) || nodePort < 1 || nodePort > 65535) {
    problems.push(`NODE_PORT must be a port number, got "${env.NODE_PORT}"`);
  }

  const pollIntervalMs = Number(env.POLL_INTERVAL_MS ?? 1000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) {
    problems.push(`POLL_INTERVAL_MS must be an integer >= 100, got "${env.POLL_INTERVAL_MS}"`);
  }

  // Shorter than the poll interval, so a hung node cannot make polls overlap.
  const requestTimeoutMs = Number(env.REQUEST_TIMEOUT_MS ?? 700);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 50) {
    problems.push(`REQUEST_TIMEOUT_MS must be an integer >= 50, got "${env.REQUEST_TIMEOUT_MS}"`);
  }
  if (requestTimeoutMs >= pollIntervalMs) {
    problems.push(
      `REQUEST_TIMEOUT_MS (${requestTimeoutMs}) must be < POLL_INTERVAL_MS (${pollIntervalMs})`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid dashboard configuration:\n  - ${problems.join("\n  - ")}`);
  }

  return Object.freeze({
    port,
    nodes,
    nodeDns,
    nodePort,
    pollIntervalMs,
    requestTimeoutMs,
    logLevel: env.LOG_LEVEL ?? "info",
  });
}

/**
 * Fetch one node's /members and /rumors.
 *
 * Both are requested together and the node is only counted as reachable if
 * both answer: a half-answer would show a node with members but no rumors,
 * which looks like a protocol bug rather than a slow poll.
 *
 * @param {string} address
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<import("./aggregator.js").NodeReport>}
 */
export async function pollNode(address, timeoutMs, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const [members, rumors] = await Promise.all([
      fetchImpl(`http://${address}/members`, { signal }).then((r) => r.json()),
      fetchImpl(`http://${address}/rumors`, { signal }).then((r) => r.json()),
    ]);
    return { reachable: true, members, rumors };
  } catch (err) {
    return { reachable: false, error: err.name === "TimeoutError" ? "timeout" : err.message };
  }
}

/**
 * Which addresses to poll this sweep.
 *
 * With NODE_DNS this is resolved every sweep, so a pod that appeared a second
 * ago is polled immediately - no caching here, because one lookup per second
 * from one dashboard is nothing, and being current is the entire point.
 *
 * @param {DashboardConfig} config
 * @param {(name: string) => Promise<string[]>} [resolve]
 * @returns {Promise<string[]>}
 */
export async function resolveTargets(config, resolve = (name) => dnsPromises.resolve4(name)) {
  if (!config.nodeDns) return config.nodes;

  try {
    const records = await resolve(config.nodeDns);
    const discovered = records.map((ip) => `${ip}:${config.nodePort}`);
    return [...new Set([...config.nodes, ...discovered])];
  } catch {
    // The dashboard failing to resolve says nothing about the cluster, so fall
    // back to whatever static list there is rather than showing an empty page.
    return config.nodes;
  }
}

/**
 * @param {object} deps
 * @param {DashboardConfig} deps.config
 * @param {ClusterView} deps.view
 * @param {import("pino").Logger} deps.logger
 * @param {() => number} [deps.now]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {import("express").Express}
 */
export function createDashboardServer({ config, view, logger, now = Date.now, fetchImpl = fetch }) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  /** The whole UI reads this one endpoint, once per second. */
  app.get("/api/cluster", (req, res) => {
    res.json({
      ...view.snapshot(now()),
      polling: view.polledAddresses(),
      discovery: config.nodeDns ? `DNS ${config.nodeDns}` : "static list",
      pollIntervalMs: config.pollIntervalMs,
    });
  });

  /**
   * Start a rumor from the dashboard.
   *
   * The dashboard does not originate rumors itself - it asks a node to, so the
   * rumor has a real cluster member as its origin and travels by gossip like
   * any other. The dashboard is a remote control, not a participant.
   */
  app.post("/api/broadcast", async (req, res) => {
    const payload = req.body?.payload ?? { msg: "hello from the dashboard", at: new Date(now()).toISOString() };

    const target = typeof req.body?.target === "string" && req.body.target !== ""
      ? req.body.target
      : view.reachableAddresses()[0];

    if (!target) {
      return res.status(503).json({ error: "no node is currently reachable" });
    }

    try {
      const response = await fetchImpl(`http://${target}/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      const body = await response.json();

      logger.info({ target, status: response.status }, "broadcast requested");
      return res.status(response.status).json({ target, ...body });
    } catch (err) {
      logger.warn({ target, err: err.message }, "broadcast failed");
      return res.status(502).json({ error: `broadcast to ${target} failed: ${err.message}` });
    }
  });

  /** Liveness for the dashboard itself; says nothing about the cluster. */
  app.get("/health", (req, res) => {
    res.json({ status: "ok", polling: config.nodes.length });
  });

  // Static files, served by hand rather than with express.static so there is
  // no doubt about which files are exposed: exactly these three.
  const files = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  };

  for (const [route, { file, type }] of Object.entries(files)) {
    app.get(route, (req, res, next) => {
      try {
        const path = normalize(join(HERE, "public", file));
        res.type(type).send(readFileSync(path, "utf-8"));
      } catch (err) {
        next(err);
      }
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: `unknown route ${req.method} ${req.path}` });
  });

  app.use((err, req, res, _next) => {
    logger.error({ err: err.message, path: req.path }, "dashboard request failed");
    res.status(500).json({ error: err.message });
  });

  return app;
}

/**
 * Wire everything up and start polling.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function startDashboard(env = process.env) {
  const config = loadDashboardConfig(env);
  const logger = pino({
    level: config.logLevel,
    base: { service: "dashboard" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  const view = new ClusterView();
  const app = createDashboardServer({ config, view, logger });

  /** One sweep over every node. Never throws; a dead node is just a report. */
  async function pollOnce() {
    const targets = await resolveTargets(config);
    const reports = await Promise.all(
      targets.map(async (address) => [
        address,
        await pollNode(address, config.requestTimeoutMs),
      ]),
    );
    const at = Date.now();
    for (const [address, report] of reports) view.update(address, report, at);
    // Pods that are gone for good must leave the page eventually, or a
    // 10 -> 5 scale-down would leave five permanently stale rows.
    view.forgetAddressesExcept(targets, at);
  }

  const timer = setInterval(() => {
    pollOnce().catch((err) => logger.error({ err: err.message }, "poll sweep threw"));
  }, config.pollIntervalMs);

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, nodes: config.nodes, nodeDns: config.nodeDns },
      "dashboard listening",
    );
    pollOnce().catch(() => {});
  });

  async function shutdown(reason = "shutdown") {
    logger.info({ reason }, "dashboard stopping");
    clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
  }

  return { config, logger, view, server, shutdown, pollOnce };
}

const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  try {
    const dashboard = startDashboard();
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.on(signal, () => {
        dashboard.shutdown(signal).then(() => process.exit(0));
      });
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
