#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE DISPUTE DEMO (local). Roadmap Phase 2 acceptance §3:
# a bad verifier is slashed end-to-end in a scripted meta-dispute.
#
# Boots anvil, deploys MockUSDC + Hire402Escrow + BondVault, starts the
# registry, genesis researcher, coder, court, and verifier — then runs the
# disputed-task flow with a scripted incorrect verdict that gets slashed.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_PORT=8545
REGISTRY_PORT=4010
RESEARCHER_PORT=4110
CODER_PORT=4120
COURT_PORT=4130
VERIFIER_PORT=4140

cleanup() {
  pkill -f "anvil --port $ANVIL_PORT" 2>/dev/null || true
  pkill -f 'registry/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/researcher-agent/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/coder-agent/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/court/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/verifier-agent/src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays
sleep 1

log() { printf '\033[1m[dispute]\033[0m %s\n' "$*"; }
wait_http() {
  local url="$1" logfile="$2" name="$3" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[dispute] TIMEOUT waiting for $name. Log:" >&2
  tail -20 "$logfile" >&2 || true
  return 1
}

command -v forge >/dev/null 2>&1 || { echo "forge not found" >&2; exit 1; }

log "[1/8] forge build + npm install"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund

log "[2/8] anvil on :${ANVIL_PORT} (block-time 1s)"
anvil --port "$ANVIL_PORT" --block-time 1 > /tmp/hire402-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

log "[3/8] deploy MockUSDC + Hire402Escrow + BondVault + grants"
npx tsx sdk/ts/scripts/deploy-dev.ts
ESCROW_ADDRESS=$(node -p "require('./ops/deployments.local.json').escrow")
USDC_ADDRESS=$(node -p "require('./ops/deployments.local.json').usdc")
BOND_ADDRESS=$(node -p "require('./ops/deployments.local.json').bond")
export ESCROW_ADDRESS USDC_ADDRESS BOND_ADDRESS

log "[4/8] registry :${REGISTRY_PORT} + researcher :${RESEARCHER_PORT} + coder :${CODER_PORT} + child :4121"
REGISTRY_PORT=$REGISTRY_PORT npx tsx registry/src/index.ts > /tmp/hire402-registry.log 2>&1 &
wait_http "http://127.0.0.1:${REGISTRY_PORT}/healthz" /tmp/hire402-registry.log registry || exit 1
PORT=$RESEARCHER_PORT npx tsx examples/researcher-agent/src/index.ts > /tmp/hire402-researcher.log 2>&1 &
wait_http "http://127.0.0.1:${RESEARCHER_PORT}/healthz" /tmp/hire402-researcher.log researcher || exit 1
PORT=$CODER_PORT CODER_KEY=0x000000000000000000000000000000000000000000000000000000000000c0de npx tsx examples/coder-agent/src/index.ts > /tmp/hire402-coder.log 2>&1 &
wait_http "http://127.0.0.1:${CODER_PORT}/healthz" /tmp/hire402-coder.log coder || exit 1
GENESIS_ADDRESS=$(cast wallet address 0x0000000000000000000000000000000000000000000000000000000000009e51)
PORT=4121 CODER_KEY=0x0000000000000000000000000000000000000000000000000000000000005eed TASK_PRICE=1400000 AGENT_PARENT=$GENESIS_ADDRESS npx tsx examples/coder-agent/src/index.ts > /tmp/hire402-child.log 2>&1 &
wait_http "http://127.0.0.1:4121/healthz" /tmp/hire402-child.log child || exit 1

log "[5/8] court :${COURT_PORT} + jury of 3 verifiers :4140-4142"
PORT=$COURT_PORT COURT_VERDICT_WINDOW_MS=10000 npx tsx examples/court/src/index.ts > /tmp/hire402-court.log 2>&1 &
wait_http "http://127.0.0.1:${COURT_PORT}/healthz" /tmp/hire402-court.log court || exit 1
PORT=4140 VERIFIER_KEY=0x0000000000000000000000000000000000000000000000000000000000000fe5 npx tsx examples/verifier-agent/src/index.ts > /tmp/hire402-verifier.log 2>&1 &
wait_http "http://127.0.0.1:4140/healthz" /tmp/hire402-verifier.log verifier1 || exit 1
PORT=4141 VERIFIER_KEY=0x0000000000000000000000000000000000000000000000000000000000000f26 npx tsx examples/verifier-agent/src/index.ts > /tmp/hire402-verifier2.log 2>&1 &
wait_http "http://127.0.0.1:4141/healthz" /tmp/hire402-verifier2.log verifier2 || exit 1
PORT=4142 VERIFIER_KEY=0x0000000000000000000000000000000000000000000000000000000000000f27 npx tsx examples/verifier-agent/src/index.ts > /tmp/hire402-verifier3.log 2>&1 &
wait_http "http://127.0.0.1:4142/healthz" /tmp/hire402-verifier3.log verifier3 || exit 1

log "[6/8] order book: scripted 200-order never-crossed test"
npx tsx market/scripts/test-book.ts

log "[7/8] DISPUTE RUN: escrow → dispute → bad verdict → jury → resolve → SLASH"
set +e
npx tsx examples/orchestrator/src/dispute.ts
RUN_EXIT=$?
set -e

if [ "$RUN_EXIT" -eq 0 ]; then
  log "PASS — dispute report in ops/reports/dispute-run-*.json"
else
  log "FAIL — service logs:"
  for f in /tmp/hire402-registry.log /tmp/hire402-researcher.log /tmp/hire402-court.log /tmp/hire402-verifier.log /tmp/hire402-verifier2.log /tmp/hire402-verifier3.log; do
    echo "--- $f (tail)"; tail -10 "$f"; done
fi

# ---------------------------------------------------------------------------
# Phase 2.5: SPAWN — reproduction with capital allocation (runs after the
# dispute leaves the parent solvent). Independent exit code.
# ---------------------------------------------------------------------------
if [ "$RUN_EXIT" -eq 0 ]; then
  log "[8/8] SPAWN RUN: parent seeds child → child works → child repays"
  set +e
  npx tsx examples/orchestrator/src/spawn.ts
  SPAWN_EXIT=$?
  set -e
  if [ "$SPAWN_EXIT" -eq 0 ]; then
    log "PASS — spawn report in ops/reports/spawn-run-*.json"
  else
    log "FAIL — child log:"
    tail -10 /tmp/hire402-child.log
  fi
  exit "$SPAWN_EXIT"
fi
exit "$RUN_EXIT"
