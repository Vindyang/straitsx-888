#!/usr/bin/env bash
# C10 — prove agent-orchestrator cannot reach signer-service. Run FROM the
# orchestrator host (or a container on the same network as it). A refused/
# timed-out connection is success; anything that returns HTTP is a failure —
# the security claim in docs/conventions.md §2 ("Only signer-service holds key
# material, and only policy-service may reach it") depends on this being a
# network-layer fact, not a code check. Coordinate with Owner A (A15), whose
# test asserts the same boundary from the other side.
#
# Usage: ./scripts/verify-signer-isolation.sh [signer-host] [signer-port]
set -euo pipefail

SIGNER_HOST="${1:-signer}"
SIGNER_PORT="${2:-4003}"

echo "verify-signer-isolation: curling http://${SIGNER_HOST}:${SIGNER_PORT}/health from this host..."
if curl --max-time 5 --silent --show-error --fail "http://${SIGNER_HOST}:${SIGNER_PORT}/health" >/dev/null; then
  echo "FAIL: signer-service answered — the orchestrator can reach the signer. Fix the network policy."
  exit 1
else
  echo "PASS: connection to signer-service was refused/unreachable, as required."
fi
