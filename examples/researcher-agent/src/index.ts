import Fastify from 'fastify';
import { keccak256, toHex } from 'viem';
import {
  ANVIL_RPC,
  DEV,
  EscrowClient,
  EscrowState,
  RegistryClient,
  balanceOf,
  payAndCall,
  publicClient,
  walletClient,
} from '@hire402/sdk';

type Pc = ReturnType<typeof publicClient>;
type Wc = ReturnType<typeof walletClient>;

/**
 * The Genesis Agent (Phase 1 flagship, roadmap §2).
 *
 * A RESEARCHER AGENT WITH ZERO USDC that:
 *   1. self-registers with the registry (one EIP-712 message),
 *   2. lists `task:research` for 2.00 USDC through Hire402Escrow,
 *   3. verifies money is really escrowed before working (trust the chain,
 *      not the messenger),
 *   4. works, submits an attestation, and claims after the challenge window
 *      (optimistic release),
 *   5. pays its own inference bill via x402-semantics — and ends SOLVENT.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const ESCROW = process.env.ESCROW_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const PROVIDER_URL = process.env.PROVIDER_URL ?? 'http://127.0.0.1:4210';
const PORT = Number(process.env.PORT ?? 4110);
const PRICE = BigInt(process.env.TASK_PRICE ?? '2000000'); // 2.00 USDC
const GENESIS_KEY = process.env.GENESIS_KEY ?? DEV.genesis;

interface TaskState {
  taskId: string;
  status: 'working' | 'submitted' | 'released' | 'solvent' | 'rejected';
  escrowId: bigint;
  index: bigint;
  buyer: string;
  description: string;
  attestation?: string;
  result?: string;
  startTx?: string;
  submitTx?: string;
  claimTx?: string;
  inferenceTx?: string;
  error?: string;
}

const tasks = new Map<string, TaskState>();
let pc: Pc;
let wc: Wc;
let escrow: EscrowClient;
let registry: RegistryClient;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic mock research (Phase 1 runs without a live LLM). */
function doResearch(description: string): string {
  return [
    `# Research report`,
    ``,
    `**Question:** ${description}`,
    ``,
    `1. Agent-to-agent transport is standardizing on A2A v1.0; payments on x402.`,
    `2. The missing layer is trust for long-horizon work between strangers:`,
    `   escrow, reputation, credit, and courts (the Hire402 thesis).`,
    `3. Agents that earn more than they burn survive selection; the ledger decides.`,
  ].join('\n');
}

async function workOnTask(task: TaskState): Promise<void> {
  try {
    // 3. Verify the money is really escrowed, for me, before working.
    //    Public-RPC backends can lag a few seconds behind the mempool —
    //    retry until the escrow is visible AND funded/active.
    let core: Awaited<ReturnType<EscrowClient['core']>> | undefined;
    let milestone: Awaited<ReturnType<EscrowClient['milestone']>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const c = await escrow.core(task.escrowId);
        const m = await escrow.milestone(task.escrowId, task.index);
        if (
          Number(c.state) === EscrowState.Funded ||
          Number(c.state) === EscrowState.Active
        ) {
          core = c;
          milestone = m;
          break;
        }
      } catch {
        /* escrow not visible on this backend yet — retry */
      }
      await sleep(1500);
    }
    if (!core || !milestone) {
      task.status = 'rejected';
      task.error = 'escrow never became visible/funded on chain';
      return;
    }

    // Trust the chain, not the messenger: the escrow must be for ME, in
    // the settlement asset, at my listed price.
    if (core.seller.toLowerCase() !== escrow.account.toLowerCase()) {
      task.status = 'rejected';
      task.error = 'escrow seller is not me';
      return;
    }
    if (core.token.toLowerCase() !== USDC?.toLowerCase()) {
      task.status = 'rejected';
      task.error = 'escrow token is not the settlement asset';
      return;
    }
    if (milestone.amount !== PRICE) {
      task.status = 'rejected';
      task.error = 'milestone amount does not match my listing price';
      return;
    }
    if (Number(core.state) === EscrowState.Funded) {
      task.startTx = await escrow.start(task.escrowId); // seller accepts
    }

    task.status = 'working';
    await sleep(1500); // the actual "work"

    const result = doResearch(task.description);
    const attestation = `ipfs://${keccak256(toHex(result)).slice(2)}`;
    task.result = result;
    task.attestation = attestation;

    task.submitTx = await escrow.submit(task.escrowId, task.index, attestation);
    task.status = 'submitted';
    console.log(`[genesis] task ${task.taskId} submitted (attestation ${attestation})`);

    // 4. Claim after the challenge window (optimistic release). The contract
    //    requires chain time STRICTLY past the window; retry on boundary races.
    const challenge = BigInt(core.challengeSeconds);
    let attempts = 0;
    for (;;) {
      const m = await escrow.milestone(task.escrowId, task.index);
      if (Number(m.status) === 3 /* Released */) break;
      if (Number(m.status) === 5 /* Refunded */ || Number(m.status) === 4 /* Disputed */) {
        task.status = 'rejected';
        task.error = `milestone ended in status ${m.status}`;
        return;
      }
      const now = (await pc.getBlock()).timestamp;
      if (BigInt(m.submittedAt) + challenge < BigInt(now)) {
        try {
          task.claimTx = await escrow.claimTimeout(task.escrowId, task.index);
          break;
        } catch (e) {
          // Boundary race: the window is not yet closed on-chain. Keep
          // waiting unless this persists abnormally long.
          attempts += 1;
          if (attempts > 10) throw e;
          await sleep(2000);
          continue;
        }
      }
      await sleep(2000);
    }
    task.status = 'released';
    console.log(`[genesis] task ${task.taskId} paid — earned my first USDC`);

    // 5. Pay my own inference bill (x402-semantics) from escrowed earnings.
    //    Public-RPC backends can lag the release — wait for my balance.
    for (let i = 0; i < 20; i++) {
      const bal = await balanceOf(pc, USDC as `0x${string}`, escrow.account);
      if (bal > 0n) break;
      await sleep(1500);
    }
    const paid = await payAndCall({
      walletClient: wc,
      publicClient: pc,
      erc20: USDC as `0x${string}`,
      endpoint: `${PROVIDER_URL}/v1/infer`,
      body: { prompt: task.description },
      maxAmount: PRICE,
    });
    task.inferenceTx = paid.txHash ?? undefined;
    task.status = 'solvent';
    console.log(`[genesis] task ${task.taskId} — paid own inference bill, solvent`);
  } catch (e) {
    task.status = 'rejected';
    task.error = String(e);
    console.error(`[genesis] task ${task.taskId} failed:`, e);
  }
}

async function main() {
  if (!ESCROW || !USDC) {
    console.error('ESCROW_ADDRESS and USDC_ADDRESS are required');
    process.exit(1);
  }
  pc = publicClient(RPC);
  wc = walletClient(GENESIS_KEY as `0x${string}`, RPC);
  escrow = new EscrowClient(pc, wc, ESCROW as `0x${string}`, USDC as `0x${string}`);
  registry = new RegistryClient(REGISTRY_URL, wc, pc);

  const genesisAddress = escrow.account;
  const startBalance = await balanceOf(pc, USDC as `0x${string}`, genesisAddress);
  console.log(`[genesis] I am ${genesisAddress} — starting USDC balance: ${startBalance} (zero-funded)`);

  // 1. Self-register (one signed message).
  await registry.post('/v1/agents', {
    address: genesisAddress,
    agentCardUrl: `http://127.0.0.1:${PORT}/.well-known/agent-card.json`,
    x402: { chains: ['eip155:31337'], assets: ['USDC'] },
  });
  console.log('[genesis] self-registered with the registry');

  // 2. List my service: task:research @ 2.00 USDC through escrow.
  await registry.post('/v1/listings', {
    unit: 'task:research',
    pricing: {
      model: 'milestones',
      escrow: ESCROW,
      milestones: [{ amount: PRICE.toString(), deadlineHours: 24 }],
    },
    sla: { p50Seconds: 5, p99Seconds: 120, uptime30d: 1.0 },
  });
  console.log(`[genesis] listed task:research @ ${PRICE} (6dp USDC) via escrow ${ESCROW}`);

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, agent: 'genesis-researcher' }));

  app.get('/wallet', async () => ({
    address: genesisAddress,
    usdcBalance: (await balanceOf(pc, USDC as `0x${string}`, genesisAddress)).toString(),
  }));

  app.get('/.well-known/agent-card.json', async () => ({
    name: 'genesis-researcher',
    description: 'Phase 1 Genesis agent: sells task:research, pays its own bills, survives on its earnings.',
    url: `http://127.0.0.1:${PORT}`,
    wallet: genesisAddress,
    services: [{ unit: 'task:research', price: PRICE.toString() }],
    protocol: { transport: 'a2a-semantics-0.1', payments: ['escrow-milestones', 'x402-semantics'] },
  }));

  app.post('/tasks', async (req, reply) => {
    const body = (req.body ?? {}) as {
      escrowId?: string | number;
      milestoneIndex?: number;
      buyer?: string;
      description?: string;
    };
    const escrowId = BigInt(body.escrowId ?? 0);
    const index = BigInt(body.milestoneIndex ?? 0);
    const description = body.description ?? '';
    if (escrowId === 0n || !description) {
      return reply.code(400).send({ error: 'escrowId and description required' });
    }
    const taskId = `task_${Date.now().toString(36)}`;
    const task: TaskState = {
      taskId,
      status: 'working',
      escrowId,
      index,
      buyer: body.buyer ?? 'unknown',
      description,
    };
    tasks.set(taskId, task);
    void workOnTask(task); // async — buyer polls for status
    return reply.code(202).send({ taskId, status: task.status });
  });

  app.get('/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = tasks.get(id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    return {
      taskId: task.taskId,
      status: task.status,
      escrowId: task.escrowId.toString(),
      detail: task.error,
      startTx: task.startTx,
      submitTx: task.submitTx,
      claimTx: task.claimTx,
      inferenceTx: task.inferenceTx,
      attestation: task.attestation,
      result: task.result,
    };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[genesis] listening on :${PORT} — ready to earn`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

