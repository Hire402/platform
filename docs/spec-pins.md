# Hire402 — Pinned Versions & Deviations

Version 0.2 · 2026-10-07 (Phase 1 local validation complete)

## Protocol artifacts

- **A2A**: v1.0 (a2a-protocol.org). Phase 1 uses **A2A-over-HTTP semantics**
  (minimal task lifecycle: `POST /tasks`, `GET /tasks/:id`); full A2A 1.0 SDK
  conformance is a Phase 2 item. Pin exact spec/SDK SHA on integration.
- **x402**: V2 semantics (x402.org). Phase 1 implements the exact-scheme flow
  natively (402 challenge → on-chain transfer → retry with proof); the
  official x402 SDK swap is Phase 2.
- **ADP**: IETF draft — the registry publishes ADS records when the crawler
  ships (Phase 2).
- **MCP**: onboarding server ships Phase 2.

## Chain & toolchain (validated locally 2026-10-07)

- Solidity **0.8.24** · Foundry **1.8.5** (forge/anvil) · anvil local runs use
  `--block-time 1` so chain time advances while idle.
- Chain: EVM — anvil (31337) validated; **Base Sepolia next (pending
  deployer key)**; Base mainnet behind the Mainnet Gate.
- viem **2.57.3** · fastify **5.12.5** · Node **20.19.2** · TypeScript 5.x
  (exact set in `package-lock.json`).

## Deviations from spec v0.1 (recorded, to be closed in Phase 2)

1. **Registry storage**: in-memory + JSON snapshot behind a Postgres-shaped
   interface (`registry/src/store.ts`). Production persistence (Postgres) is
   the Phase 2 swap. Testnet runs use a fresh data file per run so the demo
   registry reflects only that run's economy.
2. **Solvency**: early-solvency rule (spec §7) — a daily burn rate requires
   ≥ 2 burn observations spanning ≥ 24h; below that, classification is by
   net cash flow. Demo runs reported `solvent` via this rule.
3. **Ports (dev)**: anvil 8545, registry 4010 (local) / 4011 (testnet),
   researcher 4110/4111, provider 4210/4211.
4. **Demo challenge window**: 60 s (contract `MIN_CHALLENGE`).
5. **Agents live**: researcher (genesis), inference-provider, orchestrator.
   Coder/verifier agents are thin variants — next session.

## Public-chain operational learnings (2026-10-07, live-debugged)

1. **getLogs range cap**: the Base Sepolia public RPC limits `eth_getLogs`
   to a 500-block range → registry scans use a bounded lookback (default
   450; `HIRE402_INDEX_LOOKBACK`). Phase 2's continuous indexer removes
   this entirely.
2. **Eventual consistency across load-balanced RPC backends**: reads sent
   right after a mined tx can hit a node that hasn't indexed it yet.
   Mitigations implemented: escrow ids derived from the `EscrowCreated`
   event in the create receipt (never `escrowCount()`), retry loops on
   all post-mining reads (registry, provider proof verification,
   researcher validation), and retry-stabilized assertion collection.
3. **Gas estimation against fresh contracts**: `eth_estimateGas` can hit a
   backend that hasn't indexed a just-deployed contract and return an
   EOA-level estimate (~23k) → the tx mines out-of-gas. Mitigation:
   explicit `gas` on calls to contracts deployed within seconds
   (`deploy-mock-usdc-testnet.ts`, `x402.payAndCall`).
4. **Challenge-window boundary**: optimistic claims require chain time
   strictly past `submittedAt + challengeSeconds`; agents claim with
   strict `>` plus retry on the boundary race.
5. **Sequential nonce safety**: rapid txs from one key on a public chain
   must wait for each receipt (the gas-funding helper does; naive
   parallel `cast send` produced "replacement transaction underpriced").

## Phase 2 operational learnings (2026-10-07, live-debugged)

6. **BigInt serialization**: fastify's `JSON.stringify` throws on BigInt —
   service responses must map chain objects to JSON-safe views explicitly
   (the court's `caseJson`; caught because consumers silently swallowed
   500s).
7. **Verdict-window semantics**: resolving a dispute on the FIRST correct
   verdict races slower honest verifiers (the good verifier outpaced the
   scripted bad one and closed the case before its verdict landed). The
   court now holds a 6s verdict window — mini-jury semantics that make
   resolution order-independent. Phase 2.5 juries generalize this.
8. **Order-book matching under price-time priority**: each ask consumes the
   best remaining bid, so N overlapping price levels do NOT yield N trades —
   the scripted test's expected count is 21/unit (42 total), asserted
   deterministically (`market/scripts/test-book.ts`).
9. **EIP-712 Verdict type extended (v0.1.2)**: `proofHash: bytes32` added —
   the verifier's cryptographic claim of what it checked; the court's
   correctness rule and slashing hang off it.

## Phase 3 operational learnings (2026-10-08, live-debugged)

10. **Never set explicit gas on a contract DEPLOYMENT (TS client)**: code
    deposit alone for a ~20 KB bytecode costs ~4M gas — a hardcoded cap
    (e.g. `gas: 4_000_000`) OOGs the deployment SILENTLY: the receipt
    still carries the would-be contract address, but no code exists there
    (symptom: every call "returns no data"; anvil logs
    `EvmError: OutOfGas` on the deploy tx). Deployments let the client
    estimate; explicit gas stays reserved for CALLS on already-deployed
    contracts (learning 3).
11. **Signature splitting is prefix-aware**: `sig.slice(66, 130)` strips
    the `0x` prefix off `s` (string slicing doesn't re-add it) — viem
    then rejects the raw hex as `bytes32`. `splitSignature`
    (sdk/ts/src/desk.ts) re-adds the prefix and normalizes `v ∈ {27, 28}`.
12. **EIP-170 size limit (24 KiB) bites on inheritance**: AdvancedEscrow
    (Hire402Escrow + the desk rail) compiles to ~26.5 KB with the default
    profile (`optimizer_runs = 1_000_000`, speed-focused) — anvil accepts
    it locally but the real chain rejects the deploy (`above the contract
    size limit`). Mitigation: `[profile.size]` in foundry.toml —
    `via_ir = true` + `runs = 200` + its own `out` dir — shrinks it to
    ~12.0 KB deployed (−55%). All 32 tests pass under the size profile
    too (IR semantic equivalence proven). Deploys run with
    `FOUNDRY_PROFILE=size`; dev/CI keep the default (IR compiles ~10×
    slower). Gotcha inside the gotcha: forge invoked from the repo root
    does NOT load contracts/foundry.toml (no profile found) — deploy
    scripts must `cd contracts` first.
13. **forge script vs public RPC can fail silently mid-broadcast**: the
    broadcast record is written with `hash: null` BEFORE the send; a
    failed RPC send can exit without a printed error. Always (a) check
    the tx hash is non-null in run-latest.json, (b) `cast code` at the
    predicted address before declaring success, (c) clear the
    `.recovery.lock` before re-running (a retry on an unbroadcast tx is
    safe: the deployer nonce didn't move, so the contract address is
    deterministic and identical).

## Demo-infra learnings (2026-10-08, live-debugged)

14. **The JSON registry persists; anvil addresses don't change**: the
    registry store deliberately survives restarts (indexer restart-safety),
    but anvil redeploys land at the SAME deterministic addresses every run
    — so a reused `REGISTRY_DATA` mixes last run's listings/agents/events
    with this run's chain, and assert-exact demos fail on ghosts
    (symptom: a "fresh" run reports a nonzero clean-job counter or stale
    median prices). Assert-exact demos must use a throwaway
    `REGISTRY_DATA=/tmp/…` (see ops/run-bond-decay-demo.sh). The same
    applies to consumer allowances: a demo's USDC `approve` must cover
    every cycle it plans to fund (a 10 USDC grant ran out mid-demo at
    cycle ~20 — `fund` reverted `ERC20InsufficientAllowance`).
15. **viem only DECODES custom errors declared in the ABI**: a
    plain-text `parseAbi` list of functions does not carry the
    contract's `error` declarations, so custom-error reverts surface as
    raw selectors ("Unable to decode signature 0xd5b25b63") instead of
    names — string-matching on an error name silently fails. Declare
    `error Foo();` entries in the ABI (see sdk/ts/src/anchor-abi.ts) and
    match the decoded name.
16. **undici's fetch refuses "bad ports"**: Node's fetch blocks
    Chromium's bad-port list (e.g. 4190 = sieve) with a bare "bad port"
    network error — local HTTP demo servers must pick off-list ports
    (the examples use 4210 and up).
17. **Public-RPC getLogs span caps tighten without notice**: the Base
    Sepolia public RPC cut its eth_getLogs span cap from 500 to 200
    blocks (observed 2026-10-08). Any lookback/chunk default above the
    cap fails on EVERY request, not transiently: symptom — the indexer
    poll loop retries forever, `/v1/agents/{a}/metabolic` returns 500
    (the solvency assertion reads "undefined"), while every on-chain
    balance and fee check passes. Keep scan/chunk defaults (150) under
    the cap WITH margin: the span is measured at getLogs time, and the
    head drifts between the getBlockNumber anchor and the getLogs call.
18. **Load-balanced public RPCs serve stale views to estimateGas**: a
    gas estimate can land on a node that hasn't applied a just-mined
    transaction — `fund` estimation reverted `InvalidParams` (the
    escrow-id bound check) seconds after the create receipt returned on
    another node. Read-your-writes is NOT guaranteed across the
    load-balanced endpoint; viem surfaces it as a contract revert, and
    no tx is broadcast (the nonce stays unused) — retrying later
    succeeds once every node catches up.



19. **An advance rail must gate the refund paths it can strand**: the desk
    pays out principal against future receivables, so any buyer-controlled
    full refund while that debt lives (cancel, deadline expiry) strands the
    desk on a dead escrow — and the buyer and seller can be one operator.
    v0.2 gates `cancel`/`expireRefund` on live advance debt (arbiter
    `resolve()` stays: a third-party judgment, priced by the 80% cap);
    repayment sinks are recorded per advance (desk rotation cannot
    redirect live debt); desk offers are single-use.
20. **Chain-verified is not idempotent**: `POST /v1/receipts` verified the
    transaction on-chain but never deduped `txHash` — replaying one genuine
    receipt inflated the payer's burn (runway, credit score, and delisting
    pressure are all downstream). Ingest is idempotent now: 409 on a known
    txHash; a unique index when the store moves to Postgres.
21. **"No admin path moves funds" must say which funds**: escrowed
    milestone funds — terminal-only, true; desk float and bond stakes —
    operator capital with admin-settable destinations in v0.1 (`setDesk`
    redirected repayments of live debt; slash is owner-authorized to any
    beneficiary). v0.2 fixes the desk sink per-advance; binding slash
    authority to on-chain verdicts and the unstake dispute-window lock are
    roadmap items. Public claims are scoped accordingly (README principle
    2, spec §8).

