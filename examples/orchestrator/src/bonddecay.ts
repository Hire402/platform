import fs from 'node:fs';
import path from 'node:path';
import {
  ANVIL_RPC,
  DEV,
  EscrowClient,
  RegistryClient,
  approve,
  publicClient,
  walletClient,
} from '@hire402/sdk';

/**
 * THE BOND-DECAY DEMO (Phase 2 checkbox, spec §8): the staking requirement
 * decays with clean work — linearly, to the 10% floor after 25 clean jobs —
 * and a dispute resets the counter.
 *
 *   1. register the genesis agent + two listings (2.00, 1.00 → median 1.50)
 *   2. run 3 CLEAN jobs  → decay 8920 bps (−3.6% × 3)
 *   3. run 1 DISPUTED job → counter resets to zero (decay back to 10000)
 *   4. run 25 CLEAN jobs → 10% floor hit (decay 1000 bps)
 *
 * Every number is read from the registry's bond endpoint, which derives it
 * from the continuous indexer's on-chain event trail — no self-reported data.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const FEE_BPS = 150n;
const JOB = 500_000n; // 0.50 USDC per demo job
const CLEAN_FOR_DECAY = 3;
const CLEAN_FOR_FLOOR = 25;

const usdc6 = (b: string) => (Number(b) / 1e6).toFixed(2);
const log = (step: string, msg: string) => console.log(`[decay ] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Assertion { name: string; expected: string; actual: string; pass: boolean }

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return {
    escrow: raw.escrow as `0x${string}`,
    usdc: raw.usdc as `0x${string}`,
  };
}

/** Advance the chain so the indexer's confirmation lag clears (auto-mine). */
async function advanceBlocks(pc: ReturnType<typeof publicClient>, n: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = pc as any;
  await raw.request({ method: 'anvil_mine', params: [n] });
}

interface Bond {
  base: string; medianUnitPrice: string; cleanJobs: number;
  decayBps: string; requiredBond: string; floorHit: boolean;
}

/** Poll the bond endpoint until cleanJobs matches (indexer catches up on its own cadence). */
async function waitBond(
  rc: RegistryClient, addr: string, wantClean: number, timeoutMs: number,
): Promise<Bond> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const b = (await rc.get(`/v1/agents/${addr}/bond`)) as unknown as Bond;
    if (b.cleanJobs === wantClean) return b;
    if (Date.now() > deadline) throw new Error(`bond endpoint never reached cleanJobs=${wantClean} (stuck at ${b.cleanJobs})`);
    await sleep(1500);
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr } = loadDeployment();
  const pc = publicClient(RPC);
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const seller = walletClient(DEV.genesis as `0x${string}`, RPC); // the worker with listings
  const arbiter = walletClient(DEV.deployer as `0x${string}`, RPC); // dispute resolver
  const buyerAddr = buyer.account!.address;
  const sellerAddr = seller.account!.address;

  const buyerEscrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const sellerEscrow = new EscrowClient(pc, seller, escrowAddr, usdcAddr);
  const arbiterEscrow = new EscrowClient(pc, arbiter, escrowAddr, usdcAddr);
  const rc = new RegistryClient(REGISTRY_URL, seller, pc);

  log('0', `worker ${sellerAddr} lists services; requirement decays with clean work`);

  // --- 1. Register + list (median 1.50 across 2.00 and 1.00 listings) ---
  await rc.post('/v1/agents', {
    address: sellerAddr,
    agentCardUrl: 'http://genesis.example/.well-known/agent-card.json',
    x402: { chains: ['eip155:31337'], assets: ['USDC'] },
  });
  await rc.post('/v1/listings', { unit: 'task:research', pricing: { model: 'exact', amount: '2000000' } });
  await rc.post('/v1/listings', { unit: 'task:code', pricing: { model: 'exact', amount: '1000000' } });
  const b0 = (await rc.get(`/v1/agents/${sellerAddr}/bond`)) as unknown as Bond;
  log('1', `registered + 2 listings; base ${usdc6(b0.base)} USDC (median unit ${usdc6(b0.medianUnitPrice)}, min-bond floor), decay ${b0.decayBps} bps`);

  // --- 2. Escrow plumbing for the job cycles ---
  // Full seeded balance: 29 cycles × 0.50 ≈ 14.50 USDC needed.
  const approveTx = await approve(buyer, usdcAddr, escrowAddr, 100_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const deadline = (await pc.getBlock()).timestamp + 86_400n;

  const cleanCycle = async (i: number) => {
    const esc = await buyerEscrow.create({
      seller: sellerAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
      milestones: [{ amount: JOB, deadline, descriptionURI: `ipfs://clean-${i}` }],
    });
    await buyerEscrow.fund(esc.id);
    await sellerEscrow.start(esc.id);
    await sellerEscrow.submit(esc.id, 0n, `ipfs://att-clean-${i}`);
    await buyerEscrow.approve(esc.id, 0n);
  };
  const disputedCycle = async (i: number) => {
    const esc = await buyerEscrow.create({
      seller: sellerAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
      milestones: [{ amount: JOB, deadline, descriptionURI: `ipfs://disputed-${i}` }],
    });
    await buyerEscrow.fund(esc.id);
    await sellerEscrow.start(esc.id);
    await sellerEscrow.submit(esc.id, 0n, `ipfs://att-disputed-${i}`);
    await buyerEscrow.dispute(esc.id, 0n, 'ipfs://decay-demo-dispute');
    await arbiterEscrow.resolve(esc.id, 0n, true, 'ipfs://verdict-release'); // released — but NOT clean
  };

  // --- 3. Three clean jobs → −10.8% (8920 bps) ---
  for (let i = 0; i < CLEAN_FOR_DECAY; i++) await cleanCycle(i);
  await advanceBlocks(pc, 4);
  const b3 = await waitBond(rc, sellerAddr, CLEAN_FOR_DECAY, 90_000);
  log('2', `3 clean jobs → decay ${b3.decayBps} bps, requirement ${usdc6(b3.requiredBond)} USDC`);

  // --- 4. One disputed job → the counter resets ---
  await disputedCycle(0);
  await advanceBlocks(pc, 4);
  const br = await waitBond(rc, sellerAddr, 0, 90_000);
  log('3', `1 dispute → counter reset → decay ${br.decayBps} bps, requirement ${usdc6(br.requiredBond)} USDC`);

  // --- 5. Twenty-five clean jobs → the 10% floor ---
  for (let i = 0; i < CLEAN_FOR_FLOOR; i++) await cleanCycle(100 + i);
  await advanceBlocks(pc, 4);
  const bf = await waitBond(rc, sellerAddr, CLEAN_FOR_FLOOR, 120_000);
  log('4', `25 clean jobs → floor: decay ${bf.decayBps} bps, requirement ${usdc6(bf.requiredBond)} USDC (floorHit=${bf.floorHit})`);

  // --- 6. Assertions ---
  const assertions: Assertion[] = [
    { name: 'base = $500 floor (median 1.50 → 2×median < min)', expected: '500000000', actual: b0.base, pass: b0.base === '500000000' },
    { name: 'median unit price across listings', expected: '1500000', actual: b0.medianUnitPrice, pass: b0.medianUnitPrice === '1500000' },
    { name: 'no history → full requirement', expected: '10000', actual: b0.decayBps, pass: b0.decayBps === '10000' },
    { name: 'after 3 clean jobs: counter', expected: '3', actual: `${b3.cleanJobs}`, pass: b3.cleanJobs === 3 },
    { name: 'after 3 clean jobs: linear decay 10000 − 360×3', expected: '8920', actual: b3.decayBps, pass: b3.decayBps === '8920' },
    { name: 'after 3 clean jobs: requirement 89.2% of base', expected: '446000000', actual: b3.requiredBond, pass: b3.requiredBond === '446000000' },
    { name: 'dispute resets the counter', expected: '0', actual: `${br.cleanJobs}`, pass: br.cleanJobs === 0 },
    { name: 'dispute resets decay to full', expected: '10000', actual: br.decayBps, pass: br.decayBps === '10000' },
    { name: 'after 25 clean jobs: counter', expected: '25', actual: `${bf.cleanJobs}`, pass: bf.cleanJobs === 25 },
    { name: 'after 25 clean jobs: floor 10% of initial', expected: '1000', actual: bf.decayBps, pass: bf.decayBps === '1000' },
    { name: 'floor requirement 10% of base', expected: '50000000', actual: bf.requiredBond, pass: bf.requiredBond === '50000000' },
    { name: 'floorHit flag', expected: 'true', actual: `${bf.floorHit}`, pass: bf.floorHit === true },
  ];

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'bond-decay', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    actors: { worker: sellerAddr, buyer: buyerAddr },
    economics: {
      baseUsdc: usdc6(b0.base), medianUnitUsdc: usdc6(b0.medianUnitPrice),
      after3Usdc: usdc6(b3.requiredBond), afterResetUsdc: usdc6(br.requiredBond),
      floorUsdc: usdc6(bf.requiredBond),
      note: 'linear −3.6% of the initial requirement per clean job; 10% floor after 25 clean jobs; disputes reset the counter (spec §8)',
    },
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `bond-decay-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('6', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('7', `report → ${reportPath}`);
  console.log(passed ? '\nBOND DECAY DEMO: PASS' : '\nBOND DECAY DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[decay ] FAILED:', e);
  process.exit(1);
});
