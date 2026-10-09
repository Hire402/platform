import Fastify from 'fastify';
import { recoverTypedDataAddress } from 'viem';
import {
  ANVIL_RPC,
  DEV,
  ESCROW_ABI,
  EscrowClient,
  BondClient,
  courtDomain,
  VERDICT_TYPES,
  publicClient,
  walletClient,
} from '@hire402/sdk';

/**
 * HIRE402 COURT (spec §6, Phase 2 as-built).
 *
 * Watches the escrow for MilestoneDisputed events; opens a case for each.
 * Staked verifiers (BondVault ≥ MIN_STAKE) submit EIP-712 `Verdict`s. When
 * a verdict matches the on-chain attestation (proofHash == attestation
 * hash), the court resolves the milestone on-chain as the escrow arbiter
 * and SLASHES every incorrect-verdict signer: 50% to the harmed
 * counterparty (buyer), 50% to the verifier pool.
 *
 * Demo court policy (v0): a verdict is correct iff
 *   releaseToSeller === true AND proofHash === expectedAttestationHash.
 * Production (Phase 2.5): juries of 7 staked verifiers, evidence packs,
 * appeal meta-disputes — the slashing rail is already live here.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const ESCROW = process.env.ESCROW_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const BOND = process.env.BOND_ADDRESS;
const ARBITER_KEY = process.env.ARBITER_KEY ?? DEV.deployer;
const PORT = Number(process.env.PORT ?? 4130);
const MIN_STAKE = BigInt(process.env.COURT_MIN_STAKE ?? '1000000'); // 1.00 USDC
const SLASH_AMOUNT = BigInt(process.env.COURT_SLASH_AMOUNT ?? '500000'); // 0.50 USDC

interface VerdictRecord {
  verifier: string;
  releaseToSeller: boolean;
  proofHash: string;
  verdictURI: string;
  ts: bigint;
  correct: boolean;
}

interface Case {
  caseId: string;
  escrowId: bigint;
  index: bigint;
  disputer: string;
  reasonURI: string;
  attestationURI: string;
  expectedHash: `0x${string}`;
  buyer: `0x${string}`;
  seller: `0x${string}`;
  status: 'open' | 'resolved';
  verdicts: VerdictRecord[];
  resolution?: { releaseToSeller: boolean; verdictURI: string; resolveTx: string };
  slashed: { verifier: string; amount: string }[];
  openedAt: string;
}

const cases = new Map<string, Case>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const VERDICT_WINDOW_MS = Number(process.env.COURT_VERDICT_WINDOW_MS ?? '6000');
let pc: ReturnType<typeof publicClient>;
let escrow: EscrowClient;
let bond: BondClient;
let chainId = 0n;
let lastPollBlock = 0n;
let polling = false;

const key = (escrowId: bigint, index: bigint) => `${escrowId}-${index}`;

async function expectedHashFromEscrow(escrowId: bigint, index: bigint): Promise<{ uri: string; hash: `0x${string}` }> {
  // Public-RPC backends can lag: retry the fresh read.
  for (let i = 0; i < 10; i++) {
    try {
      const { attestationURI } = await escrow.milestoneURIs(escrowId, index);
      const hash = attestationURI.startsWith('ipfs://')
        ? `0x${attestationURI.slice('ipfs://'.length)}` as `0x${string}`
        : attestationURI as `0x${string}`;
      return { uri: attestationURI, hash };
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('could not read attestation from chain');
}

async function openCase(logArgs: { escrowId?: bigint; index?: bigint; disputer?: string; reasonURI?: string }) {
  const escrowId = logArgs.escrowId;
  const index = logArgs.index;
  if (escrowId === undefined || index === undefined) return;
  const k = key(escrowId, index);
  if (cases.has(k)) return;

  // Read parties + attestation with retry (eventual consistency).
  let core;
  for (let i = 0; i < 10; i++) {
    try {
      core = await escrow.core(escrowId);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!core) throw new Error(`escrow ${escrowId} not visible to court`);
  const att = await expectedHashFromEscrow(escrowId, index);

  const c: Case = {
    caseId: `case_${escrowId}_${index}`,
    escrowId,
    index,
    disputer: logArgs.disputer ?? 'unknown',
    reasonURI: logArgs.reasonURI ?? '',
    attestationURI: att.uri,
    expectedHash: att.hash,
    buyer: core.buyer,
    seller: core.seller,
    status: 'open',
    verdicts: [],
    slashed: [],
    openedAt: new Date().toISOString(),
  };
  cases.set(k, c);
  console.log(`[court ] case opened: ${c.caseId} (evidence ${c.reasonURI})`);
}

async function pollDisputes() {
  if (polling) return;
  polling = true;
  try {
    const latest = await pc.getBlockNumber();
    const fromBlock = lastPollBlock > 0n ? lastPollBlock : (latest > 450n ? latest - 450n : 0n);
    const logs = await pc.getContractEvents({
      address: ESCROW as `0x${string}`,
      abi: ESCROW_ABI,
      eventName: 'MilestoneDisputed',
      fromBlock,
    });
    for (const l of logs) {
      await openCase(l.args as { escrowId?: bigint; index?: bigint; disputer?: string; reasonURI?: string });
    }
    lastPollBlock = latest;
  } catch (e) {
    console.error('[court ] poll error:', String(e));
  } finally {
    polling = false;
  }
}

/**
 * Jury-majority resolution (Phase 2.5): the verdict window collects
 * competing verdicts from staked verifiers (the jury); the OUTCOME is the
 * strict majority (tie → refund, protecting the buyer's money). Verifiers
 * whose proofs are fabricated (proofHash ≠ on-chain attestation) are
 * SLASHED regardless of side — proof integrity is not a matter of opinion.
 */
async function applyVerdicts(c: Case) {
  if (c.status === 'resolved' || c.verdicts.length === 0) return;

  const releases = c.verdicts.filter((v) => v.releaseToSeller).length;
  const refunds = c.verdicts.length - releases;
  const outcome = releases > refunds; // strict majority; tie → refund
  const majorityVerdict = c.verdicts.find((v) => v.releaseToSeller === outcome && v.correct);

  const resolveTx = await escrow.resolve(
    c.escrowId,
    c.index,
    outcome,
    majorityVerdict?.verdictURI ?? 'ipfs://jury-majority',
  );
  console.log(
    `[court ] ${c.caseId} jury ${releases}r/${refunds}f → ${outcome ? 'release' : 'refund'} (tx ${resolveTx})`,
  );

  // Slash every fabricated-proof signer: 50% harmed counterparty, 50% pool.
  for (const v of c.verdicts.filter((x) => !x.correct)) {
    const stake = await bond.stakeOf(v.verifier as `0x${string}`);
    if (stake === 0n) continue;
    await bond.slash(v.verifier as `0x${string}`, c.buyer, SLASH_AMOUNT, `fabricated proof on escrow ${c.escrowId}`);
    c.slashed.push({ verifier: v.verifier, amount: SLASH_AMOUNT.toString() });
    console.log(`[court ] slashed ${v.verifier} by ${SLASH_AMOUNT} (bond now ${(await bond.stakeOf(v.verifier as `0x${string}`)).toString()})`);
  }

  c.status = 'resolved';
  c.resolution = {
    releaseToSeller: outcome,
    verdictURI: majorityVerdict?.verdictURI ?? 'ipfs://jury-majority',
    resolveTx,
  };
}

/** JSON-safe case view (BigInts → strings; fastify's JSON.stringify
 *  cannot serialize BigInt). */
function caseJson(c: Case): Record<string, unknown> {
  return {
    caseId: c.caseId,
    escrowId: c.escrowId.toString(),
    index: c.index.toString(),
    disputer: c.disputer,
    reasonURI: c.reasonURI,
    attestationURI: c.attestationURI,
    expectedHash: c.expectedHash,
    buyer: c.buyer,
    seller: c.seller,
    status: c.status,
    verdicts: c.verdicts.map((v) => ({
      verifier: v.verifier,
      releaseToSeller: v.releaseToSeller,
      proofHash: v.proofHash,
      verdictURI: v.verdictURI,
      ts: v.ts.toString(),
      correct: v.correct,
    })),
    resolution: c.resolution,
    slashed: c.slashed,
    openedAt: c.openedAt,
  };
}

async function main() {
  if (!ESCROW || !USDC || !BOND) {
    console.error('ESCROW_ADDRESS, USDC_ADDRESS and BOND_ADDRESS are required');
    process.exit(1);
  }
  pc = publicClient(RPC);
  const arbiter = walletClient(ARBITER_KEY as `0x${string}`, RPC);
  escrow = new EscrowClient(pc, arbiter, ESCROW as `0x${string}`, USDC as `0x${string}`);
  bond = new BondClient(pc, arbiter, BOND as `0x${string}`, USDC as `0x${string}`);
  chainId = BigInt(await pc.getChainId());
  console.log(`[court ] arbiter ${escrow.account} | escrow ${ESCROW} | bond ${BOND} | minStake ${MIN_STAKE}`);

  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, service: 'hire402-court' }));

  app.get('/cases', async (req) => {
    const q = (req.query ?? {}) as { status?: string };
    let list = [...cases.values()];
    if (q.status) list = list.filter((c) => c.status === q.status);
    return { cases: list.map(caseJson), count: list.length };
  });

  app.get('/cases/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = [...cases.values()].find((x) => x.caseId === id || key(x.escrowId, x.index) === id);
    if (!c) return reply.code(404).send({ error: 'case not found' });
    return caseJson(c);
  });

  /** A staked verifier submits an EIP-712 Verdict on an open case. */
  app.post('/verdicts', async (req, reply) => {
    const body = (req.body ?? {}) as {
      escrowId?: string;
      milestoneIndex?: string;
      releaseToSeller?: boolean;
      proofHash?: `0x${string}`;
      verdictURI?: string;
      ts?: string;
      sig?: `0x${string}`;
      verifier?: `0x${string}`;
    };
    const escrowId = BigInt(body.escrowId ?? '0');
    const index = BigInt(body.milestoneIndex ?? '0');
    const k = key(escrowId, index);
    const c = cases.get(k);
    if (!c) return reply.code(404).send({ error: 'no case for this escrow/milestone' });
    if (c.status !== 'open') return reply.code(409).send({ error: 'case already resolved' });
    if (!body.sig || !body.verifier || !body.proofHash || !body.verdictURI || body.ts === undefined) {
      return reply.code(400).send({ error: 'verifier, sig, proofHash, verdictURI, ts required' });
    }

    // Fresh timestamp (±300s)
    const now = BigInt(Math.floor(Date.now() / 1000));
    const ts = BigInt(body.ts);
    const skew = now > ts ? now - ts : ts - now;
    if (skew > 300n) return reply.code(400).send({ error: 'ts skew > 300s' });

    // Signature must recover to the claimed verifier.
    const message = {
      escrowId,
      milestoneIndex: index,
      releaseToSeller: body.releaseToSeller === true,
      proofHash: body.proofHash,
      verdictURI: body.verdictURI,
      ts,
    };
    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        domain: courtDomain(chainId),
        types: VERDICT_TYPES,
        primaryType: 'Verdict',
        message,
        signature: body.sig,
      });
    } catch {
      return reply.code(401).send({ error: 'malformed signature' });
    }
    if (recovered.toLowerCase() !== body.verifier.toLowerCase()) {
      return reply.code(401).send({ error: 'signature does not match claimed verifier' });
    }

    // The verifier must have skin in the game.
    const stake = await bond.stakeOf(body.verifier as `0x${string}`);
    if (stake < MIN_STAKE) {
      return reply.code(403).send({ error: `insufficient stake ${stake} < ${MIN_STAKE}` });
    }

    // Demo court policy: correct iff release with matching proof.
    const correct =
      body.releaseToSeller === true && body.proofHash.toLowerCase() === c.expectedHash.toLowerCase();

    c.verdicts.push({
      verifier: body.verifier.toLowerCase(),
      releaseToSeller: body.releaseToSeller === true,
      proofHash: body.proofHash,
      verdictURI: body.verdictURI,
      ts,
      correct,
    });
    console.log(`[court ] verdict from ${body.verifier} on ${c.caseId}: correct=${correct}`);

    // Verdict window: collect competing verdicts for VERDICT_WINDOW_MS after
    // the first one, THEN resolve + slash (mini-jury semantics; removes the
    // submit-order race between verifiers).
    if (!timers.has(k)) {
      timers.set(
        k,
        setTimeout(() => {
          const cc = cases.get(k);
          if (cc && cc.status === 'open') void applyVerdicts(cc);
        }, VERDICT_WINDOW_MS),
      );
      console.log(`[court ] ${c.caseId}: verdict window open (${VERDICT_WINDOW_MS}ms)`);
    }

    return reply.code(201).send({
      caseId: c.caseId,
      accepted: true,
      correct,
      status: c.status,
      slashed: c.slashed,
    });
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[court ] listening on :${PORT} — watching for disputes`);
  setInterval(() => void pollDisputes(), 2000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

