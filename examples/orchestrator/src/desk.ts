import fs from 'node:fs';
import path from 'node:path';
import {
  ANVIL_RPC,
  CHAIN_ID,
  DEV,
  EscrowClient,
  EscrowState,
  AdvanceClient,
  advancedEscrowDomain,
  approve,
  balanceOf,
  publicClient,
  signAdvanceOffer,
  walletClient,
} from '@hire402/sdk';

/**
 * THE CAPITAL DESK DEMO (Phase 3, spec §8): working capital against
 * escrowed receivables, repaid automatically at settlement.
 *
 *   buyer orders work from the genesis agent (2 × 1.00 USDC milestones):
 *     1. the desk signs an AdvanceOffer off-chain (credit-score policy is
 *        the desk's, at signing) — 0.80 USDC @ 6% APR
 *     2. the seller accepts on-chain: principal flows desk → seller
 *        directly (non-custodial; the contract never holds desk funds)
 *     3. one year elapses (deterministic anvil time jump)
 *     4. milestone 0 releases: fee → treasury (150 bps, untouched);
 *        principal + interest → desk FIRST; remainder → seller
 *     5. milestone 1 releases plainly: the debt is cleared, seller paid
 *
 * The seller gets paid TODAY for work that settles TOMORROW — and the
 * desk is repaid by the escrow itself, not by a collection department.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');

const FEE_BPS = 150n;
const MS = 1_000_000n; // 1.00 USDC per milestone
const PRINCIPAL = 800_000n; // 0.80 USDC (≤ 80% of the 2.00 receivables)
const APR_BPS = 600; // 6% (spec §8: 5–8% from credit score)
const YEAR = 31_536_000n; // 365 days, per-second accrual
const FEE = (MS * FEE_BPS) / 10_000n; // 0.015 per milestone
const INTEREST = (PRINCIPAL * BigInt(APR_BPS)) / 10_000n; // 0.048 for exactly 365 days
const DEBT = PRINCIPAL + INTEREST; // 0.848

const usdc = (b: bigint) => (Number(b) / 1e6).toFixed(6);
const log = (step: string, msg: string) => console.log(`[desk  ] ${step.padEnd(6)} ${msg}`);
interface Assertion { name: string; expected: string; actual: string; pass: boolean }

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return {
    advancedEscrow: raw.advancedEscrow as `0x${string}`,
    usdc: raw.usdc as `0x${string}`,
    treasury: raw.treasury as `0x${string}`,
  };
}

/** Deterministic anvil time jump: the NEXT mined block gets this timestamp. */
async function jumpTo(pc: ReturnType<typeof publicClient>, ts: bigint): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = pc as any;
  await raw.request({ method: 'evm_setNextBlockTimestamp', params: [Number(ts)] });
}

async function main() {
  const startedAt = new Date().toISOString();
  const { advancedEscrow, usdc: usdcAddr, treasury } = loadDeployment();
  const pc = publicClient(RPC);
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const seller = walletClient(DEV.genesis as `0x${string}`, RPC); // the solvent worker
  const desk = walletClient(DEV.desk as `0x${string}`, RPC); // the capital desk
  const buyerAddr = buyer.account!.address;
  const sellerAddr = seller.account!.address;
  const deskAddr = desk.account!.address;

  const buyerEscrow = new EscrowClient(pc, buyer, advancedEscrow, usdcAddr);
  const sellerEscrow = new EscrowClient(pc, seller, advancedEscrow, usdcAddr);
  const advance = new AdvanceClient(pc, seller, advancedEscrow, usdcAddr);

  log('0', `buyer ${buyerAddr} orders 2 × ${usdc(MS)} from seller ${sellerAddr}; desk ${deskAddr} watches`);

  // --- 1. The buyer funds a two-milestone job ---
  const deadline = (await pc.getBlock()).timestamp + 86_400n;
  const job = await buyerEscrow.create({
    seller: sellerAddr,
    feeBps: FEE_BPS,
    challengeSeconds: 60n,
    milestones: [
      { amount: MS, deadline, descriptionURI: 'ipfs://desk-m0' },
      { amount: MS, deadline, descriptionURI: 'ipfs://desk-m1' },
    ],
  });
  const approveTx = await approve(buyer, usdcAddr, advancedEscrow, 10_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  await buyerEscrow.fund(job.id);
  await sellerEscrow.start(job.id);
  await sellerEscrow.submit(job.id, 0n, 'ipfs://att0');
  await sellerEscrow.submit(job.id, 1n, 'ipfs://att1');
  log('1', `escrow #${job.id} active: 2 × ${usdc(MS)} escrowed (receivables ${usdc(MS * 2n)})`);

  // --- 2. The desk offers; the seller accepts; principal flows desk → seller ---
  const now = (await pc.getBlock()).timestamp;
  const offerExpiry = now + 3_600n;
  const domain = advancedEscrowDomain(BigInt(CHAIN_ID), advancedEscrow);
  const signature = await signAdvanceOffer(desk, domain, {
    escrowId: job.id, seller: sellerAddr, principal: PRINCIPAL, aprBps: APR_BPS, offerExpiry,
  });
  log('2', `desk policy: credit score 720 → ${usdc(PRINCIPAL)} @ ${(APR_BPS / 100).toFixed(2)}% APR (simulated desk input; the formula is public, spec §8)`);

  const sellerBefore = await balanceOf(pc, usdcAddr, sellerAddr);
  const deskBefore = await balanceOf(pc, usdcAddr, deskAddr);
  await advance.acceptAdvance(job.id, PRINCIPAL, APR_BPS, offerExpiry, signature);
  const adv = await advance.advance(job.id);
  const sellerAfterAccept = await balanceOf(pc, usdcAddr, sellerAddr);
  const deskAfterAccept = await balanceOf(pc, usdcAddr, deskAddr);
  log('2', `seller accepted: ${usdc(PRINCIPAL)} received today against ${usdc(MS * 2n)} of escrowed receivables (cap 80%)`);

  // --- 3. One year passes ---
  await jumpTo(pc, adv.lastAccrual + YEAR);
  log('3', `one year elapses: interest = ${usdc(INTEREST)} (${(APR_BPS / 100).toFixed(2)}% of principal, exact)`);

  // --- 4. Milestone 0 releases: fee → treasury, desk FIRST, remainder → seller ---
  const treasuryBefore = await balanceOf(pc, usdcAddr, treasury);
  await buyerEscrow.approve(job.id, 0n);
  const deskAfter0 = await balanceOf(pc, usdcAddr, deskAddr);
  const sellerAfter0 = await balanceOf(pc, usdcAddr, sellerAddr);
  const treasuryAfter0 = await balanceOf(pc, usdcAddr, treasury);
  const sellerRemainder = MS - FEE - DEBT;
  log('4', `m0 released: fee ${usdc(FEE)} → treasury; ${usdc(DEBT)} → desk (0.800 principal + ${usdc(INTEREST)} interest); ${usdc(sellerRemainder)} → seller`);

  // --- 5. Milestone 1 releases plainly (debt cleared) ---
  const deskBefore1 = await balanceOf(pc, usdcAddr, deskAddr);
  const sellerBefore1 = await balanceOf(pc, usdcAddr, sellerAddr);
  await buyerEscrow.approve(job.id, 1n);
  const deskDelta1 = (await balanceOf(pc, usdcAddr, deskAddr)) - deskBefore1;
  const sellerDelta1 = (await balanceOf(pc, usdcAddr, sellerAddr)) - sellerBefore1;
  const core = await buyerEscrow.core(job.id);
  const debtAfter = await advance.advanceDebt(job.id);

  const assertions: Assertion[] = [
    { name: 'seller received the advance at accept', expected: `${PRINCIPAL}`, actual: `${sellerAfterAccept - sellerBefore}`, pass: sellerAfterAccept - sellerBefore === PRINCIPAL },
    { name: 'desk disbursed the advance at accept', expected: `${PRINCIPAL}`, actual: `${deskBefore - deskAfterAccept}`, pass: deskBefore - deskAfterAccept === PRINCIPAL },
    { name: 'desk repaid first at m0 (principal + interest)', expected: `${DEBT}`, actual: `${deskAfter0 - deskAfterAccept}`, pass: deskAfter0 - deskAfterAccept === DEBT },
    { name: 'seller remainder after desk repayment', expected: `${sellerRemainder}`, actual: `${sellerAfter0 - sellerAfterAccept}`, pass: sellerAfter0 - sellerAfterAccept === sellerRemainder },
    { name: 'fee untouched by the rail (150 bps)', expected: `${FEE}`, actual: `${treasuryAfter0 - treasuryBefore}`, pass: treasuryAfter0 - treasuryBefore === FEE },
    { name: 'advance debt cleared', expected: '0', actual: `${debtAfter}`, pass: debtAfter === 0n },
    { name: 'm1 released plainly (desk gets nothing)', expected: '0', actual: `${deskDelta1}`, pass: deskDelta1 === 0n },
    { name: 'seller paid in full at m1', expected: `${MS - FEE}`, actual: `${sellerDelta1}`, pass: sellerDelta1 === MS - FEE },
    { name: 'escrow Complete', expected: '3 (Complete)', actual: `${core.state} (${['Created', 'Funded', 'Active', 'Complete', 'Cancelled'][core.state] ?? '?'})`, pass: core.state === EscrowState.Complete },
  ];

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'desk', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    actors: { buyer: buyerAddr, seller: sellerAddr, desk: deskAddr },
    escrowId: job.id.toString(),
    economics: {
      advanceUsdc: usdc(PRINCIPAL), aprBps: APR_BPS,
      interestUsdc: usdc(INTEREST), feeUsdc: usdc(FEE),
      deskRepaidUsdc: usdc(DEBT), sellerRemainderUsdc: usdc(sellerRemainder),
      note: 'desk signs an EIP-712 offer; seller accepts; principal flows desk→seller; at release the escrow repays the desk first (interest-first), remainder to the seller; fee untouched',
    },
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `desk-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('6', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('7', `report → ${reportPath}`);
  console.log(passed ? '\nDESK DEMO: PASS' : '\nDESK DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[desk  ] FAILED:', e);
  process.exit(1);
});
