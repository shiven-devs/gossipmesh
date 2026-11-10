#!/usr/bin/env bash
# Run a 5-node GossipMesh cluster on this machine, no Docker needed.
#
# Nodes listen on ports 3001-3005. Two of them (3001, 3002) act as seeds, so a
# node only needs to know a couple of fixed addresses to find everybody else -
# the same bootstrap idea Kubernetes gives us for free in Phase 7 via a
# headless Service.
#
# Usage:  npm run cluster:local            # 5 nodes, logs in logs/
#         NODES=3 npm run cluster:local    # 3 nodes
# Stop:   Ctrl+C  (every child is killed, no orphans left holding a port)

set -uo pipefail

NODES="${NODES:-5}"
BASE_PORT="${BASE_PORT:-3001}"
LOG_DIR="${LOG_DIR:-logs}"

# Two fixed seeds are enough: everything else is learned by gossip.
SEEDS="localhost:${BASE_PORT},localhost:$((BASE_PORT + 1))"

mkdir -p "$LOG_DIR"
PIDS=()

cleanup() {
  echo ""
  echo "stopping ${#PIDS[@]} node(s)..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "cluster stopped."
}
# Run cleanup on Ctrl+C, on TERM, and on normal exit, so a half-started
# cluster never leaves stray processes squatting on ports 3001-3005.
trap cleanup INT TERM EXIT

echo "starting $NODES nodes on ports $BASE_PORT..$((BASE_PORT + NODES - 1))"
echo "seeds: $SEEDS"
echo "logs:  $LOG_DIR/node-<port>.log"
echo ""

for ((i = 0; i < NODES; i++)); do
  port=$((BASE_PORT + i))

  PORT="$port" \
  HOST="localhost" \
  NODE_ID="node-$port" \
  SEEDS="$SEEDS" \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  GOSSIP_INTERVAL_MS="${GOSSIP_INTERVAL_MS:-1000}" \
  FANOUT="${FANOUT:-3}" \
    node src/index.js >"$LOG_DIR/node-$port.log" 2>&1 &

  PIDS+=("$!")
  echo "  node-$port  pid $!"
done

echo ""
echo "try:  curl -s localhost:$BASE_PORT/members | head -40"
echo "Ctrl+C to stop."
echo ""

# Wait for the children. If one dies on its own, say so instead of hanging.
wait -n 2>/dev/null || true
echo "a node exited early - check $LOG_DIR/*.log"
wait 2>/dev/null || true
