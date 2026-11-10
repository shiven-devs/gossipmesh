#!/usr/bin/env bash
# scripts/local-cluster.sh - run a local GossipMesh cluster without Docker.
#
# Phase 0 placeholder. The real version (Phase 1) starts 5 nodes on ports
# 3001-3005 with env-var config and tears them all down on Ctrl+C.
# It fails loudly instead of pretending to work.
set -euo pipefail

echo "scripts/local-cluster.sh is not implemented yet (arrives in Phase 1)." >&2
echo "For now, start a single legacy node by hand:" >&2
echo "    node legacy/index.js 3001" >&2
exit 1
