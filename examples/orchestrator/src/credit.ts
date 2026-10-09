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
 * THE CREDIT-SCORE DEMO (spec §8, published formula): agents can predict
 * their own credit — every input is on-chain, every step is exact.
 *
 *   1. a fresh agent scores 575 (all components neutral at 50%) — above
 *      the ≥ 500 advance gate, because a FIRST advance must be obtainable
 *   2. after 2 clean delivered jobs: repayment/SLA/dispute perfect, the
 *      agent is solvent → the maximum score, 850
 *   3. one disputed job resolved as REFUND (the agent failed to deliver)
 *      drags the repayment component to 2/3 → the score drops to exactly 776
 *
 * The desk's ≥ 500 gate is verified against this endpoint, not desk gossip.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const FEE_BPS = 150n;
const JOB = 500_000n; // 0.50 USDC per job
const CLEAN_JOBS = 2;

const log = (step: string, msg: string) => console.log(`[credit] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Assertion { name: string; expected: string; actual: string; pass: boolean }

interface Score {
  score: number;
  qualifiesForAdvance: boolean;
  components: { repaymentBps: number; slaBps: number; disputeBps: number; runwayBps: number };
  observations: { released: number; refunded: number; runwayStatus: string };
}

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return { escrow: raw.escrow as `0x${string}`, usdc: raw.usdc as `0x${string}` };
}

/** Advance the chain so the indexer's confirmation lag clears (auto-mine). */
async function advanceBlocks(pc: ReturnType<typeof publicClient>, n: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = pc as any;
  await raw.request({ method: 'anvil_mine', params: [n] });
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr } = loadDeployment();
  const pc = publicClient(RPC);
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const seller = walletClient(DEV.genesis as `0x${string}`, RPC);
  const arbiter = walletClient(DEV.deployer as `0x${string}`, RPC);
  const sellerAddr = seller.account!.address;

  const buyerEscrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const sellerEscrow = new EscrowClient(pc, seller, escrowAddr, usdcAddr);
  const arbiterEscrow = new EscrowClient(pc, arbiter, escrowAddr, usdcAddr);
  const rc = new RegistryClient(REGISTRY_URL, seller, pc);

  const scoreOf = async (): Promise<Score> =>
    (await rc.get(`/v1/agents/${sellerAddr}/credit-score`)) as unknown as Score;

  log('0', `worker ${sellerAddr}; the published formula, verified live`);

  // --- 1. Fresh agent: all components neutral → exactly 575 ---
  await rc.post('/v1/agents', {
    address: sellerAddr,
    agentCardUrl: 'http://genesis.example/.well-known/agent-card.json',
    x402: { chains: ['eip155:31337'], assets: ['USDC'] },
  });
  const fresh = await scoreOf();
  log('1', `fresh agent scores ${fresh.score} (all neutral) — qualifies for a first advance: ${fresh.qualifiesForAdvance}`);

  // --- 2. Two clean delivered jobs → the maximum, 850 ---
  const approveTx = await approve(buyer, usdcAddr, escrowAddr, 100_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const deadline = (await pc.getBlock()).timestamp + 86_400n;
  for (let i = 0; i < CLEAN_JOBS; i++) {
    const esc = await buyerEscrow.create({
      seller: sellerAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
      milestones: [{ amount: JOB, deadline, descriptionURI: `ipfs://credit-clean-${i}` }],
    });
    await buyerEscrow.fund(esc.id);
    await sellerEscrow.start(esc.id);
    await sellerEscrow.submit(esc.id, 0n, `ipfs://att-clean-${i}`);
    await buyerEscrow.approve(esc.id, 0n);
  }
  let good: Score | undefined;
  await advanceBlocks(pc, 4);
  for (let t = 0; t < 30 && !good; t++) {
    const s = await scoreOf();
    if (s.observations.released === CLEAN_JOBS) good = s;
    else await sleep(1500);
  }
  if (!good) throw new Error('score never reflected the clean work');
  log('2', `after ${CLEAN_JOBS} clean jobs: repayment ${good.components.repaymentBps} bps, SLA ${good.components.slaBps} bps, dispute ${good.components.disputeBps} bps, runway ${good.observations.runwayStatus} → score ${good.score}`);

  // --- 3. A failed delivery (dispute → REFUND) drops repayment to 2/3 ---
  const failed = await buyerEscrow.create({
    seller: sellerAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
    milestones: [{ amount: JOB, deadline, descriptionURI: 'ipfs://credit-failed' }],
  });
  await buyerEscrow.fund(failed.id);
  await sellerEscrow.start(failed.id);
  await sellerEscrow.submit(failed.id, 0n, 'ipfs://att-failed');
  await buyerEscrow.dispute(failed.id, 0n, 'ipfs://credit-demo-dispute');
  await arbiterEscrow.resolve(failed.id, 0n, false, 'ipfs://verdict-refund'); // buyer refunded
  let afterFail: Score | undefined;
  await advanceBlocks(pc, 4);
  for (let t = 0; t < 30 && !afterFail; t++) {
    const s = await scoreOf();
    if (s.observations.refunded === 1) afterFail = s;
    else await sleep(1500);
  }
  if (!afterFail) throw new Error('score never reflected the failed delivery');
  log('3', `after a failed delivery: repayment ${afterFail.components.repaymentBps} bps (${CLEAN_JOBS}/${CLEAN_JOBS + 1}) → score ${afterFail.score}`);

  // --- 4. Assertions (every number predicted by the published formula) ---
  const assertions: Assertion[] = [
    { name: 'fresh agent: neutral score', expected: '575', actual: `${fresh.score}`, pass: fresh.score === 575 },
    { name: 'fresh agent: qualifies for a first advance', expected: 'true', actual: `${fresh.qualifiesForAdvance}`, pass: fresh.qualifiesForAdvance === true },
    { name: 'clean work: maximum score', expected: '850', actual: `${good.score}`, pass: good.score === 850 },
    { name: 'clean work: repayment component', expected: '10000', actual: `${good.components.repaymentBps}`, pass: good.components.repaymentBps === 10000 },
    { name: 'clean work: SLA component (on-time submissions)', expected: '10000', actual: `${good.components.slaBps}`, pass: good.components.slaBps === 10000 },
    { name: 'clean work: solvent runway', expected: 'solvent', actual: good.observations.runwayStatus, pass: good.observations.runwayStatus === 'solvent' },
    { name: 'failed delivery: repayment 2/3', expected: '6666', actual: `${afterFail.components.repaymentBps}`, pass: afterFail.components.repaymentBps === 6666 },
    { name: 'failed delivery: exact score 776', expected: '776', actual: `${afterFail.score}`, pass: afterFail.score === 776 },
    { name: 'failed delivery: still above the gate', expected: 'true', actual: `${afterFail.qualifiesForAdvance}`, pass: afterFail.qualifiesForAdvance === true },
  ];

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'credit', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    actors: { worker: sellerAddr },
    scores: { fresh: fresh.score, clean: good.score, afterFailure: afterFail.score },
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `credit-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('4', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('5', `report → ${reportPath}`);
  console.log(passed ? '\nCREDIT SCORE DEMO: PASS' : '\nCREDIT SCORE DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[credit] FAILED:', e);
  process.exit(1);
});
