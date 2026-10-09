#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE GENESIS RUN (local). docs/roadmap.md §2.
#
# Boots a local EVM (anvil), deploys MockUSDC + Hire402Escrow, starts the
# registry, the inference provider, and the genesis agent — then runs the
# flagship demo: a zero-funded agent earns its first USDC doing work for
# another agent, pays its own inference bill, and ends the run SOLVENT.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_PORT=8545
REGISTRY_PORT=4010
RESEARCHER_PORT=4110
PROVIDER_PORT=4210

PIDS=()
# Kill by command pattern: `npx tsx` wrappers spawn node children that
# survive a wrapper-kill, so pattern-matching is the reliable cleanup.
cleanup() {
  pkill -f "anvil --port $ANVIL_PORT" 2>/dev/null || true
  pkill -f 'registry/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/researcher-agent/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/inference-provider/src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays from previous runs
sleep 1

log() { printf '\033[1m[genesis]\033[0m %s\n' "$*"; }

# Bounded HTTP wait — fails fast and dumps the service log on timeout.
wait_http() {
  local url="$1" logfile="$2" name="$3" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[genesis] TIMEOUT waiting for $name ($url). Log:" >&2
  tail -20 "$logfile" >&2 || true
  return 1
}

command -v forge >/dev/null 2>&1 || { echo "forge not found — install foundry first" >&2; exit 1; }
command -v npx  >/dev/null 2>&1 || { echo "npx not found" >&2; exit 1; }

log "[1/7] forge build"
(cd contracts && forge build >/dev/null)

log "[2/7] npm install"
npm install --silent --no-audit --no-fund

log "[3/7] anvil on :${ANVIL_PORT} (block-time 1s — chain time advances while idle)"
anvil --port "$ANVIL_PORT" --block-time 1 > /tmp/hire402-anvil.log 2>&1 &
PIDS+=($!)
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf -m 2 -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "$HIRE402_RPC" >/dev/null || { echo "anvil did not come up"; tail -20 /tmp/hire402-anvil.log; exit 1; }

log "[4/7] deploy MockUSDC + Hire402Escrow (fee 150 bps, cap 300)"
npx tsx sdk/ts/scripts/deploy-dev.ts
ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")
export ESCROW_ADDRESS USDC_ADDRESS

log "[5/7] registry on :${REGISTRY_PORT}"
REGISTRY_PORT="$REGISTRY_PORT" npx tsx registry/src/index.ts > /tmp/hire402-registry.log 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" /tmp/hire402-registry.log registry || exit 1

log "[6/7] agents: inference provider :${PROVIDER_PORT}, genesis researcher :${RESEARCHER_PORT}"
PORT="$PROVIDER_PORT" npx tsx examples/inference-provider/src/index.ts > /tmp/hire402-provider.log 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:${PROVIDER_PORT}/healthz" /tmp/hire402-provider.log provider || exit 1
PORT="$RESEARCHER_PORT" npx tsx examples/researcher-agent/src/index.ts > /tmp/hire402-researcher.log 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:${RESEARCHER_PORT}/healthz" /tmp/hire402-researcher.log researcher || exit 1

log "[7/7] GENESIS RUN: zero-funded agent → earns → pays own bills → solvent"
set +e
npx tsx examples/orchestrator/src/run.ts
RUN_EXIT=$?
set -e

if [ "$RUN_EXIT" -eq 0 ]; then
  log "PASS — report in ops/reports/genesis-run-*.json"
else
  log "FAIL — service logs:"
  for f in /tmp/hire402-registry.log /tmp/hire402-provider.log /tmp/hire402-researcher.log; do
    echo "--- $f (tail)"; tail -10 "$f"; done
fi
exit "$RUN_EXIT"
