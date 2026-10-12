#!/usr/bin/env bash
# ============================================================================
# Hire402 — deploy BudgetGuard (spec §5.8) to Base Sepolia.
#
# One command. Reads the deployer key from ops/data/base-sepolia-deployer.json
# (gitignored, chmod 600). The deployer IS the holder (the account holder of
# record for this testnet pin) and sets the caps in the same broadcast.
# On success, MERGES the new fields into ops/deployments.base-sepolia.json
# (committed — addresses are public).
#
# Defaults: token = the CDP testnet USDC, escrow = the live base escrow,
# spender = the buyer agent wallet, caps 10/25/100 USDC (base units).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
KEY_FILE="ops/data/base-sepolia-deployer.json"
MIN_ETH="0.0003" # BudgetGuard is small (~4 KB bytecode)

if [ ! -f "$KEY_FILE" ]; then
  echo "No deployer key. Generate one:"
  echo "  ~/.foundry/bin/cast wallet new --json > $KEY_FILE && chmod 600 $KEY_FILE"
  exit 1
fi

DEPLOYER=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).address);")
PRIVKEY=$(node -e "const d = JSON.parse(require('fs').readFileSync('$KEY_FILE','utf8')).data; console.log((Array.isArray(d) ? d[0] : d).private_key);")
GUARD_TOKEN="${GUARD_TOKEN:-0x036CbD53842c5426634e7929541Ec2318f3dCF7e}"
GUARD_ESCROW="${GUARD_ESCROW:-0xde48e3788342c83c7d07749d377c00fa127d7aba}"
GUARD_SPENDER="${GUARD_SPENDER:-0x0E2AcEbC290a9651d55F4A8FfaB9fA48d7427DAD}"
GUARD_CAP_PER_COUNTERPARTY="${GUARD_CAP_PER_COUNTERPARTY:-10000000}"   # 10 USDC
GUARD_CAP_PER_DAY="${GUARD_CAP_PER_DAY:-25000000}"                    # 25 USDC
GUARD_CAP_TOTAL="${GUARD_CAP_TOTAL:-100000000}"                       # 100 USDC

echo "[guard] deployer : $DEPLOYER (= holder)"
echo "[guard] spender  : $GUARD_SPENDER (the agent)"
echo "[guard] token    : $GUARD_TOKEN"
echo "[guard] escrow   : $GUARD_ESCROW"
echo "[guard] caps     : $GUARD_CAP_PER_COUNTERPARTY / $GUARD_CAP_PER_DAY / $GUARD_CAP_TOTAL base units"
echo "[guard] rpc      : $RPC"

BAL=$(~/.foundry/bin/cast balance "$DEPLOYER" --ether --rpc-url "$RPC" 2>/dev/null || echo 0)
echo "[guard] balance  : $BAL ETH"
if awk "BEGIN{exit !($BAL < $MIN_ETH)}"; then
  echo
  echo "[guard] NEED ≥ $MIN_ETH Base Sepolia ETH at $DEPLOYER (faucet, then re-run)"
  exit 1
fi

echo "[guard] broadcasting BudgetGuard + setCaps…"
(cd "$ROOT/contracts" && \
 GUARD_TOKEN="$GUARD_TOKEN" \
 GUARD_ESCROW="$GUARD_ESCROW" \
 GUARD_HOLDER="$DEPLOYER" \
 GUARD_SPENDER="$GUARD_SPENDER" \
 GUARD_CAP_PER_COUNTERPARTY="$GUARD_CAP_PER_COUNTERPARTY" \
 GUARD_CAP_PER_DAY="$GUARD_CAP_PER_DAY" \
 GUARD_CAP_TOTAL="$GUARD_CAP_TOTAL" \
 forge script script/DeployBudgetGuard.s.sol \
   --rpc-url "$RPC" --private-key "$PRIVKEY" --broadcast --skip-simulation)

BROADCAST="$ROOT/contracts/broadcast/DeployBudgetGuard.s.sol/84532/run-latest.json"
GUARD=$(node -e "
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
d.budgetGuard = '$GUARD';
d.budgetGuardDeployTx = '$TXHASH';
d.budgetGuardNote = 'holder = deployer (account holder of record), spender = the buyer agent wallet, token = CDP testnet USDC, caps $GUARD_CAP_PER_COUNTERPARTY / $GUARD_CAP_PER_DAY / $GUARD_CAP_TOTAL base units (per-counterparty / per-day / total); spec 5.8';
d.generatedAt = new Date().toISOString().replace(/\\.\\d+Z\$/, 'Z');
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('record → ' + p);
"

echo "[guard] BudgetGuard deployed: $GUARD"
echo "[guard] tx  : https://sepolia.basescan.org/tx/$TXHASH"
echo "[guard] code: https://sepolia.basescan.org/address/$GUARD"
