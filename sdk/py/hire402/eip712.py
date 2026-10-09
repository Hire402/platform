"""EIP-712 typed-data signing — wire-compatible with the TS SDK.

RegistryRequest(bytes payload, uint64 ts, uint256 nonce) over
keccak256(raw_body); Verdict(uint256 escrowId, uint256 milestoneIndex,
bool releaseToSeller, bytes32 proofHash, string verdictURI, uint64 ts).
"""
from __future__ import annotations

import time
from typing import Any

from eth_account.messages import encode_typed_data
from web3 import Web3

REGISTRY_SENTINEL = "0x0000000000000000000000000000000000000001"
COURT_SENTINEL = "0x0000000000000000000000000000000000000002"


def registry_domain(chain_id: int) -> dict:
    return {"name": "Hire402Registry", "version": "1",
            "chainId": chain_id, "verifyingContract": REGISTRY_SENTINEL}


def court_domain(chain_id: int) -> dict:
    return {"name": "Hire402Court", "version": "1",
            "chainId": chain_id, "verifyingContract": COURT_SENTINEL}


def _sign(sender, full_message: dict) -> str:
    # eth_account's 3-argument form: (domain_data, message_types, message_data).
    # The domain dict holds ONLY the EIP712Domain values (no nested "types").
    # The primary type is inferred from the message_types keys (minus
    # EIP712Domain) — so strip EIP712Domain from the types dict we pass.
    types = dict(full_message["types"])
    types.pop("EIP712Domain", None)
    signable = encode_typed_data(
        domain_data=full_message["domain"],
        message_types=types,
        message_data=full_message["message"],
    )
    signed = sender.account.sign_message(signable)
    return "0x" + signed.signature.hex()


def sign_registry_request(sender, chain_id: int, payload: bytes,
                           ts: int | None = None, nonce: int | None = None) -> dict:
    """Returns the auth headers for a registry mutation."""
    ts = ts or int(time.time())
    nonce = nonce or int(time.time() * 1000)
    sig = _sign(sender, {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "RegistryRequest": [
                {"name": "payload", "type": "bytes"},
                {"name": "ts", "type": "uint64"},
                {"name": "nonce", "type": "uint256"},
            ],
        },
        "primaryType": "RegistryRequest",
        "domain": registry_domain(chain_id),
        "message": {"payload": payload, "ts": ts, "nonce": nonce},
    })
    return {
        "X-Hire402-Sig": sig,
        "X-Hire402-Addr": sender.address,
        "X-Hire402-Ts": str(ts),
        "X-Hire402-Nonce": str(nonce),
    }


def sign_verdict(sender, chain_id: int, escrow_id: int, milestone_index: int,
                 release_to_seller: bool, proof_hash: str, verdict_uri: str,
                 ts: int | None = None) -> str:
    ts = ts or int(time.time())
    return _sign(sender, {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Verdict": [
                {"name": "escrowId", "type": "uint256"},
                {"name": "milestoneIndex", "type": "uint256"},
                {"name": "releaseToSeller", "type": "bool"},
                {"name": "proofHash", "type": "bytes32"},
                {"name": "verdictURI", "type": "string"},
                {"name": "ts", "type": "uint64"},
            ],
        },
        "primaryType": "Verdict",
        "domain": court_domain(chain_id),
        "message": {
            "escrowId": escrow_id,
            "milestoneIndex": milestone_index,
            "releaseToSeller": release_to_seller,
            "proofHash": proof_hash,
            "verdictURI": verdict_uri,
            "ts": ts,
        },
    })


def keccak_text(text: str) -> bytes:
    return Web3.keccak(text=text)


def advanced_domain(chain_id: int, verifying_contract: str) -> dict:
    """EIP-712 domain for AdvancedEscrow advance offers (spec §8)."""
    return {"name": "Hire402AdvancedEscrow", "version": "1",
            "chainId": chain_id, "verifyingContract": verifying_contract}


def sign_advance_offer(sender, chain_id: int, verifying_contract: str, escrow_id: int,
                       seller: str, principal: int, apr_bps: int, offer_expiry: int) -> str:
    """The desk signs an advance offer off-chain (gas-free for the desk)."""
    return _sign(sender, {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "AdvanceOffer": [
                {"name": "escrowId", "type": "uint256"},
                {"name": "seller", "type": "address"},
                {"name": "principal", "type": "uint256"},
                {"name": "aprBps", "type": "uint16"},
                {"name": "offerExpiry", "type": "uint64"},
            ],
        },
        "primaryType": "AdvanceOffer",
        "domain": advanced_domain(chain_id, verifying_contract),
        "message": {
            "escrowId": escrow_id,
            "seller": seller,
            "principal": principal,
            "aprBps": apr_bps,
            "offerExpiry": offer_expiry,
        },
    })
