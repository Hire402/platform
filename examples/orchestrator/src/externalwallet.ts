import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { decodeEventLog } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  ANVIL_RPC,
  DEV,
  ERC20_ABI,
  EscrowClient,
  RegistryClient,
  account,
  approve,
  balanceOf,
  payAndCall,
  publicClient,
  walletClient,
} from '@hire402/sdk';

/**
 * THE EXTERNAL-WALLET INTEROP DEMO (adoption tier-1): a Circle Agent Stack
 * wallet, a Coinbase x402 wallet, or a Bedrock AgentCore wallet is, from
 * the chain's perspective, just an address that signs — and Hire402 is
 * address-agnostic. This demo proves it end-to-end with a wallet that did
 * not exist when the chain booted:
 *
 *   1. a FRESH random wallet registers via EIP-712 (it "arrives funded",
 *      like a Circle/Coinbase agent wallet)
 *   2. it HIRES: funds an escrow as buyer, settles a job from the genesis
 *      agent — guardrails (the owner's policy) and escrow (settlement
 *      structure) compose
 *   3. it WORKS: delivers a milestone to the platform buyer, gets paid
 *   4. it PAYS via x402: a 402 challenge → on-chain transfer → retry with
 *      proof (the inference provider then posts the burn receipt)
 *   5. the registry tracks its income, burn, metabolic status, credit
 *      score, and bond requirement — the full economy, zero custody
 *
 * No Hire402-specific custody at any point: the external wallet signs
 * every action; the escrow is non-custodial milestone state.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const REGISTRY_URL = process.env.REGISTRY_URL ?? 'http://127.0.0.1:4010';
const DEPLOYMENTS = process.env.DEPLOYMENTS_FILE ?? path.join('ops', 'deployments.local.json');
const PROVIDER_PORT = Number(process.env.PROVIDER_PORT ?? 4210); // not 4190: undici blocks "bad ports" (sieve)

const FEE_BPS = 150n;
const JOB = 1_000_000n;     // 1.00 USDC per job
const INFER_PRICE = 100_000n; // 0.10 USDC per paid call

const log = (step: string, msg: string) => console.log(`[extwl ] ${step.padEnd(6)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Assertion { name: string; expected: string; actual: string; pass: boolean }

function loadDeployment() {
  const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS, 'utf8'));
  return { escrow: raw.escrow as `0x${string}`, usdc: raw.usdc as `0x${string}`, treasury: raw.treasury as `0x${string}` };
}

/** Advance the chain so the indexer's confirmation lag clears (auto-mine). */
async function advanceBlocks(pc: ReturnType<typeof publicClient>, n: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = pc as any;
  await raw.request({ method: 'anvil_mine', params: [n] });
}

async function main() {
  const startedAt = new Date().toISOString();
  const { escrow: escrowAddr, usdc: usdcAddr, treasury } = loadDeployment();
  const pc = publicClient(RPC);

  // --- 0. A wallet that did not exist when the chain booted ---
  const externalKey = generatePrivateKey();
  const externalAddr = privateKeyToAccount(externalKey).address;
  const external = walletClient(externalKey as `0x${string}`, RPC);
  const deployer = walletClient(DEV.deployer as `0x${string}`, RPC);
  const providerAddr = account(DEV.deployer as `0x${string}`).address;
  const buyer = walletClient(DEV.buyer as `0x${string}`, RPC);
  const genesis = walletClient(DEV.genesis as `0x${string}`, RPC);
  const genesisAddr = genesis.account!.address;
  log('0', `external agent wallet ${externalAddr} arrives funded (as a Circle Agent Stack / Coinbase x402 wallet would)`);

  // Gas + seed USDC from the dev float (a platform wallet arrives funded in prod)
  const gasTx = await deployer.sendTransaction({ to: externalAddr, value: 10_000_000_000_000_000n });
  await pc.waitForTransactionReceipt({ hash: gasTx });
  const seedTx = await deployer.writeContract({
    address: usdcAddr, abi: ERC20_ABI, functionName: 'transfer',
    args: [externalAddr, 10_000_000n], gas: 120_000n,
  });
  await pc.waitForTransactionReceipt({ hash: seedTx });

  const extEscrow = new EscrowClient(pc, external, escrowAddr, usdcAddr);
  const extRc = new RegistryClient(REGISTRY_URL, external, pc);
  const providerRc = new RegistryClient(REGISTRY_URL, deployer, pc);

  // --- 1. Self-register via EIP-712 — any address is a principal ---
  await extRc.post('/v1/agents', {
    address: externalAddr,
    agentCardUrl: 'http://circle-agent.example/.well-known/agent-card.json',
    x402: { chains: ['eip155:31337'], assets: ['USDC'] },
  });
  log('1', 'registered via a signed POST — no platform-specific identity required');

  // --- 2. HIRES: buyer cycle with the genesis agent (guardrails ∘ escrow) ---
  const approveTx = await approve(external, usdcAddr, escrowAddr, 10_000_000n);
  await pc.waitForTransactionReceipt({ hash: approveTx });
  const deadline = (await pc.getBlock()).timestamp + 86_400n;
  const hire = await extEscrow.create({
    seller: genesisAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
    milestones: [{ amount: JOB, deadline, descriptionURI: 'ipfs://extwl-hire' }],
  });
  await extEscrow.fund(hire.id);
  const genesisEscrow = new EscrowClient(pc, genesis, escrowAddr, usdcAddr);
  await genesisEscrow.start(hire.id);
  await genesisEscrow.submit(hire.id, 0n, 'ipfs://extwl-att');
  const treasuryBefore = await balanceOf(pc, usdcAddr, treasury);
  const genesisBefore = await balanceOf(pc, usdcAddr, genesisAddr);
  await extEscrow.approve(hire.id, 0n);
  const treasuryAfterHire = await balanceOf(pc, usdcAddr, treasury); // before the x402 spend (treasury == provider in dev)
  const fee = (JOB * FEE_BPS) / 10_000n;
  log('2', `hired the genesis agent: ${JOB} escrowed → settled (fee ${fee} to treasury, payout to seller)`);

  // --- 3. WORKS: seller cycle for the platform buyer ---
  const buyerApprove = await approve(buyer, usdcAddr, escrowAddr, 100_000_000n);
  await pc.waitForTransactionReceipt({ hash: buyerApprove });
  const buyerEscrow = new EscrowClient(pc, buyer, escrowAddr, usdcAddr);
  const work = await buyerEscrow.create({
    seller: externalAddr, feeBps: FEE_BPS, challengeSeconds: 60n,
    milestones: [{ amount: JOB, deadline, descriptionURI: 'ipfs://extwl-work' }],
  });
  await buyerEscrow.fund(work.id);
  await extEscrow.start(work.id);
  await extEscrow.submit(work.id, 0n, 'ipfs://extwl-att-work');
  const extBefore = await balanceOf(pc, usdcAddr, externalAddr);
  await buyerEscrow.approve(work.id, 0n);
  const extAfterWork = await balanceOf(pc, usdcAddr, externalAddr); // before the x402 spend
  log('3', `worked a job: payout ${JOB - fee} lands in the external wallet`);

  // --- 4. PAYS via x402: challenge → on-chain transfer → retry with proof ---
  const providerBefore = await balanceOf(pc, usdcAddr, providerAddr);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      const proof = req.headers['x-402-proof'];
      if (!proof) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'payment required',
          x402: { scheme: 'exact', payTo: providerAddr, amount: String(INFER_PRICE), asset: 'eip155:31337/USDC' },
        }));
        return;
      }
      // Verify on-chain: a USDC Transfer(external → provider, price) in the receipt.
      const receipt = await pc.getTransactionReceipt({ hash: proof as `0x${string}` });
      const verified = receipt.status === 'success' && receipt.logs.some((l) => {
        if (l.address.toLowerCase() !== usdcAddr.toLowerCase()) return false;
        try {
          const d = decodeEventLog({ abi: ERC20_ABI, data: l.data, topics: l.topics as [] | [`0x${string}`, ...`0x${string}`[]] });
          return d.eventName === 'Transfer'
            && (d.args as { from?: string }).from?.toLowerCase() === externalAddr.toLowerCase()
            && (d.args as { to?: string }).to?.toLowerCase() === providerAddr.toLowerCase()
            && (d.args as { value?: bigint }).value === INFER_PRICE;
        } catch { return false; }
      });
      if (!verified) { res.writeHead(400).end('payment proof does not verify on-chain'); return; }
      // The provider signs the burn receipt — the registry never trusts
      // signatures over money; it just verified the chain.
      await providerRc.post('/v1/receipts', {
        payer: externalAddr, amount: String(INFER_PRICE), txHash: proof, service: 'tok-infer:mock',
      }).catch(() => undefined);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ done: true, provider: 'mock-inference' }));
    });
  });
  await new Promise<void>((r) => server.listen(PROVIDER_PORT, r));
  const paid = await payAndCall({
    walletClient: external, publicClient: pc, erc20: usdcAddr,
    endpoint: `http://127.0.0.1:${PROVIDER_PORT}/infer`,
    body: { prompt: 'why is the sky blue' }, maxAmount: 1_000_000n,
  });
  server.close();
  log('4', `paid for inference via x402 (tx ${String(paid.txHash).slice(0, 10)}…) — the provider posted the burn receipt`);

  // --- 5. The registry tracks the external wallet like any agent ---
  await advanceBlocks(pc, 4);
  let metabolic: Record<string, string> | undefined;
  let credit: { score: number } | undefined;
  let bond: { requiredBond: string; decayBps: string } | undefined;
  for (let t = 0; t < 30; t++) {
    const record = (await extRc.get(`/v1/agents/${externalAddr}`)) as unknown as {
      metabolic?: Record<string, string>;
      creditScore?: { score: number };
      bondRequirement?: { requiredBond: string; decayBps: string };
    };
    metabolic = record.metabolic;
    credit = record.creditScore;
    bond = record.bondRequirement;
    if (metabolic?.incomeNet === String(JOB - fee) && metabolic.burn === String(INFER_PRICE)) break;
    await sleep(1500);
  }
  if (!metabolic || !credit || !bond) throw new Error('registry records incomplete');
  log('5', `income ${metabolic.incomeNet} · burn ${metabolic.burn} · ${metabolic.status} · credit ${credit.score} · bond ${bond.requiredBond} (${bond.decayBps} bps)`);

  // --- 6. Assertions ---
  const assertions: Assertion[] = [
    { name: 'as buyer: fee to treasury (150 bps)', expected: `${fee}`, actual: `${treasuryAfterHire - treasuryBefore}`, pass: treasuryAfterHire - treasuryBefore === fee },
    { name: 'as buyer: the genesis agent was paid', expected: `${JOB - fee}`, actual: `${(await balanceOf(pc, usdcAddr, genesisAddr)) - genesisBefore}`, pass: (await balanceOf(pc, usdcAddr, genesisAddr)) - genesisBefore === JOB - fee },
    { name: 'as seller: external wallet was paid', expected: `${JOB - fee}`, actual: `${extAfterWork - extBefore}`, pass: extAfterWork - extBefore === JOB - fee },
    { name: 'x402: provider was paid on-chain', expected: `${INFER_PRICE}`, actual: `${(await balanceOf(pc, usdcAddr, providerAddr)) - providerBefore}`, pass: (await balanceOf(pc, usdcAddr, providerAddr)) - providerBefore === INFER_PRICE },
    { name: 'metabolic income tracked', expected: `${JOB - fee}`, actual: metabolic.incomeNet, pass: metabolic.incomeNet === String(JOB - fee) },
    { name: 'metabolic burn tracked (provider receipt)', expected: `${INFER_PRICE}`, actual: metabolic.burn, pass: metabolic.burn === String(INFER_PRICE) },
    { name: 'metabolic status solvent', expected: 'solvent', actual: metabolic.status, pass: metabolic.status === 'solvent' },
    { name: 'credit score 850 (clean delivery + solvent)', expected: '850', actual: `${credit.score}`, pass: credit.score === 850 },
    { name: 'bond decayed for the clean job', expected: '9640', actual: bond.decayBps, pass: bond.decayBps === '9640' },
  ];

  const passed = assertions.every((a) => a.pass);
  const report = {
    run: 'external-wallet', version: '0.1.0',
    startedAt, finishedAt: new Date().toISOString(),
    status: passed ? 'PASS' : 'FAIL',
    actors: { externalWallet: externalAddr, provider: providerAddr },
    note: 'a fresh wallet (Circle Agent Stack / Coinbase x402 shape: just an address that signs) joins, hires, works, pays via x402, and is fully tracked — zero Hire402 custody',
    assertions: assertions.map((a) => ({ ...a, pass: a.pass ? 'PASS' : 'FAIL' })),
  };
  const reportsDir = path.join('ops', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `external-wallet-run-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const a of assertions) log('6', `${a.pass ? '✓' : '✗'} ${a.name}: expected ${a.expected} | actual ${a.actual}`);
  log('7', `report → ${reportPath}`);
  console.log(passed ? '\nEXTERNAL WALLET DEMO: PASS' : '\nEXTERNAL WALLET DEMO: FAIL');
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[extwl ] FAILED:', e);
  process.exit(1);
});
