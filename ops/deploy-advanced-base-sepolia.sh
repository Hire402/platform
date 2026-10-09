#!/usr/bin/env bash
# ============================================================================
# Hire402 — deploy AdvancedEscrow (capital desk rail, spec §8) to Base Sepolia.
#
# One command. Reads the deployer key from ops/data/base-sepolia-deployer.json
# (gitignored, chmod 600). On success, MERGES the new fields into
# ops/deployments.base-sepolia.json (committed — addresses are public).
#
# The desk defaults to the deployer address — a TESTNET placeholder so the
# desk key (= deployer key) can sign EIP-712 AdvanceOffers for demos.
# Production rotates to a dedicated ops key via setDesk (owner call).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
KEY_FILE="ops/data/base-sepolia-deployer.json"
MIN_ETH="0.001" # AdvancedEscrow bytecode is ~20 KB → ~4M+ gas code deposit

if [ ! -f "$KEY_FILE" ]; then
  echo "No deployer key. Generate one:"
  echo "  ~/.foundry/bin/cast wallet new --json > $KEY_FILE && chmod 600 $KEY_FILE"
  exit 1
fi

DEPLOYER=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).address);")
PRIVKEY=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).private_key);")
DESK="${ADVANCED_DESK:-$DEPLOYER}"

echo "[deploy] deployer : $DEPLOYER"
echo "[deploy] desk    : $DESK (testnet placeholder — rotate via setDesk for production)"
echo "[deploy] rpc     : $RPC"

BAL=$(~/.foundry/bin/cast balance "$DEPLOYER" --ether --rpc-url "$RPC" 2>/dev/null || echo 0)
echo "[deploy] balance : $BAL ETH"
if awk "BEGIN{exit !($BAL < $MIN_ETH)}"; then
  echo
  echo "[deploy] NEED ≥ $MIN_ETH Base Sepolia ETH at $DEPLOYER (faucet, then re-run)"
  exit 1
fi

echo "[deploy] broadcasting AdvancedEscrow(treasury=deployer, min=150bps, cap=300bps, desk=$DESK)…"
# Run forge inside contracts/ so foundry.toml profiles load (size profile:
# via-ir keeps the bytecode under EIP-170; the default build is ~26.5 KB).
(cd "$ROOT/contracts" && \
 ADV_TREASURY="$DEPLOYER" \
 ADV_MIN_FEE_BPS=150 \
 ADV_MAX_FEE_BPS=300 \
 ADV_DESK="$DESK" \
 FOUNDRY_PROFILE=size \
 forge script script/DeployAdvanced.s.sol \
   --rpc-url "$RPC" --private-key "$PRIVKEY" --broadcast --skip-simulation)

BROADCAST="$ROOT/contracts/broadcast/DeployAdvanced.s.sol/84532/run-latest.json"
ADV=$(node -e "
const j = require('$BROADCAST');
const t = j.transactions.find((x) => x.contractAddress);
if (!t) throw new Error('no contract address in broadcast');
console.log(t.contractAddress);
")
TXHASH=$(node -e "
const j = require('$BROADCAST');
console.log(j.transactions.find((x) => x.contractAddress).hash);
")

# Merge into the committed pin record (never clobber the existing entries).
node -e "
const fs = require('fs');
const p = 'ops/deployments.base-sepolia.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.advancedEscrow = '$ADV';
d.advancedDeployTx = '$TXHASH';
d.desk = '$DESK';
d.deskNote = 'testnet placeholder: desk = deployer key so it can sign EIP-712 AdvanceOffers; rotate via setDesk for production';
d.generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('record → ' + p);
"

echo "[deploy] AdvancedEscrow deployed: $ADV"
echo "[deploy] tx  : https://sepolia.basescan.org/tx/$TXHASH"
echo "[deploy] code: https://sepolia.basescan.org/address/$ADV"
