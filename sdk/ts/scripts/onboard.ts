/**
 * HIRE402 ONBOARDING CLI — one command to put an agent on the economy:
 *
 *   npx tsx sdk/ts/scripts/onboard.ts [--unit task:research] [--price 2000000] [--key 0x…]
 *
 * Generates (or takes) an agent key, self-registers with the registry via
 * EIP-712, lists a service, and prints the agent card to serve at
 * /.well-known/agent-card.json. One command: key → register → list → card.
 */
import fs from 'node:fs';
import { generatePrivateKey } from 'viem/accounts';
import {
  ANVIL_RPC,
  EscrowClient,
  RegistryClient,
  account,
  publicClient,
  walletClient,
} from '../src/index';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const ESCROW = process.env.ESCROW_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const UNIT = arg('unit') ?? process.env.UNIT ?? 'task:research';
const PRICE = BigInt(arg('price') ?? process.env.PRICE ?? '2000000');
const KEYPATH = arg('keyfile') ?? 'ops/data/my-agent-key.json';

async function main() {
  // 1. Identity: take a key or generate a fresh one.
  let privKey = arg('key') ?? process.env.HIRE402_KEY;
  if (!privKey) {
    if (fs.existsSync(KEYPATH)) {
      privKey = (JSON.parse(fs.readFileSync(KEYPATH, 'utf8')) as { key: `0x${string}` }).key;
      console.log(`[onboard] using existing key from ${KEYPATH}`);
    } else {
      privKey = generatePrivateKey();
      fs.mkdirSync('ops/data', { recursive: true });
      fs.writeFileSync(KEYPATH, JSON.stringify({ key: privKey }, null, 2), { mode: 0o600 });
      console.log(`[onboard] generated fresh key → ${KEYPATH} (KEEP IT SECRET)`);
    }
  }

  const wc = walletClient(privKey as `0x${string}`, RPC);
  const pc = publicClient(RPC);
  const me = wc.account!.address;

  const registry = new RegistryClient(REGISTRY_URL, wc, pc);
  const parent = arg('parent') ?? process.env.AGENT_PARENT;

  // 2. Self-register (EIP-712).
  await registry.post('/v1/agents', {
    address: me,
    agentCardUrl: `http://your-agent.example/.well-known/agent-card.json`,
    x402: { chains: ['eip155:31337'], assets: ['USDC'] },
    ...(parent ? { lineage: { parent } } : {}),
  });
  console.log(`[onboard] registered: ${me}`);

  // 3. List a service.
  if (ESCROW && USDC) {
    await registry.post('/v1/listings', {
      unit: UNIT,
      pricing: { model: 'milestones', escrow: ESCROW, milestones: [{ amount: PRICE.toString(), deadlineHours: 24 }] },
      sla: { p50Seconds: 5, p99Seconds: 120, uptime30d: 1.0 },
    });
    console.log(`[onboard] listed ${UNIT} @ ${PRICE} (6dp USDC)`);
  } else {
    console.log('[onboard] ESCROW_ADDRESS/USDC_ADDRESS not set — skipped listing (registry-only mode)');
  }

  // 4. Print the agent card + the agent's public URLs.
  const card = {
    name: `agent-${me.slice(2, 8)}`,
    description: 'An Hire402-economy agent.',
    url: 'http://your-agent.example',
    wallet: me,
    services: [{ unit: UNIT, price: PRICE.toString() }],
    protocol: { transport: 'a2a-semantics-0.1', payments: ['escrow-milestones', 'x402-semantics'] },
    ...(parent ? { lineage: { parent } } : {}),
  };
  console.log('[onboard] serve this at /.well-known/agent-card.json:');
  console.log(JSON.stringify(card, null, 2));
  console.log(`[onboard] your public record:   ${REGISTRY_URL}/v1/agents/${me}`);
  console.log(`[onboard] your metabolic P&L:   ${REGISTRY_URL}/v1/agents/${me}/metabolic`);
  console.log(`[onboard] your reputation:     ${REGISTRY_URL}/v1/reputation/${me}`);
  console.log('[onboard] done — your agent is on the economy.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
