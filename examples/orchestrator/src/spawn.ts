import fs from 'node:fs';
import path from 'node:path';
import {
  ANVIL_RPC,
  DEV,
  EscrowClient,
  approve,
  balanceOf,
  getTask,
  postTask,
  publicClient,
  walletClient,
  type TaskStatus,
} from '@hire402/sdk';

/**
 * THE SPAWN DEMO (Phase 2.5, spec §9): reproduction with capital allocation.
 *
 *   genesis (parent, solvent from its earnings) spawns a CHILD coder agent:
 *     1. child registers with lineage.parent = genesis (zero-funded)
 *     2. parent funds a SEED escrow (0.50 USDC) — the child's birth capital
 *     3. the child works a task:code and earns 1.50 USDC
 *     4. the child REPAYS the parent 0.55 (principal + interest) via a
 *        repayment escrow — the same machinery, no new contract types
 *     5. parent pays the 100 bps incorporation fee to the platform
 *
 * The economy reproduces without a committee of people.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const CHILD_URL = process.env.CHILD_URL ?? 'http://127.0.0.1:4121';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const SEED = 500_000n; // 0.50 USDC
const TASK = 1_400_000n; // 1.40 USDC (fits the parent's post-seed capital)
const REPAY = 550_000n; // principal + interest
const FEE_BPS = 150n;
const INCORP_FEE = (SEED * 100n) / 10_000n; // 100 bps of the seed

const usdc = (b: bigint) => (Number(b) / 1e6).toFixed(2);
const log = (step: string, msg: string) => console.log(`[spawn ] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Assertion { name: string; expected: string; actual: string; pass: boolean }

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return {
    escrow: raw.escrow as `0x${string}`,
    usdc: raw.usdc as `0x${string}`,
    treasury: raw.treasury as `0x${string}`,
  };
}

async function waitTaskStatus(url: string, taskId: string, want: string, timeoutMs: number): Promise<TaskStatus> {
  const deadline = Date.now() + timeoutMs;
  let t: TaskStatus = { taskId, status: 'working' };
  while (Date.now() < deadline) {
    t = await getTask(url, taskId);
    if (t.status === want || t.status === 'rejected') break;
    await sleep(2000);
  }
  return t;
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr, treasury } = loadDeployment();
  const pc = publicClient(RPC);
  const parent = walletClient(DEV.genesis as `0x${string}`, RPC); // the solvent worker reproduces
  const child = walletClient(DEV.child as `0x${string}`, RPC);
  const parentEscrow = new EscrowClient(pc, parent, escrowAddr, usdcAddr);
  const childEscrow = new EscrowClient(pc, child, escrowAddr, usdcAddr);
  const parentAddr = parent.account!.address;
  const childAddr = child.account!.address;

  const childInfo = (await (await fetch(`${CHILD_URL}/wallet`)).json()) as { address: string };
  if (childInfo.address.toLowerCase() !== childAddr.toLowerCase()) {
    throw new Error(`child service wallet ${childInfo.address} ≠ key address ${childAddr}`);
  }

  const parentBefore = await balanceOf(pc, usdcAddr, parentAddr);
  const treasuryBefore = await balanceOf(pc, usdcAddr, treasury);
  const childBefore = await balanceOf(pc, usdcAddr, childAddr);
  log('0', `parent ${parentAddr} (${usdc(parentBefore)} USDC) spawns child ${childAddr} (${usdc(childBefore)} USDC — zero-funded)`);

  // --- 1. Birth: the parent funds a SEED escrow; the child draws it ---
  const deadline = (await pc.getBlock()).timestamp + 86400n;
  const seed = await parentEscrow.create({
    seller: childAddr,
    feeBps: FEE_BPS,
    challengeSeconds: 60n,
    milestones: [{ amount: SEED, deadline, descriptionURI: 'ipfs://seed-draw' }],
  });
  const approveTx = await approve(parent, usdcAddr, escrowAddr, 10_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  await parentEscrow.fund(seed.id);
  const seedTask = await postTask(CHILD_URL, {
    escrowId: seed.id.toString(), milestoneIndex: 0, buyer: parentAddr,
    description: 'seed draw — use for compute costs',
  });
  const seedDone = await waitTaskStatus(CHILD_URL, seedTask.taskId, 'released', 180_000);
  if (seedDone.status !== 'released') throw new Error(`child never drew the seed (${seedDone.status}: ${seedDone.detail})`);
  log('1', `child drew the seed: ${usdc(SEED)} escrowed → ${usdc(SEED - (SEED * FEE_BPS) / 10_000n)} received`);

  // --- 2. The child works a task:code and earns ---
  const work = await parentEscrow.create({
    seller: childAddr,
    feeBps: FEE_BPS,
    challengeSeconds: 60n,
    milestones: [{ amount: TASK, deadline, descriptionURI: 'ipfs://spawn-work' }],
  });
  await parentEscrow.fund(work.id);
  const workTask = await postTask(CHILD_URL, {
    escrowId: work.id.toString(), milestoneIndex: 0, buyer: parentAddr,
    description: 'Write a tiny entrypoint module for the spawn demo.',
  });
  const workDone = await waitTaskStatus(CHILD_URL, workTask.taskId, 'released', 180_000);
  if (workDone.status !== 'released') throw new Error(`child never completed the work (${workDone.status}: ${workDone.detail})`);
  log('2', `child earned ${usdc(TASK)} gross from task:code`);

  // --- 3. Repayment: the child funds an escrow back to the parent ---
  const repay = await childEscrow.create({
    seller: parentAddr,
    feeBps: FEE_BPS,
    challengeSeconds: 60n,
    milestones: [{ amount: REPAY, deadline, descriptionURI: 'ipfs://seed-repayment' }],
  });
  const childApprove = await approve(child, usdcAddr, escrowAddr, 10_000_000n);
  await pc.waitForTransactionReceipt({ hash: childApprove });
  await childEscrow.fund(repay.id);
  // The parent accepts, attests receipt, and claims after the window.
  await parentEscrow.start(repay.id);
  await parentEscrow.submit(repay.id, 0n, 'ipfs://repayment-received');
  let claimed = false;
  const claimBy = Date.now() + 180_000;
  while (Date.now() < claimBy && !claimed) {
    const m = await parentEscrow.milestone(repay.id, 0n);
    if (Number(m.status) === 3) { claimed = true; break; } // Released
    const now = (await pc.getBlock()).timestamp;
    if (BigInt(m.submittedAt) + 60n < BigInt(now)) {
      try {
        await parentEscrow.claimTimeout(repay.id, 0n);
        claimed = true;
      } catch {
        await sleep(2000);
      }
    } else {
      await sleep(2000);
    }
  }
  if (!claimed) throw new Error('parent never claimed the repayment');
  log('3', `child repaid ${usdc(REPAY)} (principal ${usdc(SEED)} + interest) via escrow #${repay.id}`);

  // --- 4. Incorporation fee: 100 bps of the seed to the platform ---
  const { ERC20_ABI } = await import('@hire402/sdk');
  const incorpTx = await parent.writeContract({
    address: usdcAddr,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [treasury, INCORP_FEE],
    gas: 120_000n,
  });
  await pc.waitForTransactionReceipt({ hash: incorpTx });
  log('4', `incorporation fee ${usdc(INCORP_FEE)} → platform treasury`);

  // --- 5. Collect + assert (retry-stabilized) ---
  const childRecord = (await (await fetch(`${REGISTRY_URL}/v1/agents/${childAddr}`)).json()) as {
    lineage?: { parent?: string };
  };
  let assertions: Assertion[] = [];
  for (let round = 0; round < 15; round++) {
    const childAfter = await balanceOf(pc, usdcAddr, childAddr);
    const parentAfter = await balanceOf(pc, usdcAddr, parentAddr);
    const treasuryAfter = await balanceOf(pc, usdcAddr, treasury);
    const seedPayout = SEED - (SEED * FEE_BPS) / 10_000n;
    const taskPayout = TASK - (TASK * FEE_BPS) / 10_000n;
    const childNet = seedPayout + taskPayout - REPAY;
    // The parent pays for the work task (it's a purchase), receives the
    // repayment net of the escrow fee, and pays the incorporation fee.
    const repayFee = (REPAY * FEE_BPS) / 10_000n;
    const parentExpected = parentBefore - TASK + REPAY - repayFee - SEED - INCORP_FEE;
    // The treasury receives the incorporation fee + the three escrow fees.
    const feesExpected =
      treasuryBefore + INCORP_FEE + (SEED * FEE_BPS) / 10_000n + (TASK * FEE_BPS) / 10_000n + repayFee;
    assertions = [
      { name: 'child lineage recorded (parent = genesis)', expected: parentAddr, actual: childRecord.lineage?.parent ?? 'none', pass: childRecord.lineage?.parent?.toLowerCase() === parentAddr.toLowerCase() },
      { name: 'child net after seed + work − repay', expected: `${childNet}`, actual: `${childAfter}`, pass: childAfter === childNet },
      { name: 'parent net (repayment − work − seed − fees)', expected: `${parentExpected}`, actual: `${parentAfter}`, pass: parentAfter === parentExpected },
      { name: 'treasury captured fees + incorporation fee', expected: `${feesExpected}`, actual: `${treasuryAfter}`, pass: treasuryAfter === feesExpected },
    ];
    if (assertions.every((a) => a.pass)) break;
    await sleep(2000);
  }

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'spawn', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    actors: { parent: parentAddr, child: childAddr },
    seedEscrowId: seed.id.toString(),
    workEscrowId: work.id.toString(),
    repayEscrowId: repay.id.toString(),
      economics: {
      seedUsdc: usdc(SEED),
      workUsdc: usdc(TASK),
      repayUsdc: usdc(REPAY),
      incorpFeeUsdc: usdc(INCORP_FEE),
      note: 'parent funds the seed; child earns from the market; child repays principal+interest via escrow; the economy reproduces without a committee of people',
    },
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `spawn-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('5', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('6', `report → ${reportPath}`);
  console.log(passed ? '\nSPAWN DEMO: PASS' : '\nSPAWN DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[spawn ] FAILED:', e);
  process.exit(1);
});
