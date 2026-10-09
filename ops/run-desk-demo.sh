#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE CAPITAL DESK DEMO (local). Roadmap Phase 3 / spec §8:
# the desk advances working capital against escrowed receivables, and the
# AdvancedEscrow repays the desk FIRST at milestone release (interest-first),
# remainder to the seller. Fee untouched: still 150 bps.
#
# Boots anvil, deploys MockUSDC + Hire402Escrow + BondVault + AdvancedEscrow
# (with a funded, pre-approved desk), then runs the offer→accept→release→
# auto-repayment flow end-to-end with exact-amount assertions.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

ANVIL_PORT=8545

cleanup() {
  pkill -f "anvil --port $ANVIL_PORT" 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays
sleep 1

log() { printf '\033[1m[desk-demo]\033[0m %s\n' "$*"; }

command -v forge >/dev/null 2>&1 || { echo "forge not found" >&2; exit 1; }

log "[1/4] forge build + npm install"
(cd contracts && forge build >/dev/null)
npm install --silent --no-audit --no-fund

log "[2/4] anvil on :${ANVIL_PORT} (block-time 1s)"
anvil --port "$ANVIL_PORT" --block-time 1 > /tmp/hire402-desk-anvil.log 2>&1 &
export HIRE402_RPC="http://127.0.0.1:${ANVIL_PORT}"
for i in $(seq 1 60); do
  curl -sf -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$HIRE402_RPC" >/dev/null 2>&1 && break
  sleep 0.5
done

log "[3/4] deploy (MockUSDC, Hire402Escrow, BondVault, AdvancedEscrow + funded desk)"
npx tsx sdk/ts/scripts/deploy-dev.ts > /tmp/hire402-desk-deploy.log 2>&1

log "[4/4] the advance → auto-repayment flow"
HIRE402_RPC="$HIRE402_RPC" npx tsx examples/orchestrator/src/desk.ts
