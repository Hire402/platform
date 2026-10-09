import Fastify from 'fastify';
import { keccak256, toHex } from 'viem';
import {
  ANVIL_RPC,
  DEV,
  BondClient,
  courtDomain,
  signVerdict,
  publicClient,
  walletClient,
  approve,
} from '@hire402/sdk';

/**
 * THE VERIFIER AGENT (Phase 2) — AI judging AI, paid in trust capital.
 *
 * At startup it stakes the settlement asset in BondVault (skin in the
 * game). It polls the court's open cases; for each case it fetches the
 * evidence (the buyer's dispute pointer — here the researcher's task),
 * independently recomputes the work's content hash, and checks it against
 * the on-chain attestation. If they match, it signs a release Verdict
 * (EIP-712) and submits it. Wrong verdicts get slashed by the court —
 * the verifier's bond is its license to judge.
 */

const RPC = process.env.HIRE402_RPC ?? ANVIL_RPC;
const USDC = process.env.USDC_ADDRESS;
const BOND = process.env.BOND_ADDRESS;
const COURT_URL = process.env.COURT_URL ?? 'http://127.0.0.1:4130';
const PORT = Number(process.env.PORT ?? 4140);
const VERIFIER_KEY = process.env.VERIFIER_KEY ?? DEV.verifier;
const STAKE = BigInt(process.env.VERIFIER_STAKE ?? '2000000'); // 2.00 USDC

let pc: ReturnType<typeof publicClient>;
let wc: ReturnType<typeof walletClient>;
let bond: BondClient;

interface Case {
  caseId: string;
  escrowId: string;
  index: string;
  reasonURI: string;
  status: 'open' | 'resolved';
}

const handled = new Set<string>();

/** Independently verify the disputed work: recompute the content hash. */
async function verifyCase(c: Case): Promise<{ release: boolean; proofHash: `0x${string}` } | null> {
  try {
    // The buyer's dispute pointer carries the evidence (the worker's output).
    const res = await fetch(c.reasonURI);
    if (!res.ok) return null;
    const task = (await res.json()) as { result?: string; attestation?: string };
    if (!task.result || !task.attestation) return null;

    const recomputed = keccak256(toHex(task.result)) as `0x${string}`;
    const attested = task.attestation.startsWith('ipfs://')
      ? (`0x${task.attestation.slice('ipfs://'.length)}` as `0x${string}`)
      : (task.attestation as `0x${string}`);

    // Release iff the on-chain attestation faithfully represents the work.
    return { release: recomputed.toLowerCase() === attested.toLowerCase(), proofHash: recomputed };
  } catch {
    return null;
  }
}

async function workCases() {
  try {
    const res = await fetch(`${COURT_URL}/cases?status=open`);
    if (!res.ok) return;
    const { cases } = (await res.json()) as { cases: Case[] };
    for (const c of cases) {
      if (handled.has(c.caseId)) continue;
      handled.add(c.caseId);

      const verdict = await verifyCase(c);
      if (!verdict) {
        console.log(`[verify] ${c.caseId}: evidence not verifiable yet — skipping (will not retry)`);
        continue;
      }
      const ts = BigInt(Math.floor(Date.now() / 1000));
      const message = {
        escrowId: BigInt(c.escrowId),
        milestoneIndex: BigInt(c.index),
        releaseToSeller: verdict.release,
        proofHash: verdict.proofHash,
        verdictURI: `ipfs://${keccak256(toHex(`${c.caseId}:${verdict.proofHash}`)).slice(2)}`,
        ts,
      };
      const sig = await signVerdict(wc, courtDomain(BigInt(await pc.getChainId())), message);
      const post = await fetch(`${COURT_URL}/verdicts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          escrowId: c.escrowId,
          milestoneIndex: c.index,
          releaseToSeller: verdict.release,
          proofHash: verdict.proofHash,
          verdictURI: message.verdictURI,
          ts: ts.toString(),
          sig,
          verifier: wc.account!.address,
        }),
      });
      const out = (await post.json()) as { correct?: boolean; status?: string };
      console.log(
        `[verify] ${c.caseId}: verdict submitted (release=${verdict.release}) → correct=${out.correct} case=${out.status}`,
      );
    }
  } catch (e) {
    console.error('[verify] poll error:', String(e));
  }
}

async function main() {
  if (!USDC || !BOND) {
    console.error('USDC_ADDRESS and BOND_ADDRESS are required');
    process.exit(1);
  }
  pc = publicClient(RPC);
  wc = walletClient(VERIFIER_KEY as `0x${string}`, RPC);
  bond = new BondClient(pc, wc, BOND as `0x${string}`, USDC as `0x${string}`);

  // Skin in the game: stake if not already staked.
  const me = wc.account!.address;
  const current = await bond.stakeOf(me);
  if (current < STAKE) {
    const approveTx = await approve(wc, USDC as `0x${string}`, BOND as `0x${string}`, 10_000_000n);
    await pc.waitForTransactionReceipt({ hash: approveTx });
    const stakeTx = await bond.stake(STAKE);
    console.log(`[verify] ${me} staked ${STAKE} (tx ${stakeTx})`);
  } else {
    console.log(`[verify] ${me} already staked (${current})`);
  }

  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({ ok: true, service: 'hire402-verifier' }));
  app.get('/wallet', async () => ({
    address: me,
    stake: (await bond.stakeOf(me)).toString(),
  }));
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[verify] listening on :${PORT} — watching court for open cases`);
  setInterval(() => void workCases(), 2000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
