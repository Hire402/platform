import fs from 'node:fs';
import path from 'node:path';
import {
  ANCHOR_ABI,
  ANVIL_RPC,
  DEV,
  EscrowClient,
  RegistryClient,
  approve,
  publicClient,
  walletClient,
} from '@hire402/sdk';

/**
 * THE RESTART-RECOVERY DRILL (ops readiness): kill the registry mid-epoch,
 * keep transacting on-chain while it is DOWN, restart it, and prove that
 *   1. the indexer RESUMES from its checkpoint — every event mined during
 *      the outage is indexed (no re-scan, no gap)
 *   2. the anchor sequence stays GAPLESS on-chain — the restarted registry
 *      anchors latestEpoch + 1, exactly as designed
 *   3. registry state PERSISTS across the kill (agents, listings, score)
 *
 * Phases are driven by ops/run-restart-drill.sh:
 *   pre (registry UP) → kill → during (registry DOWN, chain keeps moving)
 *   → restart → post (assertions).
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const STATE_FILE = process.env.DRILL_STATE ?? '/tmp/hire402-restart-drill-state.json';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const FEE_BPS = 150n;
const JOB = 500_000n;
const log = (step: string, msg: string) => console.log(`[drill ] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return { escrow: raw.escrow as `0x${string}`, usdc: raw.usdc as `0x${string}`, anchor: raw.anchor as `0x${string}` };
}

async function advanceBlocks(pc: ReturnType<typeof publicClient>, n: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = pc as any;
  await raw.request({ method: 'anvil_mine', params: [n] });
}

async function runCycles(pc: ReturnType<typeof publicClient>, escrowAddr: `0x${string}`, usdcAddr: `0x${string}`, count: number): Promise<void> {
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const seller = walletClient(DEV.genesis as `0x${string}`, RPC);
  const buyerEscrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const sellerEscrow = new EscrowClient(pc, seller, escrowAddr, usdcAddr);
  const approveTx = await approve(buyer, usdcAddr, escrowAddr, 100_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const deadline = (await pc.getBlock()).timestamp + 86_400n;
  for (let i = 0; i < count; i++) {
    const esc = await buyerEscrow.create({
      seller: seller.account!.address, feeBps: FEE_BPS, challengeSeconds: 60n,
      milestones: [{ amount: JOB, deadline, descriptionURI: `ipfs://drill-${Date.now()}-${i}` }],
    });
    await buyerEscrow.fund(esc.id);
    await sellerEscrow.start(esc.id);
    await sellerEscrow.submit(esc.id, 0n, `ipfs://drill-att-${i}`);
    await buyerEscrow.approve(esc.id, 0n);
  }
  await advanceBlocks(pc, 4);
}

async function main() {
  const phase = process.argv[2];
  const { escrow: escrowAddr, usdc: usdcAddr, anchor: anchorAddr } = loadDeployment();
  const pc = publicClient(RPC);
  const worker = walletClient(DEV.genesis as `0x${string}`, RPC);
  const workerAddr = worker.account!.address;

  if (phase === 'pre') {
    const rc = new RegistryClient(REGISTRY_URL, worker, pc);
    await rc.post('/v1/agents', {
      address: workerAddr,
      agentCardUrl: 'http://genesis.example/.well-known/agent-card.json',
      x402: { chains: ['eip155:31337'], assets: ['USDC'] },
    });
    await rc.post('/v1/listings', { unit: 'task:research', pricing: { model: 'exact', amount: '2000000' } });
    await runCycles(pc, escrowAddr, usdcAddr, 2);
    let epoch = 0;
    for (let t = 0; t < 40 && epoch < 2; t++) {
      epoch = Number(await pc.readContract({ address: anchorAddr, abi: ANCHOR_ABI, functionName: 'latestEpoch' }));
      if (epoch < 2) await sleep(1500);
    }
    if (epoch < 2) throw new Error('no epochs anchored pre-kill');
    fs.writeFileSync(STATE_FILE, JSON.stringify({ worker: workerAddr, preEpoch: epoch, jobs: 2 }));
    log('pre', `2 cycles done; on-chain latestEpoch=${epoch}; state → ${STATE_FILE}`);
    return;
  }

  if (phase === 'during') {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { worker: string; preEpoch: number; jobs: number };
    await runCycles(pc, escrowAddr, usdcAddr, 2);
    state.jobs = 4;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    log('down', `registry is DOWN: 2 more cycles mined on-chain (${state.jobs} total)`);
    return;
  }

  if (phase === 'post') {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { worker: string; preEpoch: number; jobs: number };
    const rc = new RegistryClient(REGISTRY_URL, worker, pc);
    let completed = 0;
    let record: Record<string, unknown> | undefined;
    for (let t = 0; t < 60; t++) {
      record = (await rc.get(`/v1/agents/${state.worker}`)) as unknown as Record<string, unknown>;
      completed = ((record.reputation as { completedJobs?: number } | undefined)?.completedJobs) ?? 0;
      if (completed === state.jobs) break;
      await sleep(1500);
    }
    const anchorInfo = (await rc.get('/v1/anchor')) as unknown as { latestEpoch: number };
    const onChainLatest = Number(await pc.readContract({ address: anchorAddr, abi: ANCHOR_ABI, functionName: 'latestEpoch' }));
    let gapless = true;
    for (let e = 1; e <= onChainLatest; e++) {
      const [, , anchored] = (await pc.readContract({
        address: anchorAddr, abi: ANCHOR_ABI, functionName: 'epochAt', args: [BigInt(e)],
      })) as readonly [string, bigint, boolean];
      if (!anchored) gapless = false;
    }
    const credit = (record?.creditScore as { score?: number } | undefined)?.score ?? 0;
    const listings = ((record?.listings as string[] | undefined) ?? []).length;

    const checks: [string, string, string, boolean][] = [
      ['indexer resumed through the outage (4/4 jobs indexed)', `${state.jobs}`, `${completed}`, completed === state.jobs],
      ['anchor sequence continued past the pre-kill epoch', `> ${state.preEpoch}`, `${onChainLatest}`, onChainLatest > state.preEpoch],
      ['anchor sequence gapless 1..N', 'true', `${gapless}`, gapless],
      ['registry /v1/anchor synced with the chain', `${onChainLatest}`, `${anchorInfo.latestEpoch}`, anchorInfo.latestEpoch === onChainLatest],
      ['registry state persisted (listing survived the kill)', '>=1', `${listings}`, listings >= 1],
      ['credit score intact after restart', '850', `${credit}`, credit === 850],
    ];
    let ok = true;
    for (const [name, expected, actual, passed] of checks) {
      ok = ok && passed;
      log('post', `${passed ? '✓' : '✗'} ${name}: expected ${expected} | actual ${actual}`);
    }
    console.log(ok ? '\nRESTART RECOVERY DRILL: PASS' : '\nRESTART RECOVERY DRILL: FAIL');
    process.exit(ok ? 0 : 1);
  }

  throw new Error(`unknown phase: ${phase} (want pre|during|post)`);
}

main().catch((e) => {
  console.error('[drill ] FAILED:', e);
  process.exit(1);
});
