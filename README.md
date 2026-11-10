# GossipMesh

[![CI](https://github.com/shiven-devs/gossipmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/shiven-devs/gossipmesh/actions/workflows/ci.yml)

A decentralized cluster-membership and failure-detection service built on a
push-pull gossip protocol, deployed with Docker and Kubernetes.

Nodes find each other with no central registry, decide for themselves when a
peer has stopped, announce their own departure when asked to shut down, and
spread a message to the whole cluster in a few rounds.

> Work in progress: the full README, architecture diagram and demo are Phase 10;
> this file is the working reference until then.

## Quickstart

```bash
npm ci

# 5 nodes as plain processes, ports 3001-3005
npm run cluster:local
curl -s localhost:3001/members

# 5 nodes + the dashboard, in containers
DASHBOARD_PORT=8088 docker compose up --build
open http://localhost:8088

# 3-node Kubernetes cluster (kind), 5 nodes + dashboard
kind create cluster --name gossip --config k8s/kind-config.yaml
docker compose build
kind load docker-image gossipmesh:dev gossipmesh-dashboard:dev --name gossip
kubectl apply -k k8s/
kubectl -n gossip port-forward svc/dashboard 8088:80
```

## HTTP API

Every node serves the same API on `PORT` (3000 in containers):

| Method + path | What it does |
|---|---|
| `POST /gossip` | Push-pull exchange: a peer pushes its state, both sides merge |
| `GET /members` | This node's own view, with its private verdicts and the graveyard |
| `POST /broadcast` | Start a rumor; gossip carries it to everyone |
| `GET /rumors` | What this node has heard, with hop counts |
| `GET /health` | Liveness. Deliberately says nothing about the cluster |
| `GET /ready` | Readiness: has this node actually met a peer? |
| `GET /metrics` | Prometheus text exposition |
| `POST /chaos/{partition,heal,freeze,thaw,crash}` | Fault injection, only when `CHAOS_ENABLED=true` |

## Configuration

All of it from environment variables, parsed and validated in
[src/config.js](src/config.js).

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3000`, `localhost` | Where to listen, and what to advertise |
| `NODE_ID` | `node-<port>` | Stable identity; the pod name in Kubernetes |
| `SEEDS` | — | Fixed `host:port` bootstrap list |
| `SEED_DNS` | — | Headless Service name; resolves to one address per pod |
| `GOSSIP_INTERVAL_MS` | `1000` | One round per interval |
| `FANOUT` | `3` | Peers contacted per round |
| `SUSPECT_MS` / `DEAD_MS` | `5000` / `15000` | Silence before suspect, then dead |
| `CLEANUP_MS` | `60000` | How long a tombstone is kept |
| `RUMOR_ROUNDS` | `10` | Rounds a rumor keeps being forwarded |
| `CHAOS_ENABLED` | `false` | Whether the fault-injection routes exist |

## Tests and CI

```bash
npm test        # unit + integration, including 5 nodes in one process
npm run lint
npm run e2e     # end-to-end against whatever cluster kubectl points at
```

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs four jobs:

| Job | What it proves |
|---|---|
| `test` | Lint, unit and integration tests, and an audit of production deps |
| `images` | Both images build; pushed to GHCR from `main` only |
| `e2e` | A kind cluster inside the runner, the real manifests, and the cluster's own behaviour asserted |
| `summary` | One status that is red if anything above is |

The `e2e` job is the one that earns its keep. Unit tests prove the merge rules
on a fake clock; only a cluster can prove that several processes with real DNS,
real timeouts and separate clocks converge — and that the probes and manifests
are right. It uses [k8s/overlays/ci](k8s/overlays/ci), which is the same base
manifests with 3 replicas and the thresholds scaled down, so CI cannot drift
from what gets deployed.

## Layout

```
src/            the node: config, membership, failure detector, gossiper,
                rumors, metrics, chaos, HTTP server
dashboard/      a read-only aggregator and one static page (N x N matrix)
test/           node:test suites, all on injected clocks
k8s/base/       namespace, ConfigMap, headless Service, StatefulSet,
                dashboard Deployment, PodDisruptionBudget
k8s/overlays/ci faster timings and 3 replicas, for CI
scripts/        local cluster launcher and the end-to-end check
legacy/         the tutorial code this grew out of, kept for reference
docs/           design decisions and a learning log
```

## Design notes

- **Version = `(generation, heartbeat)`**, never a wall clock. Comparing
  counters needs no agreement about what time it is; a restarted node gets a
  higher generation, so its heartbeat restarting at 0 still wins.
- **Verdicts are local and never gossiped.** A timeout describes the path
  between two nodes, not the node at the far end. If opinions travelled, one
  bad link could convince the cluster that a healthy member had died.
- **`lastSeenAt` uses a monotonic clock.** A backwards wall-clock jump would
  otherwise look like hours of silence.
- **Buried members are remembered by generation**, so stale gossip cannot
  resurrect them, while a genuinely restarted node is let back in.
- **One written-off member is re-probed each round**, or a healed partition
  would never be noticed.
- **`/health` ignores the cluster.** If it reported peers, a partition would
  make Kubernetes restart every pod on both sides.

More in [docs/design-decisions.md](docs/design-decisions.md).