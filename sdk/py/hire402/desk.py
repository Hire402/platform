"""AdvanceClient — capital desk rail (spec §8), TS SDK parity.
Explicit gas everywhere (public-RPC safety: docs/spec-pins.md)."""
from __future__ import annotations

from typing import Any

from web3 import Web3

from .abis import ADVANCED_ESCROW_ABI
from .chain import TxSender


def split_signature(sig: str) -> tuple[int, str, str]:
    """65-byte hex ECDSA signature → (v, r, s) with v ∈ {27, 28}.

    Prefix-aware (spec-pins learning 11): slicing past the 0x must re-add
    the prefix on r/s.
    """
    if sig.startswith("0x"):
        sig = sig[2:]
    if len(sig) != 130:
        raise ValueError(f"bad signature length: {len(sig)} hex chars (want 130)")
    r = "0x" + sig[:64]
    s = "0x" + sig[64:128]
    v = int(sig[128:130], 16)
    if v < 27:
        v += 27  # some signers emit 0/1
    if v not in (27, 28):
        raise ValueError(f"bad recovery id: {v}")
    return v, r, s


class AdvanceClient:
    def __init__(self, w3: Web3, sender: TxSender, address: str, token: str):
        self.w3 = w3
        self.sender = sender
        self.address = Web3.to_checksum_address(address)
        self.token = Web3.to_checksum_address(token)
        self.c = w3.eth.contract(address=self.address, abi=ADVANCED_ESCROW_ABI)
        self.account = sender.address

    # ---- rail ---------------------------------------------------------
    def accept_advance(self, escrow_id: int, principal: int, apr_bps: int,
                       offer_expiry: int, signature: str, gas: int = 400_000) -> Any:
        """Seller accepts the desk's signed AdvanceOffer."""
        v, r, s = split_signature(signature)
        return self.sender.send(
            self.c.functions.acceptAdvance(escrow_id, principal, apr_bps, offer_expiry, v, r, s),
            gas=gas)

    def repay_advance(self, escrow_id: int, amount: int, gas: int = 250_000) -> Any:
        """Voluntary direct repayment (interest-first; capped at live debt)."""
        return self.sender.send(self.c.functions.repayAdvance(escrow_id, amount), gas=gas)

    # ---- views --------------------------------------------------------
    def desk(self) -> str:
        return self.c.functions.desk().call()

    def advance_debt(self, escrow_id: int) -> int:
        return self.c.functions.advanceDebt(escrow_id).call()

    def remaining_receivables(self, escrow_id: int) -> int:
        return self.c.functions.remainingReceivables(escrow_id).call()

    def advance(self, escrow_id: int) -> dict:
        r = self.c.functions.getAdvance(escrow_id).call()
        return {"principal": r[0], "aprBps": r[1], "accruedInterestNow": r[2],
                "lastAccrual": r[3], "totalRepaid": r[4]}

    def advance_offer_digest(self, escrow_id: int, seller: str, principal: int,
                             apr_bps: int, offer_expiry: int) -> str:
        return self.c.functions.advanceOfferDigest(
            escrow_id, Web3.to_checksum_address(seller), principal, apr_bps, offer_expiry).call()