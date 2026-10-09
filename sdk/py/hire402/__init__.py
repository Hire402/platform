"""Hire402 SDK (Python) — TS parity for the machine-economy trust layer."""
from .chain import ANVIL_RPC, ZERO_ADDRESS, TxSender, connect, dev_key, load_deployment
from .escrow import EscrowClient
from .bond import BondClient
from .desk import AdvanceClient, split_signature
from . import eip712
from .registry import RegistryClient

__all__ = [
    "ANVIL_RPC", "ZERO_ADDRESS", "TxSender", "connect", "dev_key",
    "load_deployment", "EscrowClient", "BondClient", "AdvanceClient",
    "split_signature", "RegistryClient", "eip712",
]
