#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE CREDIT-SCORE DEMO (local). Spec §8's published formula,
# verified live: every input on-chain, every score exactly predictable.
#   fresh agent 575 (neutral) → clean work 850 (max) → failed delivery 776
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_PORT=8545
REGISTRY_PORT=4010

cleanup() {
  pkill -f "anvil --port $ANVIL_PORT" 2>/dev/null || true
  pkill -f 'registry/src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays
sleep 1

log() { printf '\033[1m[credit-demo]\033[0m %s\n' "$*"; }
wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[credit-demo] TIMEOUT waiting for $name" >&2
  return 1
}

command -v forge >/dev/null 2>&1 || { echo "forge not found" >&2; exit 1; }

log "[1/4] forge build + npm install"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund

log "[2/4] anvil on :${ANVIL_PORT} (auto-mine) + deploy"
anvil --port "$ANVIL_PORT" > /tmp/hire402-credit-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
npx tsx sdk/ts/scripts/deploy-dev.ts > /tmp/hire402-credit-deploy.log 2>&1
export ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
export USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")

log "[3/4] registry on :${REGISTRY_PORT}"
REGISTRY_DATA=/tmp/hire402-credit-registry.json
rm -f "$REGISTRY_DATA"
REGISTRY_DATA="$REGISTRY_DATA" REGISTRY_PORT=$REGISTRY_PORT \
  npx tsx registry/src/index.ts > /tmp/hire402-credit-registry.log 2>&1 &
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" registry || exit 1

log "[4/4] the credit run: 575 → 850 → 776"
HIRE402_RPC="$HIRE402_RPC" REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
  npx tsx examples/orchestrator/src/credit.ts
