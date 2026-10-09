"""BondVault client — TS SDK parity (spec §8). Explicit gas everywhere."""
from __future__ import annotations

from web3 import Web3

from .abis import BOND_ABI
from .chain import TxSender


class BondClient:
    def __init__(self, w3: Web3, sender: TxSender, address: str, token: str):
        self.w3 = w3
        self.sender = sender
        self.address = Web3.to_checksum_address(address)
        self.c = w3.eth.contract(address=self.address, abi=BOND_ABI)

    def stake(self, amount: int, gas: int = 150_000):
        return self.sender.send(self.c.functions.stake(amount), gas=gas)

    def unstake(self, amount: int, gas: int = 150_000):
        return self.sender.send(self.c.functions.unstake(amount), gas=gas)

    def slash(self, verifier: str, beneficiary: str, amount: int, reason: str,
              gas: int = 200_000):
        return self.sender.send(
            self.c.functions.slash(Web3.to_checksum_address(verifier),
                                   Web3.to_checksum_address(beneficiary), amount, reason),
            gas=gas)

    def stake_of(self, verifier: str) -> int:
        return self.c.functions.stakeOf(Web3.to_checksum_address(verifier)).call()

    def totals(self) -> dict:
        return {"totalStaked": self.c.functions.totalStaked().call(),
                "totalSlashed": self.c.functions.totalSlashed().call()}
