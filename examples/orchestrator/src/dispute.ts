import fs from 'node:fs';
import path from 'node:path';
import {
  ANVIL_RPC,
  DEV,
  BondClient,
  EscrowClient,
  EscrowState,
  courtDomain,
  signVerdict,
  approve,
  balanceOf,
  getTask,
  postTask,
  publicClient,
  walletClient,
  type TaskStatus,
} from '@hire402/sdk';

/**
 * THE DISPUTE DEMO (roadmap Phase 2 acceptance §3):
 *
 *   1. Buyer escrows a research task with the genesis agent.
 *   2. Genesis works and submits an attestation.
 *   3. Buyer disputes (evidence pointer = the worker's task URL).
 *   4. A BAD verifier (staked) submits an incorrect verdict — the scripted
 *      meta-dispute.
 *   5. The HONEST verifier independently recomputes the work hash, matches
 *      the on-chain attestation, and submits the correct verdict.
 *   6. The court resolves on-chain (release) and SLASHES the bad verifier:
 *      50% to the harmed buyer, 50% to the verifier pool.
 *
 * Assertions: fee captured, seller paid, bad verifier slashed, good verifier
 * bond intact, escrow Complete, court case resolved.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const RESEARCHER_URL = process.env.RESEARCHER_URL ?? 'http://127.0.0.1:4110';
const COURT_URL = process.env.COURT_URL ?? 'http://127.0.0.1:4130';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const PRICE = 2_000_000n; // 2.00 USDC
const FEE_BPS = 150n;
const EXPECTED_FEE = (PRICE * FEE_BPS) / 10_000n; // 0.03 USDC
const SLASH = 500_000n; // 0.50 USDC (court default)

const usdc = (base: bigint) => (Number(base) / 1e6).toFixed(2);
const log = (step: string, msg: string) => console.log(`[dispute] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CourtCase {
  caseId: string;
  status: 'open' | 'resolved';
  slashed: { verifier: string; amount: string }[];
  resolution?: { releaseToSeller: boolean; verdictURI: string; resolveTx: string };
  verdicts: { verifier: string; correct: boolean }[];
}

interface Assertion { name: string; expected: string; actual: string; pass: boolean }

function loadDeployment() {
  if (process.env.ESCROW_ADDRESS && process.env.USDC_ADDRESS && process.env.BOND_ADDRESS) {
    return {
      escrow: process.env.ESCROW_ADDRESS as `0x${string}`,
      usdc: process.env.USDC_ADDRESS as `0x${string}`,
      bond: process.env.BOND_ADDRESS as `0x${string}`,
    };
  }
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return {
    escrow: raw.escrow as `0x${string}`,
    usdc: raw.usdc as `0x${string}`,
    bond: raw.bond as `0x${string}`,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr, bond: bondAddr } = loadDeployment();
  const pc = publicClient(RPC);
  const chainId = BigInt(await pc.getChainId());

  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const escrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const badVerifierWc = walletClient(DEV.badVerifier as `0x${string}`, RPC);
  const badVerifier = new BondClient(pc, badVerifierWc, bondAddr, usdcAddr);
  const buyerBond = new BondClient(pc, buyer, bondAddr, usdcAddr);

  const buyerAddr = escrow.account;
  const genesisInfo = (await (await fetch(`${RESEARCHER_URL}/wallet`)).json()) as { address: string };
  const genesis = genesisInfo.address as `0x${string}`;
  log('0', `buyer ${buyerAddr} | escrow ${escrowAddr} | bond ${bondAddr}`);

  const verifierUrls = ['http://127.0.0.1:4140', 'http://127.0.0.1:4141', 'http://127.0.0.1:4142'];
  const verifierInfos: { address: `0x${string}`; stake: string }[] = [];
  for (const u of verifierUrls) {
    const info = (await (await fetch(`${u}/wallet`)).json()) as { address: string; stake: string };
    verifierInfos.push({ address: info.address as `0x${string}`, stake: info.stake });
  }
  log('0', `jury: ${verifierInfos.map((v) => `${v.address.slice(0, 10)}… (stake ${v.stake})`).join(', ')}`);
  const badVerifierAddr = badVerifierWc.account!.address;

  // --- 1. Escrow the work ---
  const deadline = (await pc.getBlock()).timestamp + 3600n;
  const { id, hash: createTx } = await escrow.create({
    seller: genesis,
    feeBps: FEE_BPS,
    challengeSeconds: 60n,
    milestones: [{ amount: PRICE, deadline, descriptionURI: 'ipfs://dispute-demo-1' }],
  });
  const approveTx = await approve(buyer, usdcAddr, escrowAddr, 10_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const fundTx = await escrow.fund(id);
  log('1', `escrow #${id} funded ${usdc(PRICE)} USDC`);

  // --- 2. Dispatch the work; wait for submission ---
  const description = 'Summarize the state of agent-to-agent commerce in three bullet points.';
  const t0 = await postTask(RESEARCHER_URL, {
    escrowId: id.toString(), milestoneIndex: 0, buyer: buyerAddr, description,
  });
  let task: TaskStatus = t0;
  const submitBy = Date.now() + 60_000;
  while (task.status !== 'submitted' && Date.now() < submitBy) {
    await sleep(2000);
    task = await getTask(RESEARCHER_URL, t0.taskId);
  }
  if (task.status !== 'submitted') throw new Error(`worker never submitted (status=${task.status})`);
  log('2', `worker submitted attestation ${task.attestation}`);

  // --- 3. Buyer disputes; the evidence pointer is the worker's task URL ---
  const disputeTx = await escrow.dispute(id, 0n, `${RESEARCHER_URL}/tasks/${t0.taskId}`);
  log('3', `disputed on-chain (${disputeTx.slice(0, 10)}…) — evidence ${RESEARCHER_URL}/tasks/${t0.taskId}`);

  // --- 4. Wait for the court to open the case, THEN stake the bad verifier
  //         and submit an INCORRECT verdict (the scripted meta-dispute). ---
  const caseOpenBy = Date.now() + 30_000;
  let caseOpen = false;
  while (Date.now() < caseOpenBy) {
    const res = await fetch(`${COURT_URL}/cases/${id}-0`);
    if (res.ok) {
      const c = (await res.json()) as CourtCase;
      if (c.status === 'open') {
        caseOpen = true;
        break;
      }
    }
    await sleep(1000);
  }
  if (!caseOpen) throw new Error('court never opened the case');

  const stakeNow = await badVerifier.stakeOf(badVerifierAddr);
  if (stakeNow < 1_000_000n) {
    const approveBond = await approve(badVerifierWc, usdcAddr, bondAddr, 10_000_000n);
    await pc.waitForTransactionReceipt({ hash: approveBond });
    await badVerifier.stake(1_000_000n);
  }
  const badTs = BigInt(Math.floor(Date.now() / 1000));
  const badMessage = {
    escrowId: id, milestoneIndex: 0n, releaseToSeller: false,
    proofHash: `0x${'fa'.repeat(32)}` as `0x${string}`, // fabricated "proof"
    verdictURI: 'ipfs://fabricated-verdict', ts: badTs,
  };
  const badSig = await signVerdict(badVerifierWc, courtDomain(chainId), badMessage);
  const badRes = (await (await fetch(`${COURT_URL}/verdicts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      escrowId: id.toString(), milestoneIndex: '0', releaseToSeller: false,
      proofHash: badMessage.proofHash, verdictURI: badMessage.verdictURI,
      ts: badTs.toString(), sig: badSig, verifier: badVerifierAddr,
    }),
  })).json()) as { accepted?: boolean; correct?: boolean };
  log('4', `bad verifier verdict accepted=${badRes.accepted} correct=${badRes.correct} (bond at risk)`);

  // --- 5. The honest verifier sees the case; wait for court resolution ---
  const resolveBy = Date.now() + 120_000;
  let caseData: CourtCase | null = null;
  while (Date.now() < resolveBy) {
    await sleep(2000);
    const res = await fetch(`${COURT_URL}/cases/${id}-0`);
    if (res.ok) {
      caseData = (await res.json()) as CourtCase;
      if (caseData?.status === 'resolved') break;
    }
  }
  if (caseData?.status !== 'resolved') throw new Error(`court never resolved (case=${JSON.stringify(caseData)})`);
  log('5', `court resolved; slashed: ${JSON.stringify(caseData.slashed)}`);

  // --- 6. Collect + assert (retry-stabilized for public RPCs) ---
  let assertions: Assertion[] = [];
  for (let round = 0; round < 15; round++) {
    const core = await escrow.core(id);
    const totals = await escrow.totals(id);
    const genesisEnd = await balanceOf(pc, usdcAddr, genesis);
    const badStake = await buyerBond.stakeOf(badVerifierAddr);
    const buyerEnd = await balanceOf(pc, usdcAddr, buyerAddr);
    const goodStakes = await Promise.all(verifierInfos.map((v) => buyerBond.stakeOf(v.address)));
    assertions = [
      { name: 'escrow Complete', expected: 'Complete', actual: `${core.state}`, pass: Number(core.state) === EscrowState.Complete },
      { name: 'fee captured == 150 bps', expected: `${EXPECTED_FEE}`, actual: `${totals.feesPaid}`, pass: totals.feesPaid === EXPECTED_FEE },
      { name: 'seller paid (payout)', expected: `${PRICE - EXPECTED_FEE}`, actual: `${genesisEnd}`, pass: genesisEnd === PRICE - EXPECTED_FEE },
      { name: 'bad verifier slashed (stake reduced)', expected: `${1_000_000n - SLASH}`, actual: `${badStake}`, pass: badStake === 1_000_000n - SLASH },
      {
        name: 'all honest jurors bonds intact',
        expected: verifierInfos.map((v) => v.stake).join(','),
        actual: goodStakes.map((s) => s.toString()).join(','),
        pass: goodStakes.every((s, i) => s === BigInt(verifierInfos[i].stake)),
      },
      { name: 'buyer compensated with slash share', expected: `${100_000_000n - PRICE + SLASH / 2n}`, actual: `${buyerEnd}`, pass: buyerEnd === 100_000_000n - PRICE + SLASH / 2n },
      { name: 'court case resolved with one slash', expected: '1 slashed', actual: `${caseData?.slashed?.length ?? 0} slashed`, pass: caseData?.slashed?.length === 1 },
    ];
    if (assertions.every((a) => a.pass)) break;
    await sleep(2000);
  }

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'dispute', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    chain: { rpc: RPC, escrow: escrowAddr, bond: bondAddr, usdc: usdcAddr },
    actors: { genesis, buyer: buyerAddr, jury: verifierInfos.map((v) => v.address), badVerifier: badVerifierAddr },
    escrowId: id.toString(),
    transactions: { createTx, fundTx, submitTx: task.submitTx, disputeTx },
    economics: {
      grossUsdc: usdc(PRICE), feeCapturedUsdc: usdc(EXPECTED_FEE),
      payoutUsdc: usdc(PRICE - EXPECTED_FEE),
      slashUsdc: usdc(SLASH),
      buyerSlashShareUsdc: usdc(SLASH / 2n),
    },
    court: caseData,
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `dispute-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('6', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('7', `report → ${reportPath}`);
  console.log(passed ? '\nDISPUTE DEMO: PASS' : '\nDISPUTE DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[dispute] FAILED:', e);
  process.exit(1);
});
