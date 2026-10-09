# Hire402 — Ops Runbook (public testnet service)

Version 0.1 · 2026-10-08. What runs in production: **one registry
process**. The contracts are already deployed and immutable. This
runbook covers hosting, keys, restart behavior, monitoring, and the
soak that starts the 30-day uptime clock (roadmap Phase 2 gate).

## What you're operating

| Piece | Where | Notes |
|---|---|---|
| Hire402Escrow / AdvancedEscrow / BondVault / ReputationAnchor | Base Sepolia (see `ops/deployments.base-sepolia.json`) | immutable; no admin path touches escrowed funds |
| Registry (`registry/src/index.ts`) | your host | directory + metabolic ledger + indexer + anchor scheduler |

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `HIRE402_RPC` | `http://127.0.0.1:8545` | **use a provider endpoint** (Alchemy/QuickNode); the public RPC rate-limits sustained polling |
| `ESCROW_ADDRESS` / `USDC_ADDRESS` | required | from `ops/deployments.base-sepolia.json` |
| `REGISTRY_PORT` | 4010 | put TLS in front (reverse proxy) |
| `REGISTRY_STORE` | `json` | `postgres` + `DATABASE_URL` for production persistence |
| `REGISTRY_DATA` | `ops/data/registry.json` | JSON store path (MUST persist across restarts) |
| `ANCHOR_ADDRESS` / `ANCHORER_KEY` | unset | unset = anchoring disabled; set = 6h epochs on-chain |
| `ANCHOR_EPOCH_SECONDS` | 21600 | production: 6h (spec §7) |
| `INDEXER_POLL_MS` | 5000 | poll cadence; loops back off ×2 with jitter on RPC errors |
| `INDEXER_CHUNK_BLOCKS` | 150 | getLogs chunk (Base Sepolia public RPC caps spans at 200 blocks — tightened from 500 on 2026-10-08) |
| `INDEXER_CONFIRMATIONS` | 3 | reorg safety |
| `HIRE402_INDEX_LOOKBACK` | 150 | metabolic fallback scan window (same span cap; the indexer trail supersedes it) |
| `BOND_MIN_USDC` | 500e6 | bond floor (spec §8) |
| `CRAWL_SEEDS` | unset | observed-agent crawler seeds (adoption) |

## Keys and roles

All keys live in gitignored `ops/data/` (`base-sepolia-deployer.json`,
`base-sepolia-ops.json`). Rotation script: `ops/rotate-ops-keys-base-sepolia.sh`.

| Role | Key | Does | Rotate via |
|---|---|---|---|
| Owner/deployer | `…-deployer.json` | config-only owner calls; **signs nothing live post-rotation** | — |
| Desk | `…-ops.json → desk` | signs EIP-712 AdvanceOffers (off-chain, gas-free); holds the USDC advance float | `setDesk` |
| Anchorer | `…-ops.json → anchorer` | sends `anchor()` every 6h; keep ≥ 0.001 ETH | `setAnchorer` |

## Hosting

Any Node 20 host (VM, container). Minimum:

```ini
# systemd unit sketch
[Service]
Environment=HIRE402_RPC=https://…provider… HIRE402_CHAIN=base-sepolia
Environment=ESCROW_ADDRESS=0x… USDC_ADDRESS=0x…
Environment=ANCHOR_ADDRESS=0xe75380c9… ANCHORER_KEY_FILE=… REGISTRY_STORE=postgres DATABASE_URL=…
ExecStart=npx tsx registry/src/index.ts
Restart=always
```

- Reverse-proxy TLS to the registry port; agents hit it over https.
- `REGISTRY_DATA` (or the Postgres DB) must be on persistent storage —
  it holds the indexer checkpoint and the anchor epoch leaves.

## Restart behavior (drilled, not assumed)

`ops/run-restart-drill.sh` kills the registry with SIGKILL mid-epoch,
transacts on-chain while it's down, and restarts. Proven behavior:
- **Indexer resumes from its checkpoint** — events mined during the
  outage are indexed on the first poll; no re-scan, no gap.
- **Anchor sequence stays gapless** — the restarted registry anchors
  `latestEpoch + 1`; the chain rejects anything else by design.
- **State persists** — agents, listings, bond/score data survive.
Run the drill after any registry/infra change; it's also a CI job.

## Monitoring (the 30-day uptime clock)

- **Liveness**: ping `GET /healthz` every 30s from an external monitor
  (the clock starts when the registry is deployed to stable hosting).
- **Indexer health**: `GET /v1/agents/{a known worker}` — reputation
  counters should advance as the market moves; a stalled counter with a
  moving chain = indexer stuck (check logs for backoff messages).
- **Anchor health**: `latestEpoch` on the ReputationAnchor should
  grow every 6h; alert if 2 epochs are missed (~12h of silence).
- **Anchorer gas**: alert if the anchorer address holds < 0.0005 ETH.

## Incidents

- **Registry wedged**: kill and restart — recovery is the designed path
  (drill above). No data is lost beyond in-flight requests.
- **Pause anchoring**: unset `ANCHOR_ADDRESS`/`ANCHORER_KEY` and restart;
  the on-chain sequence simply pauses (it cannot gap). Re-enable later —
  the next epoch is still `latestEpoch + 1`.
- **Contract migration**: contracts are immutable; a new escrow
  deployment means a new `ESCROW_ADDRESS` and the indexer re-runs from
  block 0 of the new contract. ReputationAnchor epochs are per-contract;
  announce any anchor migration loudly (Phase 4 federation syncs them).

## The soak (before you tell anyone it's live)

Run the registry for **days, not minutes**: watch indexer lag under
public-RPC flakiness (the backoff ladder should hold it steady), anchor
epochs accumulating, and disk on the JSON store (switch to Postgres
when the event trail matters). Two clean weeks of soak → start outreach
with the uptime streak in the pitch.
