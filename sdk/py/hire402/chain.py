"""Hire402 SDK — the trust layer of the machine economy (Python parity).

Chain selection mirrors the TS SDK: HIRE402_CHAIN=base-sepolia selects Base
Sepolia; anything else is the local anvil chain. HIRE402_RPC must point at
the matching RPC.
"""
from __future__ import annotations

import json
import os
from typing import Any

from web3 import Web3

ANVIL_RPC = os.environ.get("HIRE402_RPC", "http://127.0.0.1:8545")

_DEV = {
    "deployer": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "buyer": "0x0000000000000000000000000000000000000000000000000000000000000b04",
    "genesis": "0x0000000000000000000000000000000000000000000000000000000000009e51",
    "provider": "0x0000000000000000000000000000000000000000000000000000000000000de5",
    "verifier": "0x0000000000000000000000000000000000000000000000000000000000000fe5",
    "bad_verifier": "0x0000000000000000000000000000000000000000000000000000000000000bad",
    "verifier2": "0x0000000000000000000000000000000000000000000000000000000000000f26",
    "verifier3": "0x0000000000000000000000000000000000000000000000000000000000000f27",
    "child": "0x0000000000000000000000000000000000000000000000000000000000005eed",
    # Phase 3: the capital desk (spec §8) — mirrors DEV.desk in the TS SDK.
    "desk": "0x000000000000000000000000000000000000000000000000000000000000de5c",
}

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def connect(rpc: str = ANVIL_RPC) -> Web3:
    w3 = Web3(Web3.HTTPProvider(rpc))
    if not w3.is_connected():
        raise ConnectionError(f"cannot connect to RPC {rpc}")
    return w3


def dev_key(name: str) -> str:
    return _DEV[name]


class TxSender:
    """Signs and sends transactions with explicit gas (public-RPC safety:
    never trust eth_estimateGas against a just-deployed contract)."""

    def __init__(self, w3: Web3, private_key: str, gas: int = 400_000):
        self.w3 = w3
        self.account = w3.eth.account.from_key(private_key)
        self.address = self.account.address
        self.gas = gas

    def send(self, fn, gas: int | None = None) -> Any:
        tx = fn.build_transaction(
            {
                "from": self.address,
                "nonce": self.w3.eth.get_transaction_count(self.address),
                "gas": gas or self.gas,
                "gasPrice": self.w3.eth.gas_price,
                "chainId": self.w3.eth.chain_id,
            }
        )
        signed = self.account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        h = self.w3.eth.send_raw_transaction(raw)
        receipt = self.w3.eth.wait_for_transaction_receipt(h)
        if receipt["status"] != 1:
            raise RuntimeError(f"transaction reverted: {h.hex()} (gas used {receipt['gasUsed']})")
        return receipt


def load_deployment(path: str = "ops/deployments.local.json") -> dict:
    with open(path) as f:
        return json.load(f)
