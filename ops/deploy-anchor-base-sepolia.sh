#!/usr/bin/env bash
# ============================================================================
# Hire402 — deploy ReputationAnchor (spec §7 reputation-root anchoring) to
# Base Sepolia. One command; merges the new fields into
# ops/deployments.base-sepolia.json. The anchorer defaults to the deployer
# key — a TESTNET placeholder (the production registry operator rotates via
# setAnchorer). The contract is tiny — the default forge profile is fine.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
KEY_FILE="ops/data/base-sepolia-deployer.json"
MIN_ETH="0.0005"

if [ ! -f "$KEY_FILE" ]; then
  echo "No deployer key at $KEY_FILE (see ops/deploy-base-sepolia.sh)"; exit 1
fi

DEPLOYER=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).address);")
PRIVKEY=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).private_key);")
ANCHORER="${ANCHOR_ANCHORER:-$DEPLOYER}"

echo "[deploy] deployer : $DEPLOYER"
echo "[deploy] anchorer : $ANCHORER (testnet placeholder — rotate via setAnchorer)"
echo "[deploy] rpc      : $RPC"

BAL=$(~/.foundry/bin/cast balance "$DEPLOYER" --ether --rpc-url "$RPC" 2>/dev/null || echo 0)
echo "[deploy] balance  : $BAL ETH"
if awk "BEGIN{exit !($BAL < $MIN_ETH)}"; then
  echo "[deploy] NEED ≥ $MIN_ETH Base Sepolia ETH at $DEPLOYER"; exit 1
fi

echo "[deploy] broadcasting ReputationAnchor(anchorer=$ANCHORER)…"
(cd "$ROOT/contracts" && ANCHOR_ANCHORER="$ANCHORER" \
  forge script script/DeployAnchor.s.sol \
  --rpc-url "$RPC" --private-key "$PRIVKEY" --broadcast --skip-simulation)

BROADCAST="$ROOT/contracts/broadcast/DeployAnchor.s.sol/84532/run-latest.json"
ANCHOR_OUT=$(node -e "
const j = require('$BROADCAST');
const t = j.transactions.find((x) => x.contractAddress);
if (!t) throw new Error('no contract address in broadcast (silent mid-broadcast failure — see spec-pins 13)');
if (!t.hash) throw new Error('null tx hash — broadcast never sent (spec-pins 13)');
console.log(t.contractAddress + ' ' + t.hash);
")
ANCHOR=$(echo "$ANCHOR_OUT" | awk '{print $1}')
TXHASH=$(echo "$ANCHOR_OUT" | awk '{print $2}')

node -e "
const fs = require('fs');
const p = 'ops/deployments.base-sepolia.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.reputationAnchor = '$ANCHOR';
d.anchorDeployTx = '$TXHASH';
d.anchorNote = 'anchorer = deployer (testnet placeholder); production registry operator rotates via setAnchorer; epochs are consecutive sequence numbers anchored on a 6h cadence';
d.generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('record → ' + p);
"

echo "[deploy] ReputationAnchor deployed: $ANCHOR"
echo "[deploy] tx  : https://sepolia.basescan.org/tx/$TXHASH"
echo "[deploy] code: https://sepolia.basescan.org/address/$ANCHOR"
