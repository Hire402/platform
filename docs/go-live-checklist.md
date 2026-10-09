# Hire402 — Go-Live Checklist (the operator's steps)

Version 0.1 · 2026-10-08. Everything here requires **your** accounts or
credentials — the repo side is done (see the roadmap changelog through
v1.0.7). Work top to bottom. Companion: [`ops-runbook.md`](ops-runbook.md)
(what the registry needs once hosted) · [`outreach-kit.md`](outreach-kit.md).

**Known values you'll paste repeatedly:**

| Thing | Value |
|---|---|
| Hire402Escrow (Base Sepolia) | `0xde48e3788342c83c7d07749d377c00fa127d7aba` |
| AdvancedEscrow | `0xa1a5ac67cc65821a376e8478d8625122df9c0be7` |
| BondVault | `0xd659730547283f652648c392963d39c5d31e8c28` |
| ReputationAnchor | `0xcf01ec128bd906c73e4b44bdc44728eaa7c33319` |
| Testnet USDC (CDP) | `0x036CbD53842c5426634e7929541Ec2318f3dCF7e` |
| Buyer wallet (faucet target) | `0x0E2AcEbC290a9651d55F4A8FfaB9fA48d7427DAD` |
| Ops keys (desk + anchorer) | `ops/data/base-sepolia-ops.json` — **gitignored; back this file up** |
| Deployer key | `ops/data/base-sepolia-deployer.json` — **back this file up** |
| GitHub org (**claimed**) | `github.com/Hire402` — repo: `github.com/Hire402/platform` |
| Domain (**purchased**) | `hire402.com` |

---

## Step 0 ✅ — DONE 2026-10-09: repo live (github.com/Hire402/platform)

Created, pushed, **public**, default branch `main` —
and the **first CI run is green** (37897159724): all 11 jobs (contracts +
typecheck + 9 demos) passed on GitHub's own runners. The remote
(`origin` → `https://github.com/Hire402/platform.git`) and the gh
credential helper are set up on the dev machine — future pushes are just
`git push`. Keep the repo **public**: outreach links, MCP listings, and
"reproducible from the repo" in the pitch all require it.

Sanity check for retired repo URLs (expect no output):

```bash
grep -rnE 'hire402-protocol/hire402|github.com/Hire402/(agent|protocol)' \
  --include='*.json' --include='*.md' . | grep -v node_modules \
  | grep -v go-live-checklist | grep -v docs/roadmap.md
# expect: no output (retired repo URLs live only in the changelog history)
```

## Step 1 — 15 min: npm (TypeScript SDK)

1. **Account**: <https://www.npmjs.com/signup> → verify email → enable 2FA.
2. **Scope**: publishing `@hire402/sdk` requires an npm org named
   `hire402`. Check <https://www.npmjs.com/org/hire402> — if it 404s,
   create it (free): npmjs.com → Add Organization → name `hire402`.
   **If the org name is taken**: fall back to your own scope — change
   `"name"` in `sdk/ts/package.json` to `"@YOURNAME/hire402-sdk"`, update
   the workspace imports the same way
   (`grep -rl "@hire402/sdk" registry market examples --include='*.ts'`),
   then `npm install && npm run typecheck`.
3. **Publish** (from the repo root):

```bash
cd sdk/ts
npm login            # browser flow
npm publish --access public
```

(`prepublishOnly` builds automatically; the artifact is pre-flighted —
see the v1.0.7 changelog.)

4. **Verify**: `npm view @hire402/sdk` shows 0.1.0.

## Step 2 — 15 min: PyPI (Python SDK)

1. **Account**: <https://pypi.org/account/register/> → verify email →
   **Settings → API tokens → Add token** (scope: entire account).
2. **Publish**:

```bash
pip install --upgrade build twine
cd sdk/py
python -m build
twine upload dist/*        # username: __token__   password: <the token>
```

(The artifact is pre-flighted — build + `twine check` pass clean, README
included; see the v1.0.11 changelog.)

3. **Verify** (fresh venv): `pip install hire402` then
   `python -c "import hire402; print(hire402.AdvanceClient)"`.

## Step 3 — 45 min: host the registry (STARTS THE 30-DAY UPTIME CLOCK)

### 3a. Provider RPC (public RPCs will rate-limit the indexer)

Sign up at <https://www.alchemy.com> (free tier) → Create App → chain
**Base Sepolia** → copy the `https://` endpoint. (QuickNode/Infura fine.)

### 3b. Machine + domain

Any small Node-20 VM (~$5/mo: Hetzner CX22 / DigitalOcean / Lightsail),
Ubuntu 24.04, ports 22/80/443. Point `registry.hire402.com` at it —
TLS is one line with Caddy (below).

### 3c. Deploy (on the VM)

```bash
sudo apt update && sudo apt install -y nodejs npm caddy   # Node 20+ (else nodesource)
git clone https://github.com/Hire402/platform hire402 && cd hire402
npm install                       # also builds the SDK (prepare hook)

# from your LAPTOP, copy the anchorer key up (ops/data/ is gitignored):
#   scp ops/data/base-sepolia-ops.json you@vm:hire402/ops/data/

# foreground smoke test:
HIRE402_CHAIN=base-sepolia \
HIRE402_RPC=<ALCHEMY_URL> \
ESCROW_ADDRESS=0xde48e3788342c83c7d07749d377c00fa127d7aba \
USDC_ADDRESS=0x036CbD53842c5426634e7929541Ec2318f3dCF7e \
ANCHOR_ADDRESS=0xcf01ec128bd906c73e4b44bdc44728eaa7c33319 \
ANCHORER_KEY=$(node -p "require('./ops/data/base-sepolia-ops.json').anchorer.private_key") \
REGISTRY_PORT=4010 \
  npx tsx registry/src/index.ts
# expect "[registry] listening on :4010" then "[anchor] epoch 1 anchored: …"
# Ctrl-C once an epoch anchors.
```

### 3d. Service

Create `/etc/systemd/system/hire402-registry.service` (full unit in
`docs/ops-runbook.md`; env vars exactly as in 3c — add
`REGISTRY_STORE=postgres DATABASE_URL=…` when you want Postgres; the JSON
store is fine to start), then:

```bash
sudo systemctl enable --now hire402-registry
curl -s localhost:4010/healthz     # {"ok":true,…}
```

### 3e. TLS (Caddy — automatic HTTPS)

```text
# /etc/caddy/Caddyfile
registry.hire402.com {
    reverse_proxy 127.0.0.1:4010
}
```

`sudo systemctl reload caddy` → `curl -s https://registry.hire402.com/healthz`

### 3f. Monitoring (the clock needs a witness)

- <https://uptimerobot.com> (free): HTTP monitor on
  `https://registry.hire402.com/healthz`, every 5 min.
- Weekly: `GET /v1/anchor` → `latestEpoch` should grow **4/day**; alert
  if 2 epochs are missed. Keep the anchorer's ETH above ~0.0005
  (`cast balance 0x7956A544647D4f8A57BE0ec51aA1E5d99cD3C7E0
  --rpc-url https://sepolia.base.org`; top up from any faucet).

**Record the go-live date — the ≥99.5%/30-day roadmap gate runs from
here.**

## Step 4 — 10 min: real-USDC testnet genesis run

1. <https://www.cdp.co/faucets> → Base Sepolia → claim **USDC** → send
   **2–3 USDC to `0x0E2AcEbC290a9651d55F4A8FfaB9fA48d7427DAD`** (the
   buyer). Also claim a little Base Sepolia ETH if the deployer
   (`0xCFdeA0E705A5224aEa97a7f59Bd106CA94DcEa4e`) is low.
2. From your laptop (deployer key file must be present):

```bash
bash ops/run-genesis-testnet.sh     # default SETTLEMENT=usdc
```

3. It prints a report path (`ops/reports/genesis-run-*.json`) — that
   becomes the real-USDC evidence in the outreach kit.

## Step 5 — 30 min: MCP listings

The server: `examples/mcp-server` (5 tools, stdio). Same metadata
everywhere — name `hire402`; one-liner "The trust layer for the machine
economy: escrowed agent labor, staked verifier courts, credit, metabolic
P&L"; repo URL; transport **stdio**; command
`npx -y tsx examples/mcp-server/src/index.ts` (repo root; requires the
repo public).

| Directory | Where |
|---|---|
| Smithery | <https://smithery.ai> → Publish a server |
| mcp.so | <https://mcp.so> → Submit |
| Glama | <https://glama.ai/mcp/servers> → Submit |
| PulseMCP | <https://pulsemcp.com> → Submit |
| Anthropic directory | the `modelcontextprotocol/servers` list / Anthropic docs |

## Step 6 — 10 min: ADP DNS record

In your DNS provider, for `registry.hire402.com` add the ADP record at
`_agent-resolver._tcp` pointing resolvers at the registry's agent card
(`https://registry.hire402.com/.well-known/agent-card.json` — already
served). Wire format per the ADP draft the spec pins (§2); if the draft
has moved since the spec was written, **pin the exact format in
`docs/spec-pins.md` at listing time** — same discipline as everything
else.

## Step 7 — 2 weeks: the soak (weekly 5-minute checks)

- UptimeRobot ≥ 99% so far
- `GET /v1/anchor` → epoch ≈ 4/day × days elapsed (gapless by design)
- indexer freshness: agent records advance as anything trades
- disk (JSON store) — move to Postgres when the event trail grows

Nothing to babysit — restarts are drilled and safe (v1.0.6).

## Step 8 — outreach

After ~1–2 clean weeks of soak: tier-1 conversations first (Circle, AWS/
Coinbase, Coinbase Business — asks written in `docs/outreach-kit.md`),
MCP directories, then the DMs (template in the kit). Lead every pitch
with: the three run reports + the external-wallet demo + the uptime
streak.

---

## Evidence to keep per step

| After | Send |
|---|---|
| Step 1 | `npm view @hire402/sdk` output |
| Step 2 | the twine success line + `pip install hire402` result |
| Step 3 | `curl https://registry.hire402.com/v1/anchor` + the go-live date |
| Step 4 | the genesis report path |
| Steps 5–6 | the listing URLs |
| Soak | weekly: the four checks |

Update each step as it completes — this file doubles as the go-live record.
