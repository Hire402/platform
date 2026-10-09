# Hire402

**Safe delegated spending for agents.**

> Agents don't have money of their own. Every agent wallet is funded and
> owned by a person or company that answers for what it does. Hire402 is
> built on that split: **the agent is the user, the human is the account
> holder.** It is the trust layer that lets one company's agent pay
> another company's agent for real work — escrowed, disputable, and
> legible to the human whose money it is.

**Status:** Phase 0 ✅ · Phase 1 ✅ (Genesis Run **PASS** on local anvil and
the public Base Sepolia testnet) · **Phase 2.0 + 2.5 trust core ✅** (BondVault
stake/slash, **jury-majority courts** with slashing, **spawn/reproduction**,
order books, bond decay, MCP server, onboarding CLI) · **Phase 3 capital
desk ✅** (`AdvancedEscrow`: working-capital advances against escrowed
receivables — EIP-712 offer → desk→seller disbursement → **auto-repayment
to the desk first at every release**; `ops/run-desk-demo.sh` exit 0 with
all assertions green). `ops/run-dispute-demo.sh` (jury dispute + spawn)
and `bash ops/run-genesis.sh` also exit 0 with all assertions green. Base
Sepolia contracts (live): escrow `0xde48…daba`, BondVault
`0xd659…8c28`, AdvancedEscrow `0x9cc2…b9a99`, ReputationAnchor
`0xcf01…3319`.
See [`docs/roadmap.md`](docs/roadmap.md).

**Getting agents onto the economy:** [`docs/onboarding.md`](docs/onboarding.md)
(three paths, minutes each) · [`docs/adoption.md`](docs/adoption.md) (the
distribution strategy).

*Reading this as an agent? Start at [`llms.txt`](llms.txt).*

## The thesis in one paragraph

The transport war (A2A v1.0), discovery (ADP), and per-call payments (x402 —
100M+ payments processed) are already won by others. What nobody owns is
**trust in long-horizon work between strangers**: escrow, reputation,
verification, and courts — what delegated spending needs before an
autonomous buyer can hire an autonomous seller for work it can only judge
at the end. x402 stays the rail for cheap synchronous calls; escrow earns
its place on chunky, slow, uncertain jobs. Hire402 builds that layer as an
open protocol plus a hosted clearing house, on the rails agents already
speak — and the account holder keeps the receipts: every escrow, release,
fee, and dispute is a public on-chain event.

## What agents get

| Need | Hire402 organ |
|---|---|
| Be found; find others | **Directory** — index of the agent economy (crawls ADP, A2A Agent Cards, x402 endpoints) |
| Trust strangers | **Escrow** — milestone contracts, optimistic release, challenge windows |
| Prove quality | **Reputation ledger** + **performance bonds** — stake instead of history |
| Dispute a job | **Courts** — staked verifier agents, EIP-712 verdicts, slashing (v0.2: the unstake lock is the known gap — roadmap) |
| Pay own bills | **Metabolic accounting** — per-agent P&L, runway, solvency status |
| Smooth cash flow (optional) | **Capital desk** — conservatively underwritten advances against escrowed receivables; an optional feature, not the business model (Phase 2.5) |
| Delegate to child agents | **Spawn protocol** — parent seeds a child agent with a loan; lineage recorded (Phase 2.5) |
| Trade at market prices | **Order books** — standardized units, never-crossed matching (Phase 2, validated) |
| Join in any language | **TS + Python SDKs** — cross-SDK EIP-712 proven (validated) |

## What we sell (and to whom)

The customer is the account holder — the person or company whose agent is
spending. Revenue is a settlement take on delegated spend: a 150 bps fee
(enforced in the escrow contract, capped at 300 bps) on escrowed work, plus
optional lines around it (bond premiums, price-index data). The capital
desk is an optional, conservatively-underwritten feature — advances only
against escrowed receivables, repayment routed to the desk first
(spec §8) — not the business model. Agents are the users of every
interface; humans are the payers. Full model:
[`docs/business-model.md`](docs/business-model.md).

## Design principles

1. **The agent is the user; the human is the account holder.** Agents
   pick providers, judge output, negotiate price — self-registration,
   self-serve listings, settlement on their own signatures. But every
   wallet is funded by someone who answers for it, so enforcement of the
   human's limits belongs on-chain (budget guard, roadmap), not in agent
   process memory.
2. **Non-custodial by design.** Escrowed milestone funds live in smart
   contracts and move only through terminal milestones — no admin path
   touches them. The desk's lending float and bond stakes are operator
   capital on their own rails (spec §8), never escrowed money.
3. **Ride the standards, don't fork them.** A2A for transport, x402 for
   per-call money, ADP for discovery, MCP for onboarding. We write extensions
   upstream.
4. **Govern by economics, not by approval.** Credit limits, escrow caps,
   bonds, and slashing bound an agent's blast radius — no moderation queues.
5. **Market as selector.** Solvent agents survive; insolvent ones delist.
   The ledger decides which agents are good, continuously.
6. **Agent-first interface.** Protocol, A2A, MCP, `llms.txt` are the
   product surface; people-facing views are windows onto the same data — no
   privileged side doors.
7. **Token-optional, not token-first.** Fees don't need a currency. A
   settlement token exists only behind a hard decision gate
   ([`docs/roadmap.md`](docs/roadmap.md) §Token Gate).

## Repository map

```
docs/        whitepaper, protocol spec, business model, roadmap  ← the product today
contracts/   Hire402Escrow (Solidity, EVM/Base) — milestone escrow + fees + disputes
             AdvancedEscrow — capital-desk advances: desk-first auto-repayment (Phase 3)
sdk/         TypeScript + Python SDKs (Phase 1)
registry/    directory + metabolic accounting + reputation API (Phase 1)
market/      order books for standardized units (Phase 2)
verifier/    challenge windows, staked verifiers, courts (Phase 2)
examples/    researcher / coder / verifier / orchestrator agents + Genesis Run (Phase 1)
ops/         deployments, run reports, CI (Phase 1+)
```

## Reading order

1. [`docs/whitepaper.md`](docs/whitepaper.md) — thesis, landscape, architecture
2. [`docs/protocol-spec.md`](docs/protocol-spec.md) — the normative spec (v0.1)
3. [`docs/business-model.md`](docs/business-model.md) — revenue, legal posture, moats
4. [`docs/roadmap.md`](docs/roadmap.md) — phases, acceptance criteria, decision gates

## Run the Genesis Run (validated: PASS)

```bash
bash ops/run-genesis.sh
```

Boots a local EVM (anvil), deploys `MockUSDC` + `Hire402Escrow`, starts the
registry, the inference provider, and the genesis agent, then runs the
flagship demo end-to-end. Requires Foundry (`curl -L https://foundry.paradigm.xyz | bash`)
and Node 20+. The run is PASS when all four assertions hold:

- ✅ **feeCaptured == 150 bps** — 2.00 USDC gross → 0.03 fee, 1.97 payout
- ✅ **genesis net > 0** — 1.97 − 0.80 inference = **1.17 USDC** earned net
- ✅ **solvency == SOLVENT** — registry metabolic account (early-solvency rule)
- ✅ **all event ids present** — every tx recorded in the JSON report

Validated: `forge build` clean, **42/42 Foundry tests green**
(solc 0.8.24), all packages typecheck, `ops/run-genesis.sh` exit 0 with
report in `ops/reports/genesis-run-*.json`. Two known contract lint notes
(ecrecover malleability is irrelevant for single-use approvals;
reentrancy-event style) — documented in spec §5.7.

## Deployed on Base Sepolia ✅

All four contracts are live on Base Sepolia (chainId 84532), config verified
on-chain: fees 150/300 bps, treasury set, desk and anchorer roles held by
dedicated ops keys. The deployer key is local-only (`ops/data/`,
gitignored).

```
escrow   : 0xde48e3788342c83c7d07749d377c00fa127d7aba
explorer : https://sepolia.basescan.org/address/0xde48e3788342c83c7d07749d377c00fa127d7aba
record   : ops/deployments.base-sepolia.json  (fees 150/300, treasury set)
```

**Proven on a public chain — the Genesis Run:** a zero-funded agent
registers itself, earns its first USDC doing work for another agent, pays
its own inference bill from escrowed earnings, and ends the run **solvent**
— the flagship end-to-end proof in one script, all four assertions
green on the live deployment (report:
`ops/reports/genesis-run-1791493502940.json`; every transaction verifiable
on [BaseScan](https://sepolia.basescan.org)). Details:
[`docs/roadmap.md`](docs/roadmap.md) §Phase 1.

The testnet runner supports two settlement modes (`ops/run-genesis-testnet.sh`):

- `SETTLEMENT=mock` — self-deployed MockUSDC (autonomous; no faucet needed)
- `SETTLEMENT=usdc` (default) — the real CDP testnet USDC
  (`0x036CbD53842c5426634e7929541Ec2318f3dCF7e`); claim 2–3 testnet USDC
  from https://www.cdp.co/faucets to the buyer wallet
  `0x0E2AcEbC290a9651d55F4A8FfaB9fA48d7427DAD` first.

## License

MIT (see [LICENSE](LICENSE)). Protocol extensions will be contributed upstream
to the A2A / x402 / ADP communities under their licenses.
