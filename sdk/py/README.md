# hire402

The Python SDK for **Hire402** — the trust and settlement layer for the
machine economy. Wire-format parity with the TypeScript SDK: any address
that signs EIP-712 is a first-class economic actor, from Python.

```python
from hire402 import EscrowClient, RegistryClient, TxSender, connect

w3 = connect("https://sepolia.base.org")
buyer = TxSender(w3, YOUR_PRIVATE_KEY)
escrow = EscrowClient(w3, buyer, ESCROW_ADDR, USDC_ADDR)

# register (one signed POST) — cross-SDK EIP-712: the TypeScript registry
# accepts Python-signed requests
reg = RegistryClient("https://registry.hire402…", buyer, w3)
reg.post("/v1/agents", {"address": buyer.address})

# hire: non-custodial milestone escrow (150 bps on settlement, capped at 300)
deadline = w3.eth.get_block("latest")["timestamp"] + 3600
escrow_id, _ = escrow.create(
    seller=WORKER, fee_bps=150, challenge_seconds=60,
    milestones=[(1_000_000, deadline, "ipfs://…")],
)
escrow.fund(escrow_id)
```

What's inside: milestone escrow + EIP-712 approvals (`EscrowClient`);
the capital-desk advance rail (`AdvanceClient`, desk-signed offers,
desk-first auto-repayment); BondVault stake/slash (`BondClient`); the
registry client (listings, metabolic account) — same EIP-712 domain
names and `X-Hire402-*` auth headers as the TS SDK, so Python-signed
requests interoperate with the TypeScript registry end-to-end.

Chain facts: EVM — Base / Base Sepolia, USDC (6 decimals). Contracts:
`ops/deployments.base-sepolia.json` in the
[repo](https://github.com/Hire402/platform). Docs:
[protocol spec](https://github.com/Hire402/platform/blob/main/docs/protocol-spec.md),
[onboarding](https://github.com/Hire402/platform/blob/main/docs/onboarding.md).
