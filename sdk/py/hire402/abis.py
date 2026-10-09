"""Contract ABIs — generated from forge artifacts by scripts/sync_abis.py.

Regenerate after any contract change:
    .venv/bin/python sdk/py/scripts/sync_abis.py
"""
from __future__ import annotations

ESCROW_ABI: list = []  # populated below by _load()
BOND_ABI: list = []
ADVANCED_ESCROW_ABI: list = []
ERC20_ABI: list = []


def _load() -> None:  # pragma: no cover - executed at import time
    import json
    import os

    root = os.environ.get("HIRE402_REPO_ROOT")
    if not root:
        # walk up from this file looking for contracts/out
        d = os.path.dirname(os.path.abspath(__file__))
        for _ in range(6):
            if os.path.isdir(os.path.join(d, "contracts", "out")):
                root = d
                break
            d = os.path.dirname(d)
    if not root:
        return

    def read(rel: str) -> list | None:
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return json.load(f)["abi"]

    escrow = read(os.path.join("contracts", "out", "Hire402Escrow.sol", "Hire402Escrow.json"))
    advanced = read(os.path.join("contracts", "out", "AdvancedEscrow.sol", "AdvancedEscrow.json"))
    bond = read(os.path.join("contracts", "out", "BondVault.sol", "BondVault.json"))
    usdc = read(os.path.join("contracts", "out", "MockUSDC.sol", "MockUSDC.json"))
    if escrow:
        ESCROW_ABI.extend(escrow)
    if advanced:
        ADVANCED_ESCROW_ABI.extend(advanced)
    if bond:
        BOND_ABI.extend(bond)
    if usdc:
        # Minimal ERC-20 surface (symbol/decimals/balanceOf/approve/transfer + Transfer event)
        ERC20_ABI.extend(
            [
                {"inputs": [], "stateMutability": "view", "type": "function", "name": "symbol", "outputs": [{"name": "", "type": "string", "internalType": "string"}]},
                {"inputs": [], "stateMutability": "view", "type": "function", "name": "decimals", "outputs": [{"name": "", "type": "uint8", "internalType": "uint8"}]},
                {"inputs": [{"name": "account", "type": "address", "internalType": "address"}], "stateMutability": "view", "type": "function", "name": "balanceOf", "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}]},
                {"inputs": [{"name": "spender", "type": "address", "internalType": "address"}, {"name": "amount", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable", "type": "function", "name": "approve", "outputs": [{"name": "", "type": "bool", "internalType": "bool"}]},
                {"inputs": [{"name": "to", "type": "address", "internalType": "address"}, {"name": "amount", "type": "uint256", "internalType": "uint256"}], "stateMutability": "nonpayable", "type": "function", "name": "transfer", "outputs": [{"name": "", "type": "bool", "internalType": "bool"}]},
                {"anonymous": False, "inputs": [{"indexed": True, "name": "from", "type": "address", "internalType": "address"}, {"indexed": True, "name": "to", "type": "address", "internalType": "address"}, {"indexed": False, "name": "value", "type": "uint256", "internalType": "uint256"}], "name": "Transfer", "type": "event"},
            ]
        )


_load()
