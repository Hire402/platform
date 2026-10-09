#!/usr/bin/env bash
# ============================================================================
# Hire402 — deploy Hire402Escrow to Base Sepolia (Phase 1 testnet milestone).
#
# One command. Reads the deployer key from ops/data/base-sepolia-deployer.json
# (gitignored, chmod 600). If the deployer is unfunded, prints funding
# instructions and exits. On success, writes ops/deployments.base-sepolia.json
# (committed — addresses are public) and prints BaseScan links.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
KEY_FILE="ops/data/base-sepolia-deployer.json"
MIN_ETH="0.0005" # contract deploy + a few ops on Base Sepolia

if [ ! -f "$KEY_FILE" ]; then
  echo "No deployer key. Generate one:"
  echo "  ~/.foundry/bin/cast wallet new --json > $KEY_FILE && chmod 600 $KEY_FILE"
  exit 1
fi

DEPLOYER=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).address);")
PRIVKEY=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).private_key);")

echo "[deploy] deployer : $DEPLOYER"
echo "[deploy] rpc      : $RPC"

BAL=$(~/.foundry/bin/cast balance "$DEPLOYER" --ether --rpc-url "$RPC" 2>/dev/null || echo 0)
echo "[deploy] balance  : $BAL ETH"
if awk "BEGIN{exit !($BAL < $MIN_ETH)}"; then
  cat <<EOF

[deploy] FUNDED AMOUNT NEEDED — send ≥ $MIN_ETH Base Sepolia ETH to:

    $DEPLOYER

  Faucets (all require verification by a person — that's the point):
    • Coinbase Developer Platform: https://www.cdp.co/faucets (also drips
      1 testnet USDC/claim — needed later for the full testnet Genesis Run)
    • Superchain faucet: https://faucet.superchain.dev
    • PoW faucet (no login): https://pow.zalalena.com/base

  Then re-run: bash ops/deploy-base-sepolia.sh
EOF
  exit 1
fi

echo "[deploy] broadcasting Hire402Escrow(treasury=deployer, min=150bps, cap=300bps)…"
ESCROW_TREASURY="${ESCROW_TREASURY:-$DEPLOYER}" \
ESCROW_MIN_FEE_BPS=150 \
ESCROW_MAX_FEE_BPS=300 \
forge script contracts/script/Deploy.s.sol \
  --rpc-url "$RPC" --private-key "$PRIVKEY" --broadcast --skip-simulation

BROADCAST="broadcast/Deploy.s.sol/84532/run-latest.json"
ESCROW=$(node -e "
const j = require('./$BROADCAST');
const t = j.transactions.find((x) => x.contractAddress);
if (!t) throw new Error('no contract address in broadcast');
console.log(t.contractAddress);
")
TXHASH=$(node -e "
const j = require('./$BROADCAST');
console.log(j.transactions.find((x) => x.contractAddress).hash);
")

cat > ops/deployments.base-sepolia.json <<EOF
{
  "chainId": 84532,
  "chain": "base-sepolia",
  "rpc": "$RPC",
  "escrow": "$ESCROW",
  "deployTx": "$TXHASH",
  "treasury": "${ESCROW_TREASURY:-$DEPLOYER}",
  "arbiter": "$DEPLOYER",
  "deployer": "$DEPLOYER",
  "feeConfig": { "minFeeBps": 150, "maxFeeBps": 300 },
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "[deploy] Hire402Escrow deployed: $ESCROW"
echo "[deploy] tx  : https://sepolia.basescan.org/tx/$TXHASH"
echo "[deploy] code: https://sepolia.basescan.org/address/$ESCROW"
echo "[deploy] record → ops/deployments.base-sepolia.json"
