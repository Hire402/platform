import fs from 'node:fs';
import path from 'node:path';
import {
  ANVIL_RPC,
  DEV,
  EscrowClient,
  RegistryClient,
  approve,
  balanceOf,
  getTask,
  postTask,
  publicClient,
  walletClient,
  type TaskStatus,
} from '@hire402/sdk';

/**
 * THE GENESIS RUN (roadmap §2) — the thesis in one script:
 *
 *   A zero-funded agent registers itself, earns its first USDC doing work
 *   for another agent through escrow (150 bps fee captured), pays its own
 *   inference bill, and ends the run SOLVENT.
 *
 * A person starts the run; every step after — register, escrow, work,
 * claim — is agent-driven.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const RESEARCHER_URL = process.env.RESEARCHER_URL ?? 'http://127.0.0.1:4110';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const PRICE = 2_000_000n; // 2.00 USDC
const FEE_BPS = 150n;
const EXPECTED_FEE = (PRICE * FEE_BPS) / 10_000n; // 0.03 USDC
const INFERENCE_PRICE = 800_000n; // 0.80 USDC
const EXPECTED_GENESIS_NET = PRICE - EXPECTED_FEE - INFERENCE_PRICE; // 1.17 USDC

const usdc = (base: bigint) => (Number(base) / 1e6).toFixed(2);
const log = (step: string, msg: string) => console.log(`[run] ${step.padEnd(6)} ${msg}`);

interface Assertion {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

function loadDeployment() {
  const env = process.env.ESCROW_ADDRESS && process.env.USDC_ADDRESS;
  if (env) {
    return {
      escrow: process.env.ESCROW_ADDRESS as `0x${string}`,
      usdc: process.env.USDC_ADDRESS as `0x${string}`,
      chainId: 31337,
    };
  }
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return { escrow: raw.escrow as `0x${string}`, usdc: raw.usdc as `0x${string}`, chainId: raw.chainId as number };
}

/** The four Genesis Run assertions (spec §13; roadmap §2). */
function buildAssertions(
  totals: { feesPaid: bigint },
  genesisEnd: bigint,
  metabolic: { status: string },
  task: TaskStatus,
  createTx: string,
  fundTx: string,
): Assertion[] {
  return [
    {
      name: 'feeCaptured == 150 bps of gross',
      expected: `${EXPECTED_FEE} (0.03 USDC)`,
      actual: `${totals.feesPaid} (${usdc(totals.feesPaid)} USDC)`,
      pass: totals.feesPaid === EXPECTED_FEE,
    },
    {
      name: 'genesis net > 0 (earned more than it burned)',
      expected: `${EXPECTED_GENESIS_NET} (1.17 USDC)`,
      actual: `${genesisEnd} (${usdc(genesisEnd)} USDC)`,
      pass: genesisEnd === EXPECTED_GENESIS_NET,
    },
    {
      name: 'solvency == SOLVENT (early-solvency rule)',
      expected: 'solvent',
      actual: metabolic.status,
      pass: metabolic.status === 'solvent',
    },
    {
      name: 'all event ids present',
      expected: 'createTx, fundTx, startTx, submitTx, claimTx, inferenceTx',
      actual: `${Boolean(createTx && fundTx && task.startTx && task.submitTx && task.claimTx && task.inferenceTx)}`,
      pass: Boolean(createTx && fundTx && task.startTx && task.submitTx && task.claimTx && task.inferenceTx),
    },
  ];
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr } = loadDeployment();
  const pc = publicClient(RPC);
  const liveChainId = Number(await pc.getChainId());
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const escrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const registry = new RegistryClient(REGISTRY_URL, buyer, pc);
  const buyerAddr = escrow.account;
  log('0', `buyer agent ${buyerAddr} | escrow ${escrowAddr} | USDC ${usdcAddr}`);

  // --- 1. The genesis agent (zero-funded) ---
  const walletRes = await fetch(`${RESEARCHER_URL}/wallet`);
  if (!walletRes.ok) throw new Error(`researcher not reachable: ${walletRes.status}`);
  const genesisInfo = (await walletRes.json()) as { address: string };
  const genesis = genesisInfo.address as `0x${string}`;
  const genesisStart = await balanceOf(pc, usdcAddr, genesis);
  if (genesisStart !== 0n) throw new Error(`genesis not zero-funded: ${genesisStart}`);
  log('1', `genesis agent ${genesis} — USDC balance ${usdc(genesisStart)} (zero-funded ✓)`);

  // --- 2. Verify the listing exists (the market has a seller) ---
  const listings = (await registry.get('/v1/listings?unit=task:research')) as {
    listings: { id: string; unit: string; seller: string }[];
    count: number;
  };
  if (!listings.count) throw new Error('no task:research listings in the market');
  log('2', `market: ${listings.count} task:research listing(s); buyer found ${listings.listings[0].id}`);

  // --- 3. Create + fund + start the escrow ---
  const deadline = (await pc.getBlock()).timestamp + 3600n;
  const { id, hash: createTx } = await escrow.create({
    seller: genesis,
    feeBps: FEE_BPS,
    challengeSeconds: 60n, // 1 minute for the demo (MIN_CHALLENGE in-contract)
    milestones: [
      { amount: PRICE, deadline, descriptionURI: 'ipfs://genesis-run-1' },
    ],
  });
  const approveTx = await approve(buyer, usdcAddr, escrowAddr, 10_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const fundTx = await escrow.fund(id);
  log('3', `escrow #${id} funded ${usdc(PRICE)} USDC (create ${createTx.slice(0, 10)}… fund ${fundTx.slice(0, 10)}…)`);

  // --- 4. Register the escrow with the registry (indexing) ---
  await registry.post('/v1/escrows', { escrowId: id.toString() });
  log('4', `registry indexing escrow #${id}`);

  // --- 5. Delegate the work over A2A-semantics ---
  const description = 'Summarize the state of agent-to-agent commerce in three bullet points.';
  const t0 = await postTask(RESEARCHER_URL, {
    escrowId: id.toString(),
    milestoneIndex: 0,
    buyer: buyerAddr,
    description,
  });
  log('5', `task ${t0.taskId} dispatched to genesis agent`);

  // --- 6. Wait for the full agent loop: work → submit → window → claim → pay bills ---
  let task: TaskStatus = t0;
  const deadlineMs = Date.now() + 240_000;
  let last = '';
  while (Date.now() < deadlineMs) {
    task = await getTask(RESEARCHER_URL, t0.taskId);
    if (task.status !== last) {
      log('6', `agent status: ${task.status}${task.detail ? ` (${task.detail})` : ''}`);
      last = task.status;
    }
    if (task.status === 'solvent' || task.status === 'rejected') break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (task.status !== 'solvent') {
    throw new Error(`genesis agent did not reach solvent (status=${task.status}, detail=${task.detail})`);
  }

  // --- 7. Collect results and assert the Genesis Run economics ---
  // Public RPCs are eventually consistent across backends — collect with
  // retries until the assertions stabilize (or give up and report failure).
  let totals = await escrow.totals(id);
  let genesisEnd = await balanceOf(pc, usdcAddr, genesis);
  let metabolic = (await fetch(`${REGISTRY_URL}/v1/agents/${genesis}/metabolic`).then(
    (r) => r.json(),
  )) as { status: string; incomeNet: string; burn: string; net: string; runwayNote: string };
  let assertions: Assertion[] = [];
  for (let round = 0; round < 15; round++) {
    assertions = buildAssertions(totals, genesisEnd, metabolic, task, createTx, fundTx);
    if (assertions.every((a) => a.pass)) break;
    await new Promise((r) => setTimeout(r, 2000));
    totals = await escrow.totals(id);
    genesisEnd = await balanceOf(pc, usdcAddr, genesis);
    metabolic = (await fetch(`${REGISTRY_URL}/v1/agents/${genesis}/metabolic`).then(
      (r) => r.json(),
    )) as { status: string; incomeNet: string; burn: string; net: string; runwayNote: string };
  }

  const passed = assertions.every((a) => a.pass);

  const report = {
    run: 'genesis',
    version: '0.1.0',
    startedAt,
    finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    chain: { chainId: liveChainId, rpc: RPC, escrow: escrowAddr, usdc: usdcAddr },
    actors: { genesis, buyer: buyerAddr },
    escrowId: id.toString(),
    task: {
      taskId: task.taskId,
      description,
      attestation: task.attestation,
      result: task.result,
    },
    transactions: {
      createTx,
      fundTx,
      startTx: task.startTx,
      submitTx: task.submitTx,
      claimTx: task.claimTx,
      inferenceTx: task.inferenceTx,
    },
    economics: {
      grossUsdc: usdc(PRICE),
      feeBps: Number(FEE_BPS),
      feeCapturedUsdc: usdc(totals.feesPaid),
      payoutUsdc: usdc(totals.released - totals.feesPaid),
      inferenceBurnUsdc: usdc(INFERENCE_PRICE),
      genesisNetUsdc: usdc(genesisEnd),
      startingBalanceUsdc: usdc(genesisStart),
    },
    metabolic,
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };

  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `genesis-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  for (const a of assertions) {
    log('7', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  }
  log('8', `report → ${reportPath}`);
  console.log(passed ? '\nGENESIS RUN: PASS' : '\nGENESIS RUN: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[run] FAILED:', e);
  process.exit(1);
});

