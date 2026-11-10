/**
 * Logging: pino, JSON, with nodeId stamped on every line.
 *
 * Replaces the console.log calls in legacy/index.js. Inside Kubernetes you
 * read logs with `kubectl logs`, and with 5-20 pods the only way to tell who
 * said what is a machine-readable field on every line - which is also what
 * lets you grep or pipe them into a log tool later.
 */

import pino from "pino";

/**
 * @param {{nodeId: string, logLevel?: string}} options
 * @returns {import("pino").Logger}
 */
export function createLogger({ nodeId, logLevel = "info" }) {
  return pino({
    level: logLevel,
    // `base` replaces pino's default pid/hostname fields. Inside a container
    // the pid is always 1 and the hostname is the pod name, so nodeId is the
    // only identifier worth carrying.
    base: { nodeId },
    // Human-readable ISO timestamps instead of epoch millis, because these
    // logs get read by a person during the demo.
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
