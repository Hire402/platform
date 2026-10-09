#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE RESTART-RECOVERY DRILL (ops readiness). Kill the registry
# mid-epoch, keep the chain moving while it is DOWN, restart it, and prove
# the indexer resumes from its checkpoint, the anchor sequence stays
# gapless on-chain, and registry state persists. Runs a 3s anchor cadence
# (production: 6h).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_PORT=8545
REGISTRY_PORT=4010
REGISTRY_DATA=/tmp/hire402-restart-drill-registry.json
ANCHOR_EPOCH_SECONDS=3

cleanup() {
  pkill -f "anvil --port $ANVIL_PORT" 2>/dev/null || true
  pkill -f 'registry/src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays
sleep 1

log() { printf '\033[1m[drill]\033[0m %s\n' "$*"; }
wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[drill] TIMEOUT waiting for $name" >&2
  return 1
}

command -v forge >/dev/null 2>&1 || { echo "forge not found" >&2; exit 1; }

log "[1/6] forge build + npm install + anvil + deploy"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund
anvil --port "$ANVIL_PORT" > /tmp/hire402-drill-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
npx tsx sdk/ts/scripts/deploy-dev.ts > /tmp/hire402-drill-deploy.log 2>&1
export ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
export USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")
ANCHOR_ADDRESS=$(node -p "require('./ops/deployments.local.json').anchor")

start_registry() {
  REGISTRY_DATA="$REGISTRY_DATA" \
  ANCHOR_ADDRESS="$ANCHOR_ADDRESS" \
  ANCHORER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  ANCHOR_EPOCH_SECONDS="$ANCHOR_EPOCH_SECONDS" \
  REGISTRY_PORT=$REGISTRY_PORT \
    npx tsx registry/src/index.ts >> /tmp/hire402-drill-registry.log 2>&1 &
}

log "[2/6] registry up (anchor cadence ${ANCHOR_EPOCH_SECONDS}s)"
rm -f "$REGISTRY_DATA" /tmp/hire402-drill-registry.log
start_registry
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" registry || exit 1

log "[3/6] PRE: register + 2 cycles + wait for ≥2 anchored epochs"
HIRE402_RPC="$HIRE402_RPC" REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
  npx tsx examples/orchestrator/src/restartdrill.ts pre

log "[4/6] KILL the registry (SIGKILL — no graceful shutdown), keep transacting"
pkill -9 -f 'registry/src/index.ts'
sleep 2
HIRE402_RPC="$HIRE402_RPC" REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
  npx tsx examples/orchestrator/src/restartdrill.ts during

log "[5/6] RESTART the registry (same REGISTRY_DATA — checkpoint persistence)"
start_registry
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" registry || exit 1

log "[6/6] POST: indexer resumed · anchor gapless · state persisted"
HIRE402_RPC="$HIRE402_RPC" REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
  npx tsx examples/orchestrator/src/restartdrill.ts post
