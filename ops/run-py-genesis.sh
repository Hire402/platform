#!/usr/bin/env bash
# ============================================================================
# Hire402 — PYTHON SDK PARITY RUN (local).
# Boots anvil + deploys via the TS toolchain, starts the TS registry, then
# runs the Python genesis: a Python-signed registration + full escrow cycle
# with assertions. Proves cross-SDK EIP-712 compatibility.
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
cleanup
sleep 1

log() { printf '\033[1m[py-run]\033[0m %s\n' "$*"; }
wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[py-run] TIMEOUT waiting for $name" >&2
  return 1
}

log "[1/5] forge build + npm install + venv"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install --quiet web3 >/dev/null 2>&1
fi

log "[2/5] anvil on :${ANVIL_PORT} (block-time 1s)"
anvil --port "$ANVIL_PORT" --block-time 1 > /tmp/hire402-py-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

log "[3/5] deploy (TS toolchain)"
npx tsx sdk/ts/scripts/deploy-dev.ts >/dev/null
ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")
export ESCROW_ADDRESS USDC_ADDRESS

log "[4/5] TS registry on :${REGISTRY_PORT}"
REGISTRY_PORT=$REGISTRY_PORT npx tsx registry/src/index.ts > /tmp/hire402-py-registry.log 2>&1 &
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" registry || exit 1

log "[5/6] PYTHON GENESIS: python-signed registration + escrow cycle + assertions"
set +e
.venv/bin/python sdk/py/examples/genesis.py
RUN_EXIT=$?
set -e

log "[6/6] PYTHON DESK PARITY: python-signed AdvanceOffer + desk-first repayment"
set +e
.venv/bin/python sdk/py/examples/desk.py
DESK_EXIT=$?
set -e

if [ "$RUN_EXIT" -eq 0 ] && [ "$DESK_EXIT" -eq 0 ]; then
  log "PASS — Python SDK parity proven (cross-SDK EIP-712 + escrow loop + capital desk rail)"
else
  log "FAIL — registry log:"; tail -10 /tmp/hire402-py-registry.log
fi
if [ "$RUN_EXIT" -ne 0 ] || [ "$DESK_EXIT" -ne 0 ]; then
  exit 1
fi
exit 0
