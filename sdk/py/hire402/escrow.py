"""Hire402Escrow client — TS SDK parity (spec §5).

The escrow id comes from the EscrowCreated event in the create receipt
(deterministic; escrowCount() reads can hit stale public-RPC backends).
Optimistic claims require chain time STRICTLY past the challenge window.
"""
from __future__ import annotations

from typing import Any

from web3 import Web3

from .abis import ESCROW_ABI
from .chain import TxSender

ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

STATE_CREATED, STATE_FUNDED, STATE_ACTIVE, STATE_COMPLETE, STATE_CANCELLED = 0, 1, 2, 3, 4
M_PENDING, M_SUBMITTED, M_APPROVED, M_RELEASED, M_DISPUTED, M_REFUNDED = 0, 1, 2, 3, 4, 5


class EscrowClient:
    def __init__(self, w3: Web3, sender: TxSender, address: str, token: str):
        self.w3 = w3
        self.sender = sender
        self.address = Web3.to_checksum_address(address)
        self.token = Web3.to_checksum_address(token)
        self.c = w3.eth.contract(address=self.address, abi=ESCROW_ABI)
        self.account = sender.address

    # ---- lifecycle ----------------------------------------------------
    def create(self, seller: str, fee_bps: int, challenge_seconds: int,
               milestones: list[tuple[int, int, str]], verifier: str = ZERO_ADDRESS,
               arbiter: str = ZERO_ADDRESS, gas: int = 800_000) -> tuple[int, Any]:
        params = (self.token, Web3.to_checksum_address(seller),
                  Web3.to_checksum_address(verifier), Web3.to_checksum_address(arbiter),
                  fee_bps, challenge_seconds,
                  [(a, d, uri) for (a, d, uri) in milestones])
        receipt = self.sender.send(self.c.functions.create(params), gas=gas)
        escrow_id = None
        for log in receipt.logs:
            if log["address"] != self.address:
                continue
            try:
                ev = self.c.events.EscrowCreated().process_log(log)
                escrow_id = ev["args"]["escrowId"]
                break
            except Exception:
                continue
        if escrow_id is None:
            raise RuntimeError("EscrowCreated event not found in create receipt")
        return escrow_id, receipt

    def fund(self, escrow_id: int, gas: int = 200_000):
        return self.sender.send(self.c.functions.fund(escrow_id), gas=gas)

    def start(self, escrow_id: int, gas: int = 120_000):
        return self.sender.send(self.c.functions.start(escrow_id), gas=gas)

    def submit(self, escrow_id: int, index: int, attestation_uri: str, gas: int = 400_000):
        return self.sender.send(self.c.functions.submit(escrow_id, index, attestation_uri), gas=gas)

    def approve(self, escrow_id: int, index: int, gas: int = 200_000):
        return self.sender.send(self.c.functions.approve(escrow_id, index), gas=gas)

    def claim_timeout(self, escrow_id: int, index: int, gas: int = 200_000):
        """Optimistic claim — only valid after the challenge window elapses."""
        zero32 = "0x" + "00" * 32
        return self.sender.send(self.c.functions.claim(escrow_id, index, 0, zero32, zero32, 0), gas=gas)

    def dispute(self, escrow_id: int, index: int, reason_uri: str, gas: int = 150_000):
        return self.sender.send(self.c.functions.dispute(escrow_id, index, reason_uri), gas=gas)

    def resolve(self, escrow_id: int, index: int, release_to_seller: bool, verdict_uri: str,
                gas: int = 200_000):
        return self.sender.send(self.c.functions.resolve(escrow_id, index, release_to_seller, verdict_uri), gas=gas)

    # ---- views --------------------------------------------------------
    def core(self, escrow_id: int) -> dict:
        r = self.c.functions.getEscrowCore(escrow_id).call()
        return {"buyer": r[0], "seller": r[1], "verifier": r[2], "arbiter": r[3],
                "token": r[4], "feeBps": r[5], "challengeSeconds": r[6], "state": r[7]}

    def totals(self, escrow_id: int) -> dict:
        r = self.c.functions.getEscrowTotals(escrow_id).call()
        return {"totalAmount": r[0], "released": r[1], "refunded": r[2],
                "feesPaid": r[3], "fundedAt": r[4]}

    def milestone(self, escrow_id: int, index: int) -> dict:
        r = self.c.functions.getMilestone(escrow_id, index).call()
        return {"amount": r[0], "deadline": r[1], "submittedAt": r[2],
                "status": r[3], "resolvedRelease": r[4]}

    def milestone_count(self, escrow_id: int) -> int:
        return self.c.functions.milestoneCount(escrow_id).call()
