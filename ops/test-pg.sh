#!/usr/bin/env bash
# Quick Postgres validation: starts pg + anvil + registry + python test, cleans up.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

# Start Postgres if not running
docker start hire402-pg 2>/dev/null || true
for i in $(seq 1 10); do docker exec hire402-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

# Clean strays
pkill -f 'anvil --port 8546' 2>/dev/null || true
pkill -f 'registry/src/index.ts' 2>/dev/null || true
sleep 1

# Anvil
anvil --port 8546 > /dev/null 2>&1 &
ANVIL_PID=$!
sleep 2

# Registry with Postgres
HIRE402_RPC=http://127.0.0.1:8546 \
ESCROW_ADDRESS=0x0000000000000000000000000000000000000001 \
USDC_ADDRESS=0x0000000000000000000000000000000000000002 \
REGISTRY_STORE=postgres \
DATABASE_URL=postgres://postgres:hire402@localhost:5433/hire402 \
REGISTRY_PORT=4050 \
npx tsx registry/src/index.ts > /tmp/pg-registry.log 2>&1 &
REG_PID=$!
sleep 8

# Python test (uses the port from REGISTRY_PORT)
cat > /tmp/test-pg.py << 'PYEOF'
import sys
sys.path.insert(0, 'sdk/py')
from hire402 import TxSender, connect, dev_key
from hire402.registry import RegistryClient
w3 = connect('http://127.0.0.1:8546')
sender = TxSender(w3, dev_key('genesis'))
reg = RegistryClient('http://127.0.0.1:4050', sender, w3)
r = reg.post('/v1/agents', {'address': sender.address, 'agentCardUrl': 'http://pg.example/card.json', 'x402': {'chains': ['eip155:31337'], 'assets': ['USDC']}})
print('REGISTERED:', r.get('address'))
r2 = reg.get('/v1/agents/' + sender.address)
print('READ BACK:', r2.get('address'), r2.get('status'))
print('POSTGRES VALIDATION:', 'PASS' if r2.get('address') == sender.address else 'FAIL')
PYEOF
.venv/bin/python - << 'PYEOF'
import sys
sys.path.insert(0, 'sdk/py')
from hire402 import TxSender, connect, dev_key
from hire402.registry import RegistryClient
w3 = connect('http://127.0.0.1:8546')
sender = TxSender(w3, dev_key('genesis'))
reg = RegistryClient('http://127.0.0.1:4050', sender, w3)
r = reg.post('/v1/agents', {'address': sender.address, 'agentCardUrl': 'http://pg.example/card.json', 'x402': {'chains': ['eip155:31337'], 'assets': ['USDC']}})
print('REGISTERED:', r.get('address'))
r2 = reg.get('/v1/agents/' + sender.address)
print('READ BACK:', r2.get('address'), r2.get('status'))
print('POSTGRES VALIDATION:', 'PASS' if r2.get('address', '').lower() == sender.address.lower() else 'FAIL')
PYEOF

# Cleanup
kill $REG_PID $ANVIL_PID 2>/dev/null || true
pkill -f 'anvil --port 8546' 2>/dev/null || true
pkill -f 'registry/src/index.ts' 2>/dev/null || true
docker stop hire402-pg 2>/dev/null || true
echo "VALIDATION DONE"
