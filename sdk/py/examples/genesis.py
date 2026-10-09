"""PYTHON PARITY PROOF — the Python SDK runs the full trust loop.

1. Registers an agent with the TS registry via a PYTHON-signed EIP-712
   RegistryRequest (cross-SDK signature compatibility).
2. Creates + funds an escrow, works a milestone, submits an attestation.
3. Claims optimistically after the challenge window.
4. Asserts the exact Genesis economics: 2.00 gross → 0.03 fee, 1.97 payout.

Run against a fresh dev chain + registry (ops/run-py-genesis.sh):
    .venv/bin/python sdk/py/examples/genesis.py
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hire402 import BondClient, EscrowClient, RegistryClient, TxSender, connect, dev_key, load_deployment  # noqa: E402
from hire402.abis import ERC20_ABI  # noqa: E402
from hire402.eip712 import keccak_text  # noqa: E402
from web3 import Web3  # noqa: E402

PRICE = 2_000_000
FEE_BPS = 150
EXPECTED_FEE = PRICE * FEE_BPS // 10_000  # 0.03 USDC


def main() -> int:
    dep = load_deployment(os.environ.get("DEPLOYMENTS_FILE", "ops/deployments.local.json"))
    rpc = os.environ.get("HIRE402_RPC", "http://127.0.0.1:8545")
    registry_url = os.environ.get("REGISTRY_URL", "http://127.0.0.1:4010")
    w3 = connect(rpc)

    buyer = TxSender(w3, dev_key("buyer"))
    worker = TxSender(w3, dev_key("genesis"))
    escrow_addr = dep["escrow"]
    usdc_addr = Web3.to_checksum_address(dep["usdc"])
    bond_addr = dep.get("bond")

    usdc = w3.eth.contract(address=usdc_addr, abi=ERC20_ABI)
    escrow = EscrowClient(w3, buyer, escrow_addr, usdc_addr)

    print(f"[py    ] buyer {buyer.address} | worker {worker.address} | escrow {escrow_addr[:10]}…")

    # --- 1. Python-signed registration with the TS registry ---------------
    reg = RegistryClient(registry_url, worker, w3)
    reg.post("/v1/agents", {
        "address": worker.address,
        "agentCardUrl": "http://py-agent.example/.well-known/agent-card.json",
        "x402": {"chains": ["eip155:31337"], "assets": ["USDC"]},
    })
    reg.post("/v1/listings", {
        "unit": "task:research",
        "pricing": {"model": "milestones", "escrow": escrow_addr,
                     "milestones": [{"amount": str(PRICE), "deadlineHours": 24}]},
        "sla": {"p50Seconds": 5, "p99Seconds": 120, "uptime30d": 1.0},
    })
    print("[py    ] Python-signed registration accepted by the TS registry ✓")

    # --- 2. Escrow the work ------------------------------------------------
    w_escrow = EscrowClient(w3, worker, escrow_addr, usdc_addr)
    buyer.send(usdc.functions.approve(Web3.to_checksum_address(escrow_addr), 10_000_000), gas=120_000)
    deadline = w3.eth.get_block("latest")["timestamp"] + 3600
    escrow_id, _ = escrow.create(
        seller=worker.address, fee_bps=FEE_BPS, challenge_seconds=60,
        milestones=[(PRICE, deadline, "ipfs://py-genesis-1")],
    )
    escrow.fund(escrow_id)
    print(f"[py    ] escrow #{escrow_id} funded {PRICE / 1e6:.2f} USDC")

    # --- 3. Work: start → submit (attestation = keccak of the deliverable) -
    w_escrow.start(escrow_id)
    result = "Python SDK parity deliverable: the full trust loop, signed in Python."
    attestation = "ipfs://" + Web3.keccak(text=result).hex()[2:]
    w_escrow.submit(escrow_id, 0, attestation)
    print(f"[py    ] submitted attestation {attestation[:20]}…")

    # --- 4. Optimistic claim after the challenge window (strictly past) ---
    m = escrow.milestone(escrow_id, 0)
    window_end = m["submittedAt"] + escrow.core(escrow_id)["challengeSeconds"]
    while w3.eth.get_block("latest")["timestamp"] <= window_end:
        time.sleep(2)
    w_escrow.claim_timeout(escrow_id, 0)
    print("[py    ] claimed after the window — worker paid")

    # --- 5. Assert the exact Genesis economics -----------------------------
    worker_bal = usdc.functions.balanceOf(worker.address).call()
    totals = escrow.totals(escrow_id)
    state = escrow.core(escrow_id)["state"]

    checks = [
        ("fee captured == 150 bps", EXPECTED_FEE, totals["feesPaid"]),
        ("worker payout == 1.97", PRICE - EXPECTED_FEE, worker_bal),
        ("escrow Complete", 3, state),
    ]
    ok = True
    for name, expected, actual in checks:
        passed = expected == actual
        ok = ok and passed
        print(f"[py    ] {'✓' if passed else '✗'} {name}: expected {expected} | actual {actual}")

    # --- 6. Bond parity: read the verifier set ---------------------------
    if bond_addr:
        bond = BondClient(w3, buyer, bond_addr, usdc_addr)
        stake = bond.stake_of(dev_key("verifier") and w3.eth.account.from_key(dev_key("verifier")).address)
        print(f"[py    ] ✓ bond parity: verifier stake reads {stake} (6dp USDC)")

    print("\nPY GENESIS: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
