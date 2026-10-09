#!/usr/bin/env bash
# ============================================================================
# Hire402 — THE GENESIS RUN on Base Sepolia (public testnet, chainId 84532).
#
#   SETTLEMENT=usdc  (default) — real CDP testnet USDC
#       (0x036CbD53842c5426634e7929541Ec2318f3dCF7e). The buyer wallet must
#       hold ≥ 2.50 testnet USDC — claim from the Coinbase CDP faucet
#       (https://www.cdp.co/faucets) to the buyer address this script prints.
#   SETTLEMENT=mock — autonomous fallback: self-deployed MockUSDC.
#
# Gas for the three agent wallets is topped up from the local deployer key.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
SETTLEMENT="${SETTLEMENT:-usdc}"
ESCROW=$(node -p "require('./ops/deployments.base-sepolia.json').escrow")
REAL_USDC="0x036CbD53842c5426634e7929541Ec2318f3dCF7e"

# dev identities (mirror sdk/ts/src/chain.ts DEV — throwaway keys)
BUYER_KEY="0x0000000000000000000000000000000000000000000000000000000000000b04"
GENESIS_KEY="0x0000000000000000000000000000000000000000000000000000000000009e51"
PROVIDER_KEY="0x0000000000000000000000000000000000000000000000000000000000000de5"
BUYER=$(cast wallet address "$BUYER_KEY")
GENESIS=$(cast wallet address "$GENESIS_KEY")
PROVIDER=$(cast wallet address "$PROVIDER_KEY")

KEY_FILE="ops/data/base-sepolia-deployer.json"
DEPLOYER_KEY=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).private_key);")

log() { printf '\033[1m[genesis-testnet]\033[0m %s\n' "$*"; }
cleanup() {
  pkill -f 'registry/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/researcher-agent/src/index.ts' 2>/dev/null || true
  pkill -f 'examples/inference-provider/src/index.ts' 2>/dev/null || true
}
trap cleanup EXIT
cleanup # pre-clean strays
sleep 1

wait_http() {
  local url="$1" logfile="$2" name="$3" i
  for i in $(seq 1 60); do
    curl -sf -m 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "[genesis-testnet] TIMEOUT waiting for $name. Log:" >&2
  tail -20 "$logfile" >&2 || true
  return 1
}

export HIRE402_RPC="$RPC" HIRE402_CHAIN=base-sepolia
export ESCROW_ADDRESS="$ESCROW"

case "$SETTLEMENT" in
  usdc) USDC="$REAL_USDC" ;;
  mock)
    if [ ! -f ops/data/testnet-mock-usdc.json ]; then
      log "deploying MockUSDC (fallback settlement asset)…"
      (cd contracts && forge build >/dev/null)
      npx tsx sdk/ts/scripts/deploy-mock-usdc-testnet.ts
    fi
    USDC=$(node -p "require('./ops/data/testnet-mock-usdc.json').usdc") ;;
  *) echo "SETTLEMENT must be 'usdc' or 'mock'" >&2; exit 1 ;;
esac
export USDC_ADDRESS="$USDC"

log "chain    : Base Sepolia ($RPC)"
log "escrow   : $ESCROW"
log "settle   : $USDC (mode=$SETTLEMENT)"
log "genesis  : $GENESIS   buyer: $BUYER   provider: $PROVIDER"

# --- gas: top up agent wallets from the deployer (sequential, receipt-waited) ---
npx tsx sdk/ts/scripts/fund-testnet-wallets.ts

# --- settlement funding for the buyer ---
# (strip cast's annotated output: `94000000 [9.4e7]` → `94000000`)
BUYER_USDC=$(cast call "$USDC" 'balanceOf(address)(uint256)' "$BUYER" --rpc-url "$RPC" | awk '{print $1}')
if awk "BEGIN{exit !($BUYER_USDC < 2500000)}"; then
  cat <<EOF

[genesis-testnet] buyer $BUYER holds $BUYER_USDC base units of USDC — needs ≥ 2500000 (2.50 USDC).

  Claim testnet USDC from the Coinbase CDP faucet (2–3 claims of 1 USDC each):
    https://www.cdp.co/faucets → faucet → USDC (Base Sepolia) → $BUYER

  Then re-run:  bash ops/run-genesis-testnet.sh
  Autonomous fallback meanwhile:  SETTLEMENT=mock bash ops/run-genesis-testnet.sh
EOF
  exit 1
fi

# --- services on the real chain (no anvil) ---
# Fresh registry data per run: the demo registry reflects THIS run's economy
# (production Phase 2 uses Postgres + a continuous indexer).
export REGISTRY_PORT=4011
export REGISTRY_DATA="ops/data/registry.testnet-$(date +%s).json"
export REGISTRY_URL=http://127.0.0.1:4011
export PROVIDER_URL=http://127.0.0.1:4211
export RESEARCHER_URL=http://127.0.0.1:4111

REGISTRY_PORT=4011 npx tsx registry/src/index.ts > /tmp/hire402-t-registry.log 2>&1 &
wait_http "http://127.0.0.1:4011/healthz" /tmp/hire402-t-registry.log registry || exit 1
PORT=4211 npx tsx examples/inference-provider/src/index.ts > /tmp/hire402-t-provider.log 2>&1 &
wait_http "http://127.0.0.1:4211/healthz" /tmp/hire402-t-provider.log provider || exit 1
PORT=4111 npx tsx examples/researcher-agent/src/index.ts > /tmp/hire402-t-researcher.log 2>&1 &
wait_http "http://127.0.0.1:4111/healthz" /tmp/hire402-t-researcher.log researcher || exit 1

log "GENESIS RUN on a public chain: zero-funded agent → earns → pays own bills → solvent"
set +e
npx tsx examples/orchestrator/src/run.ts
RUN_EXIT=$?
set -e

if [ "$RUN_EXIT" -eq 0 ]; then
  log "PASS — report in ops/reports/genesis-run-*.json (verify on https://sepolia.basescan.org)"
else
  log "FAIL — service logs:"
  for f in /tmp/hire402-t-registry.log /tmp/hire402-t-provider.log /tmp/hire402-t-researcher.log; do
    echo "--- $f (tail)"; tail -10 "$f"; done
fi
exit "$RUN_EXIT"
