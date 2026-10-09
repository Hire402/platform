import fs from 'node:fs';
import path from 'node:path';
import { concat, keccak256 } from 'viem';
import {
  ANCHOR_ABI,
  ANVIL_RPC,
  DEV,
  EscrowClient,
  RegistryClient,
  account,
  approve,
  publicClient,
  walletClient,
} from '@hire402/sdk';

/**
 * THE REPUTATION-ANCHOR DEMO (Phase 2.5, spec §7): the registry commits a
 * Merkle root over all self-registered agents' reputation aggregates
 * on-chain every epoch — a gapless sequence the CONTRACT enforces.
 *
 *   1. the registry anchors epoch 1 at boot (empty registry → sentinel root)
 *   2. the genesis worker registers and completes 3 clean jobs
 *   3. later epochs anchor the worker's aggregates (completedJobs = 3)
 *   4. a Merkle inclusion proof from the registry folds EXACTLY to the
 *      on-chain root — reputation is now provable to any third party
 *   5. an attempted gap (epoch latestEpoch + 2) reverts on-chain —
 *      the sequence can never lie
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const FEE_BPS = 150n;
const JOB = 500_000n; // 0.50 USDC per clean job
const CLEAN_JOBS = 3;

const log = (step: string, msg: string) => console.log(`[anchor] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Assertion { name: string; expected: string; actual: string; pass: boolean }

interface ProofResp {
  epoch: number; address: string; index: number; leaf: `0x${string}`;
  proof: `0x${string}`[]; root: string; contract: string;
  entry: { completedJobs: string; disputedJobs: string; slashed: string };
}
interface AnchorResp { latestEpoch: number; root: string | null; contract: string | null }

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return { escrow: raw.escrow as `0x${string}`, usdc: raw.usdc as `0x${string}`, anchor: raw.anchor as `0x${string}` };
}

/** Fold the proof: right-sibling when the index bit is 0. */
function foldProof(leaf: `0x${string}`, index: number, proof: `0x${string}`[]): string {
  let h = leaf;
  let idx = index;
  for (const sib of proof) {
    h = keccak256(idx % 2 === 0 ? concat([h, sib]) : concat([sib, h]));
    idx = Math.floor(idx / 2);
  }
  return h;
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr, anchor: anchorAddr } = loadDeployment();
  const pc = publicClient(RPC);
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const seller = walletClient(DEV.genesis as `0x${string}`, RPC);
  const sellerAddr = seller.account!.address;

  const buyerEscrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const sellerEscrow = new EscrowClient(pc, seller, escrowAddr, usdcAddr);
  const rc = new RegistryClient(REGISTRY_URL, seller, pc);

  log('0', `registry anchors a reputation root every epoch → ${anchorAddr}`);

  // --- 1. Register the worker + run 3 clean jobs ---
  await rc.post('/v1/agents', {
    address: sellerAddr,
    agentCardUrl: 'http://genesis.example/.well-known/agent-card.json',
    x402: { chains: ['eip155:31337'], assets: ['USDC'] },
  });
  const approveTx = await approve(buyer, usdcAddr, escrowAddr, 100_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const deadline = (await pc.getBlock()).timestamp + 86_400n;
  for (let i = 0; i < CLEAN_JOBS; i++) {
    const esc = await buyerEscrow.create({
      seller: sellerAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
      milestones: [{ amount: JOB, deadline, descriptionURI: `ipfs://anchor-clean-${i}` }],
    });
    await buyerEscrow.fund(esc.id);
    await sellerEscrow.start(esc.id);
    await sellerEscrow.submit(esc.id, 0n, `ipfs://att-${i}`);
    await buyerEscrow.approve(esc.id, 0n);
  }
  log('1', `worker registered; ${CLEAN_JOBS} clean jobs completed`);

  // --- 2. Wait for an epoch anchored AFTER the jobs (proof shows completed=3) ---
  let proof: ProofResp | undefined;
  const deadlineMs = Date.now() + 90_000;
  while (Date.now() < deadlineMs) {
    try {
      const p = (await rc.get(`/v1/anchor/proof/${sellerAddr}`)) as unknown as ProofResp;
      if (p.entry && p.entry.completedJobs === String(CLEAN_JOBS)) { proof = p; break; }
    } catch { /* not in the latest epoch yet — keep polling */ }
    await sleep(1500);
  }
  if (!proof) throw new Error('no anchored epoch captured the worker reputation (completed=3) in time');
  log('2', `epoch ${proof.epoch} anchored the worker: completed=${proof.entry.completedJobs}, leaf ${proof.leaf.slice(0, 12)}…`);

  // --- 3. On-chain state: gapless sequence, root match, gap enforcement ---
  // Chain + registry reads can race a tick (5s cadence) — retry until they agree.
  let onChainLatest = 0;
  let anchorInfo: AnchorResp | undefined;
  for (let t = 0; t < 6 && !anchorInfo; t++) {
    onChainLatest = Number(await pc.readContract({
      address: anchorAddr, abi: ANCHOR_ABI, functionName: 'latestEpoch',
    }));
    anchorInfo = (await rc.get('/v1/anchor')) as unknown as AnchorResp;
    if (anchorInfo.latestEpoch !== onChainLatest) {
      anchorInfo = undefined;
      await sleep(2000);
    }
  }
  if (!anchorInfo) throw new Error('registry /v1/anchor never synced with the on-chain latestEpoch');
  const epochRoots: string[] = [];
  let allAnchored = true;
  for (let e = 1; e <= onChainLatest; e++) {
    const [root, , anchored] = (await pc.readContract({
      address: anchorAddr, abi: ANCHOR_ABI, functionName: 'epochAt', args: [BigInt(e)],
    })) as readonly [string, bigint, boolean];
    epochRoots.push(root);
    if (!anchored) allAnchored = false;
  }
  const onChainRoot = (await pc.readContract({
    address: anchorAddr, abi: ANCHOR_ABI, functionName: 'roots', args: [BigInt(proof.epoch)],
  })) as string;

  // --- 4. An attempted GAP must revert (the sequence can never lie) ---
  let gapReverted = false;
  try {
    await pc.simulateContract({
      address: anchorAddr, abi: ANCHOR_ABI, functionName: 'anchor',
      args: [BigInt(onChainLatest + 2), '0x' + 'ab'.repeat(32) as `0x${string}`, 1n],
      account: account(DEV.deployer as `0x${string}`).address, // the anchorer
    });
  } catch (e) {
    gapReverted = String(e).includes('InvalidEpoch');
  }

  // --- 5. Assertions ---
  const folded = foldProof(proof.leaf, proof.index, proof.proof);
  const assertions: Assertion[] = [
    { name: 'epochs anchored on-chain', expected: '≥2', actual: `${onChainLatest}`, pass: onChainLatest >= 2 },
    { name: 'every epoch 1..N has a root (no gaps)', expected: 'true', actual: `${allAnchored}`, pass: allAnchored },
    { name: 'worker leaf anchored with completedJobs = 3', expected: `${CLEAN_JOBS}`, actual: proof.entry.completedJobs, pass: proof.entry.completedJobs === String(CLEAN_JOBS) },
    { name: 'merkle proof folds to the registry root', expected: proof.root.slice(0, 16) + '…', actual: folded.slice(0, 16) + '…', pass: folded === proof.root },
    { name: 'registry root matches the ON-CHAIN root', expected: onChainRoot.slice(0, 16) + '…', actual: proof.root.slice(0, 16) + '…', pass: onChainRoot.toLowerCase() === proof.root.toLowerCase() },
    { name: 'registry /v1/anchor synced with the chain', expected: `${onChainLatest}`, actual: `${anchorInfo.latestEpoch}`, pass: anchorInfo.latestEpoch === onChainLatest },
    { name: 'gap attempt (latest+2) reverts InvalidEpoch', expected: 'true', actual: `${gapReverted}`, pass: gapReverted },
  ];

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'anchor', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    actors: { worker: sellerAddr },
    anchor: anchorAddr,
    epochs: { anchored: onChainLatest, roots: epochRoots },
    anchored: { epoch: proof.epoch, root: proof.root, leafCount: CLEAN_JOBS },
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `anchor-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('5', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('6', `report → ${reportPath}`);
  console.log(passed ? '\nANCHOR DEMO: PASS' : '\nANCHOR DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[anchor] FAILED:', e);
  process.exit(1);
});
