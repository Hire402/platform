#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE REPUTATION-ANCHOR DEMO (local). Roadmap Phase 2.5 / spec §7:
# the registry commits a Merkle root over all self-registered agents'
# reputation aggregates ON-CHAIN every epoch (short cadence for the demo;
# production: 6h), the chain enforces the gapless sequence, and any third
# party can prove an agent's reputation against an anchored root.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_PORT=8545
REGISTRY_PORT=4010
ANCHOR_EPOCH_SECONDS="${ANCHOR_EPOCH_SECONDS:-5}" # demo cadence (production: 21600)

cleanup() {
  pkill -f "anvil --port $ANVIL_PORT" 2>/dev/null || true
  pkill -f 'registry/src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays
sleep 1

log() { printf '\033[1m[anchor-demo]\033[0m %s\n' "$*"; }
wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[anchor-demo] TIMEOUT waiting for $name" >&2
  return 1
}

command -v forge >/dev/null 2>&1 || { echo "forge not found" >&2; exit 1; }

log "[1/5] forge build + npm install"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund

log "[2/5] anvil on :${ANVIL_PORT} (auto-mine)"
anvil --port "$ANVIL_PORT" > /tmp/hire402-anchor-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

log "[3/5] deploy (… + ReputationAnchor)"
npx tsx sdk/ts/scripts/deploy-dev.ts > /tmp/hire402-anchor-deploy.log 2>&1
ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")
ANCHOR_ADDRESS=$(node -p "require('./ops/deployments.local.json').anchor")
export ESCROW_ADDRESS USDC_ADDRESS ANCHOR_ADDRESS

log "[4/5] registry on :${REGISTRY_PORT} (indexer + anchor scheduler, cadence ${ANCHOR_EPOCH_SECONDS}s)"
REGISTRY_DATA=/tmp/hire402-anchor-registry.json
rm -f "$REGISTRY_DATA"
ANCHOR_ADDRESS="$ANCHOR_ADDRESS" \
ANCHORER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
ANCHOR_EPOCH_SECONDS="$ANCHOR_EPOCH_SECONDS" \
REGISTRY_DATA="$REGISTRY_DATA" \
REGISTRY_PORT=$REGISTRY_PORT \
  npx tsx registry/src/index.ts > /tmp/hire402-anchor-registry.log 2>&1 &
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" registry || exit 1

log "[5/5] the anchoring run: cycles → epochs → proofs → gap enforcement"
HIRE402_RPC="$HIRE402_RPC" REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
  npx tsx examples/orchestrator/src/anchor.ts
