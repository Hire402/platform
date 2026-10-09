"""PYTHON DESK PARITY PROOF — the capital desk rail speaks Python too (spec §8).

1. Buyer funds a two-milestone escrow against the on-chain AdvancedEscrow.
2. The DESK signs an AdvanceOffer with PYTHON EIP-712 — accepted by the
   on-chain verifier (the contract is the neutral cross-SDK judge).
3. One year passes (deterministic anvil time jump): interest = 0.048 exact.
4. Release: fee → treasury (150 bps untouched), desk repaid FIRST
   (0.80 principal + 0.048 interest), remainder → seller.
5. Second milestone releases plainly; escrow Complete.

Run via ops/run-py-genesis.sh (step 6/6):
    .venv/bin/python sdk/py/examples/desk.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hire402 import AdvanceClient, EscrowClient, TxSender, connect, dev_key, load_deployment  # noqa: E402
from hire402.abis import ERC20_ABI  # noqa: E402
from hire402.eip712 import sign_advance_offer  # noqa: E402
from web3 import Web3  # noqa: E402

MS = 1_000_000                    # 1.00 USDC per milestone
FEE_BPS = 150
PRINCIPAL = 800_000               # 0.80 USDC (≤ 80% of the 2.00 receivables)
APR_BPS = 600                     # 6% (spec §8: 5–8%)
YEAR = 31_536_000                 # 365 days, per-second accrual
FEE = MS * FEE_BPS // 10_000      # 0.015
INTEREST = PRINCIPAL * APR_BPS // 10_000  # 0.048 for exactly 365 days
DEBT = PRINCIPAL + INTEREST       # 0.848


def usdc(v: int) -> str:
    return f"{v / 1e6:.6f}"


def main() -> int:
    dep = load_deployment(os.environ.get("DEPLOYMENTS_FILE", "ops/deployments.local.json"))
    rpc = os.environ.get("HIRE402_RPC", "http://127.0.0.1:8545")
    w3 = connect(rpc)
    chain_id = w3.eth.chain_id

    buyer = TxSender(w3, dev_key("buyer"))
    seller = TxSender(w3, dev_key("genesis"))
    desk = TxSender(w3, dev_key("desk"))

    adv_addr = dep["advancedEscrow"]
    usdc_addr = Web3.to_checksum_address(dep["usdc"])
    treasury = dep["treasury"]

    token = w3.eth.contract(address=usdc_addr, abi=ERC20_ABI)

    def bal(addr: str) -> int:
        return token.functions.balanceOf(Web3.to_checksum_address(addr)).call()

    ec_buyer = EscrowClient(w3, buyer, adv_addr, usdc_addr)
    ec_seller = EscrowClient(w3, seller, adv_addr, usdc_addr)
    ac_seller = AdvanceClient(w3, seller, adv_addr, usdc_addr)

    print(f"[py-desk] buyer {buyer.address} | seller {seller.address} | desk {desk.address}")

    # --- 1. Two-milestone job ------------------------------------------
    deadline = w3.eth.get_block("latest").timestamp + 86_400
    escrow_id, _ = ec_buyer.create(seller.address, FEE_BPS, 60,
                                   [(MS, deadline, "ipfs://py-m0"),
                                    (MS, deadline, "ipfs://py-m1")])
    buyer.send(token.functions.approve(Web3.to_checksum_address(adv_addr), 10_000_000), gas=100_000)
    ec_buyer.fund(escrow_id)
    ec_seller.start(escrow_id)
    ec_seller.submit(escrow_id, 0, "ipfs://py-att0")
    ec_seller.submit(escrow_id, 1, "ipfs://py-att1")
    print(f"[py-desk] escrow #{escrow_id} active: 2 × {usdc(MS)} escrowed")

    # --- 2. Python-signed offer accepted by the on-chain verifier -------
    offer_expiry = w3.eth.get_block("latest").timestamp + 3_600
    sig = sign_advance_offer(desk, chain_id, adv_addr, escrow_id,
                             seller.address, PRINCIPAL, APR_BPS, offer_expiry)
    seller_before = bal(seller.address)
    desk_before = bal(desk.address)
    ac_seller.accept_advance(escrow_id, PRINCIPAL, APR_BPS, offer_expiry, sig)
    print(f"[py-desk] ✓ python-signed AdvanceOffer accepted: {usdc(PRINCIPAL)} desk → seller")

    # --- 3. One year passes (deterministic anvil time jump) -------------
    w3.provider.make_request("evm_increaseTime", [YEAR])
    w3.provider.make_request("evm_mine", [])

    # --- 4. Release m0: fee → treasury, desk FIRST, remainder → seller ---
    # Explicit 400k: the desk-routing release does 3 transfers + accrual
    # (the py client's 200k default fits the base escrow, not the rail).
    seller_at_accept = bal(seller.address)
    desk_at_accept = bal(desk.address)
    treasury_before = bal(treasury)
    ec_buyer.approve(escrow_id, 0, gas=400_000)
    desk_after0 = bal(desk.address)
    seller_after0 = bal(seller.address)
    treasury_after0 = bal(treasury)

    # --- 5. Release m1 plainly (debt cleared) ---------------------------
    desk_before1 = bal(desk.address)
    seller_before1 = bal(seller.address)
    ec_buyer.approve(escrow_id, 1, gas=400_000)
    state = ec_buyer.core(escrow_id)["state"]

    checks = [
        ("seller received the advance at accept", PRINCIPAL, seller_at_accept - seller_before),
        ("desk disbursed the advance at accept", PRINCIPAL, desk_before - desk_at_accept),
        ("desk repaid first at m0 (principal + interest)", DEBT, desk_after0 - desk_at_accept),
        ("seller remainder after desk repayment", MS - FEE - DEBT, seller_after0 - seller_at_accept),
        ("fee untouched by the rail (150 bps at m0)", FEE, treasury_after0 - treasury_before),
        ("total fees across both releases", 2 * FEE, bal(treasury) - treasury_before),
        ("advance debt cleared", 0, ac_seller.advance_debt(escrow_id)),
        ("m1 released plainly (desk gets nothing)", 0, bal(desk.address) - desk_before1),
        ("seller paid in full at m1", MS - FEE, bal(seller.address) - seller_before1),
        ("escrow Complete", 3, state),
    ]
    ok = True
    for name, expected, actual in checks:
        passed = expected == actual
        ok = ok and passed
        print(f"[py-desk] {'✓' if passed else '✗'} {name}: expected {expected} | actual {actual}")

    print("\nPY DESK PARITY: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())