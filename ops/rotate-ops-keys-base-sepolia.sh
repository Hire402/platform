#!/usr/bin/env bash
# ============================================================================
# Hire402 — OPS KEY ROTATION (Base Sepolia). Live-service hygiene:
# generate dedicated DESK and ANCHORER keys (once), rotate the contracts
# to them (setDesk / setAnchorer — owner calls from the deployer), fund the
# anchorer for 6h-cadence anchor txs, and record everything in
# ops/deployments.base-sepolia.json. After this the deployer key signs
# nothing live; keys live in gitignored ops/data/.
# Idempotent: re-running reuses existing ops keys and just re-asserts.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
KEY_FILE="ops/data/base-sepolia-deployer.json"
OPS_FILE="ops/data/base-sepolia-ops.json"

[ -f "$KEY_FILE" ] || { echo "no deployer key at $KEY_FILE"; exit 1; }
DEPLOYER=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).address);")
PRIVKEY=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).private_key);")

ADVANCED=$(node -p "require('./ops/deployments.base-sepolia.json').advancedEscrow")
ANCHOR=$(node -p "require('./ops/deployments.base-sepolia.json').reputationAnchor")

# --- 1. Ops keys (generate once; never committed) ---
if [ ! -f "$OPS_FILE" ]; then
  echo "[ops] generating dedicated desk + anchorer keys…"
  DESK_JSON=$(cast wallet new --json)
  ANCHORER_JSON=$(cast wallet new --json)
  node -e "
const d = JSON.parse(process.argv[1]);
const a = JSON.parse(process.argv[2]);
const pick = (j) => Array.isArray(j?.data) ? j.data[0] : Array.isArray(j) ? j[0] : j;
const fs = require('fs');
fs.writeFileSync('$OPS_FILE', JSON.stringify({
  desk: { address: pick(d).address, private_key: pick(d).private_key },
  anchorer: { address: pick(a).address, private_key: pick(a).private_key },
  generatedAt: new Date().toISOString(),
}, null, 2));
" "$DESK_JSON" "$ANCHORER_JSON"
  chmod 600 "$OPS_FILE"
fi
DESK_ADDR=$(node -p "require('./$OPS_FILE').desk.address")
ANCHORER_ADDR=$(node -p "require('./$OPS_FILE').anchorer.address")
echo "[ops] desk     : $DESK_ADDR"
echo "[ops] anchorer : $ANCHORER_ADDR"

# --- 2. Rotate on-chain (owner = deployer makes two cheap calls) ---
echo "[ops] rotating desk → setDesk on $ADVANCED…"
cast send "$ADVANCED" "setDesk(address)" "$DESK_ADDR" --private-key "$PRIVKEY" --rpc-url "$RPC" > /dev/null

echo "[ops] rotating anchorer → setAnchorer on $ANCHOR…"
cast send "$ANCHOR" "setAnchorer(address)" "$ANCHORER_ADDR" --private-key "$PRIVKEY" --rpc-url "$RPC" > /dev/null

# --- 3. Fund the anchorer (needs gas for the 6h anchor cadence) ---
ANCHORER_BAL=$(cast balance "$ANCHORER_ADDR" --ether --rpc-url "$RPC")
if awk "BEGIN{exit !($ANCHORER_BAL < 0.001)}"; then
  echo "[ops] funding anchorer with 0.001 ETH (anchor cadence gas)…"
  cast send "$ANCHORER_ADDR" --value 0.001ether --private-key "$PRIVKEY" --rpc-url "$RPC" > /dev/null
fi

# --- 4. Verify + record ---
sleep 5
NEW_DESK=$(cast call "$ADVANCED" "desk()" --rpc-url "$RPC")
NEW_ANCHORER=$(cast call "$ANCHOR" "anchorer()" --rpc-url "$RPC")
echo "[ops] on-chain desk     → $NEW_DESK"
echo "[ops] on-chain anchorer → $NEW_ANCHORER"

node -e "
const fs = require('fs');
const p = 'ops/deployments.base-sepolia.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.desk = '$DESK_ADDR';
d.deskNote = 'dedicated ops key (ops/data/base-sepolia-ops.json, gitignored); signs EIP-712 AdvanceOffers; USDC float goes here';
d.anchorer = '$ANCHORER_ADDR';
d.anchorerNote = 'dedicated ops key; sends anchor() every 6h (ANCHOR_EPOCH_SECONDS); keep ≥ 0.001 ETH';
d.opsKeyRotation = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('record → ' + p);
"
echo "[ops] DONE — deployer key no longer signs live service txs"
