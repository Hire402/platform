#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE BOND-DECAY DEMO (local). Roadmap Phase 2 checkbox / spec §8:
# the staking requirement decays linearly with clean work (−3.6% of the
# initial requirement per clean job → 10% floor after 25 clean jobs) and a
# dispute resets the counter. All numbers derive from the continuous
# indexer's on-chain event trail via GET /v1/agents/{address}/bond.
#
# Boots anvil (auto-mine — the demo has no time-based windows), deploys,
# starts the registry, then runs 29 escrow cycles and asserts the math.
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

log() { printf '\033[1m[decay-demo]\033[0m %s\n' "$*"; }
wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[decay-demo] TIMEOUT waiting for $name" >&2
  return 1
}

command -v forge >/dev/null 2>&1 || { echo "forge not found" >&2; exit 1; }

log "[1/5] forge build + npm install"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund

log "[2/5] anvil on :${ANVIL_PORT} (auto-mine)"
anvil --port "$ANVIL_PORT" > /tmp/hire402-decay-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

log "[3/5] deploy (MockUSDC, Hire402Escrow, BondVault, AdvancedEscrow + funded desk)"
npx tsx sdk/ts/scripts/deploy-dev.ts > /tmp/hire402-decay-deploy.log 2>&1
ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")
export ESCROW_ADDRESS USDC_ADDRESS

log "[4/5] registry on :${REGISTRY_PORT} (indexer + bond endpoint)"
# Throwaway store: the JSON registry persists for restart-safety, and anvil's
# deterministic addresses make stale state actively WRONG across demo runs
# (last run's listings/events collide with this run's). Assert-exact demos
# must start from a clean ledger.
REGISTRY_DATA=/tmp/hire402-decay-registry.json
rm -f "$REGISTRY_DATA"
REGISTRY_DATA="$REGISTRY_DATA" REGISTRY_PORT=$REGISTRY_PORT npx tsx registry/src/index.ts > /tmp/hire402-decay-registry.log 2>&1 &
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" registry || exit 1

log "[5/5] the decay run: 3 clean → dispute reset → 25 clean → floor"
HIRE402_RPC="$HIRE402_RPC" REGISTRY_URL="http://127.0.0.1:${REGISTRY_PORT}" \
  npx tsx examples/orchestrator/src/bonddecay.ts
