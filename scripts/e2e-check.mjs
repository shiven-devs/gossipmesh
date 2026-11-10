/**
 * End-to-end check against a real Kubernetes cluster.
 *
 * The same script runs in CI and on a laptop, which is the point: a CI job
 * that tests something slightly different from what you run locally is a job
 * whose failures you learn to ignore.
 *
 * It asserts the four claims this project actually makes, each against a
 * freshly observed cluster rather than a mock:
 *
 *   1. every node discovers every other node (convergence)
 *   2. a crashed node is detected without anyone being told (failure detection)
 *   3. the crashed node is readmitted with a higher generation (restart)
 *   4. a message broadcast on one node reaches them all (rumor spread)
 *
 * Everything is reached with `kubectl exec ... wget`, so nothing has to be
 * published outside the cluster and the script needs no dependencies.
 *
 * Usage:
 *   node scripts/e2e-check.mjs
 *   NAMESPACE=gossip EXPECT_NODES=3 TIMEOUT_MS=60000 node scripts/e2e-check.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const NAMESPACE = process.env.NAMESPACE ?? "gossip";
const EXPECT_NODES = Number(process.env.EXPECT_NODES ?? 0); // 0 = however many exist
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 90_000);
// One second, not 500 ms: each probe is a `kubectl exec` (a process launch and
// a round trip), and polling three pods twice a second starves the thing being
// measured - the first version of this script failed convergence purely
// because its own polling was timing out.
const STEP_MS = Number(process.env.STEP_MS ?? 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
let checks = 0;

/** kubectl errors are many lines of stack; only the first line is useful here. */
const firstLine = (message) => String(message).split(/\r?\n/)[0];

/** @param {string[]} args */
async function kubectl(...args) {
  const { stdout } = await run("kubectl", ["-n", NAMESPACE, ...args], { maxBuffer: 1 << 26 });
  return stdout;
}

/** HTTP from inside the cluster: no Service, no port-forward, no ingress. */
let lastProbeError = null;

async function fromPod(pod, method, path, body) {
  const args = ["exec", pod, "--", "wget", "-qO-"];
  if (method === "POST") {
    args.push("--header=Content-Type: application/json", `--post-data=${JSON.stringify(body ?? {})}`);
  }
  args.push(`http://127.0.0.1:3000${path}`);

  try {
    return JSON.parse(await kubectl(...args));
  } catch (err) {
    // Remembered rather than swallowed: a probe that cannot reach a pod and a
    // cluster that has not converged are completely different problems, and
    // "still false after 60 s" does not tell them apart.
    lastProbeError = `${pod} ${method} ${path}: ${firstLine(err.message)}`;
    return null;
  }
}

async function nodePods() {
  const out = await kubectl(
    "get", "pods",
    "-l", "app.kubernetes.io/component=node",
    "--field-selector", "status.phase=Running",
    "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}",
  );
  return out.trim().split("\n").filter(Boolean).sort();
}

/**
 * Poll until `predicate` holds, and report how long it took. Polling rather
 * than sleeping a fixed amount means the log records the real timing instead
 * of hiding it behind a generous wait.
 *
 * @param {string} what
 * @param {() => Promise<boolean>} predicate
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {() => Promise<string>} [options.describe] What to print if it never
 *   became true. Without this a timeout is undiagnosable after the cluster is
 *   gone, which in CI is always.
 */
async function waitFor(what, predicate, { timeoutMs = TIMEOUT_MS, describe } = {}) {
  const started = Date.now();
  lastProbeError = null;

  for (;;) {
    let ok = false;
    let thrown = null;
    try {
      ok = await predicate();
    } catch (err) {
      thrown = err;
    }

    const elapsed = Date.now() - started;
    if (ok) return pass(what, elapsed);

    if (elapsed > timeoutMs) {
      const detail = [];
      if (thrown) detail.push(`threw: ${firstLine(thrown.message)}`);
      if (lastProbeError) detail.push(`last probe error: ${lastProbeError}`);
      if (describe) {
        try { detail.push(`observed: ${await describe()}`); }
        catch (err) { detail.push(`observed: <could not read: ${firstLine(err.message)}>`); }
      }
      return fail(`${what} after ${elapsed} ms${detail.length ? ` - ${detail.join("; ")}` : ""}`, elapsed);
    }

    await sleep(STEP_MS);
  }
}

function pass(what, elapsed) {
  checks += 1;
  console.log(`  PASS  ${what} (${elapsed} ms)`);
  return true;
}

function fail(what, elapsed) {
  checks += 1;
  failures.push(what);
  console.log(`  FAIL  ${what}${elapsed === undefined ? "" : ` (${elapsed} ms)`}`);
  return false;
}

const entryOf = (view, id) => view?.members.find((m) => m.id === id);

// --------------------------------------------------------------------------

console.log(`e2e: namespace=${NAMESPACE} timeout=${TIMEOUT_MS}ms`);

const pods = await nodePods();
console.log(`e2e: pods = ${pods.join(" ") || "(none)"}`);

if (pods.length === 0) {
  console.error("e2e: no running gossip pods found - nothing to check");
  process.exit(1);
}
if (EXPECT_NODES > 0 && pods.length !== EXPECT_NODES) {
  console.error(`e2e: expected ${EXPECT_NODES} pods, found ${pods.length}`);
  process.exit(1);
}

const expected = pods.length;

console.log("\n1. convergence: every node knows every node");
{
  // "Every running pod is known and alive on every running pod" - not
  // "members.length === N". A member list may legitimately still hold a
  // tombstone for a pod that was scaled away minutes ago, and that is not a
  // convergence failure.
  const converged = (view) =>
    view !== null &&
    pods.every((id) => entryOf(view, id)?.localStatus === "alive");

  await waitFor(
    `every one of the ${expected} pods sees all ${expected} as alive`,
    async () => {
      const views = await Promise.all(pods.map((pod) => fromPod(pod, "GET", "/members")));
      return views.every(converged);
    },
    {
      describe: async () => {
        const views = await Promise.all(pods.map((pod) => fromPod(pod, "GET", "/members")));
        return views
          .map((view, i) =>
            view === null
              ? `${pods[i]}=unreachable`
              : `${pods[i]}=[${view.members.map((m) => `${m.id}:${m.localStatus}`).join(",")}]`,
          )
          .join(" ");
      },
    },
  );
}

console.log("\n2. local-only state never travels");
{
  const wire = await fromPod(pods[0], "POST", "/gossip", {
    from: { id: "e2e-probe", address: "127.0.0.1:1" },
    members: [],
  });
  const leaked = (wire?.members ?? []).filter((m) => "lastSeenAt" in m || "localStatus" in m);
  if (wire === null) fail("POST /gossip answered");
  else if (leaked.length > 0) fail(`lastSeenAt/localStatus leaked onto the wire (${leaked.length})`);
  else pass("neither lastSeenAt nor localStatus appears on the wire", 0);
}

console.log("\n3. rumor spread: one broadcast reaches every node");
{
  const started = await fromPod(pods[0], "POST", "/broadcast", { payload: { e2e: Date.now() } });
  const rumorId = started?.rumor?.id;

  if (!rumorId) {
    fail("POST /broadcast returned a rumor");
  } else {
    await waitFor(`rumor ${rumorId.slice(0, 8)} reaches all ${expected} nodes`, async () => {
      const views = await Promise.all(pods.map((pod) => fromPod(pod, "GET", "/rumors")));
      return views.every((view) => view?.rumors.some((r) => r.id === rumorId));
    });
  }
}

console.log("\n4. failure detection: silence alone is enough, and reversible");
{
  const victim = pods.at(-1);
  const survivors = pods.slice(0, -1);

  // Freeze, not crash. /chaos/freeze stops the gossip loop while the process
  // keeps answering HTTP, so to its peers it is indistinguishable from a dead
  // node - but the kubelet does not restart it. Crashing here would race the
  // restart: with CI's DEAD_MS the pod is often back before anyone could have
  // said "dead", and the check would fail for a reason that is not a bug.
  await fromPod(victim, "POST", "/chaos/freeze", {});

  await waitFor(
    `every survivor marks the frozen ${victim} dead`,
    async () => {
      const views = await Promise.all(survivors.map((pod) => fromPod(pod, "GET", "/members")));
      return views.every((view) => entryOf(view, victim)?.localStatus === "dead");
    },
    {
      describe: async () => {
        const views = await Promise.all(survivors.map((pod) => fromPod(pod, "GET", "/members")));
        return views
          .map((v, i) => `${survivors[i]} sees ${victim}=${entryOf(v, victim)?.localStatus ?? "absent"}`)
          .join(" ");
      },
    },
  );

  // Its own gossiped status still reads "alive": nobody asked it, and it never
  // said otherwise. That is the whole graceful-vs-failure distinction, and the
  // reason verdicts are local and never gossiped.
  const during = await fromPod(survivors[0], "GET", "/members");
  const gossipedStatus = entryOf(during, victim)?.status;
  if (gossipedStatus === "alive") {
    pass(`${victim} is dead by local verdict while its own status still says "alive"`, 0);
  } else {
    fail(`expected gossiped status "alive" for a silent node, got "${gossipedStatus}"`);
  }

  // And a verdict is an opinion, not a fact: one newer heartbeat clears it.
  await fromPod(victim, "POST", "/chaos/thaw", {});
  await waitFor(
    `thawing ${victim} clears the verdict everywhere`,
    async () => {
      const views = await Promise.all(survivors.map((pod) => fromPod(pod, "GET", "/members")));
      return views.every((view) => entryOf(view, victim)?.localStatus === "alive");
    },
  );
}

console.log("\n5. restart: a crash comes back with a higher generation");
{
  const victim = pods[0];
  const observer = pods[1] ?? pods[0];
  const before = await fromPod(observer, "GET", "/members");
  const oldGeneration = entryOf(before, victim)?.generation;

  // /chaos/crash exits without running the SIGTERM handler, so there is no
  // goodbye - exactly what a real crash looks like. `kubectl delete pod` would
  // NOT do this: it is graceful, and the node would report "left".
  await fromPod(victim, "POST", "/chaos/crash", {});

  await waitFor(
    `${victim} is readmitted with a generation above ${oldGeneration}`,
    async () => {
      const view = await fromPod(observer, "GET", "/members");
      const entry = entryOf(view, victim);
      return (
        entry !== undefined &&
        entry.localStatus === "alive" &&
        oldGeneration !== undefined &&
        entry.generation > oldGeneration
      );
    },
    {
      describe: async () => {
        const view = await fromPod(observer, "GET", "/members");
        const entry = entryOf(view, victim);
        return entry
          ? `${victim} generation=${entry.generation} localStatus=${entry.localStatus}`
          : `${victim} absent from ${observer}'s list`;
      },
    },
  );
}

console.log("\n6. the dashboard sees the cluster too");
{
  const dashboard = (
    await kubectl(
      "get", "pods",
      "-l", "app.kubernetes.io/component=dashboard",
      "-o", "jsonpath={.items[0].metadata.name}",
    )
  ).trim();

  if (!dashboard) {
    fail("a dashboard pod exists");
  } else {
    await waitFor("the dashboard reports every node, with no disagreement", async () => {
      const out = await kubectl("exec", dashboard, "--", "wget", "-qO-",
        "http://127.0.0.1:8080/api/cluster");
      const snapshot = JSON.parse(out);
      return (
        snapshot.rows.length === expected &&
        snapshot.summary.observersReachable === expected &&
        snapshot.summary.disagreements === 0
      );
    });
  }
}

console.log(`\ne2e: ${checks - failures.length}/${checks} checks passed`);

if (failures.length > 0) {
  console.error("\ne2e FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("e2e OK");
