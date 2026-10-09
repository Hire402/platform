import type { PublicClient } from 'viem';
import { concat, encodePacked, keccak256, toHex, type Hash } from 'viem';
import { ANCHOR_ABI, walletClient } from '@hire402/sdk';
import type { RegistryStore } from './store';
import { computeReputation } from './metabolic';
import { makeBackoff, sleep } from './backoff';

/**
 * REPUTATION ROOT ANCHORING (spec §7: "aggregates merkle-anchored on-chain
 * each 6h epoch"; normative contract: contracts/src/ReputationAnchor.sol).
 *
 * Every epoch the registry commits a Merkle root over ALL self-registered
 * agents' reputation aggregates — the same numbers /v1/reputation reports —
 * to the on-chain anchor. The chain enforces the GAPLESS sequence
 * (epoch must be exactly latestEpoch + 1), so the anchor history is
 * tamper-evident and third parties can prove any agent's inclusion against
 * a root via GET /v1/anchor/proof/{address}.
 *
 * Leaf: keccak256(abi.encodePacked(address, completedJobs, disputedJobs,
 * slashed)); leaves sorted by address (deterministic). An empty registry
 * anchors the EMPTY_ROOT sentinel — the sequence stays gapless even when
 * there is nobody to vouch for yet.
 */

/** Sentinel root for epochs with zero leaves (keeps the sequence gapless). */
export const EMPTY_ROOT: Hash = keccak256(toHex('hire402:empty-epoch'));

export interface AnchorEntry {
  address: string;
  completedJobs: string;  // decimal strings — JSON-safe for the store (spec-pins 6)
  disputedJobs: string;
  slashed: string;
}

export interface AnchorState {
  latestEpoch: number;
  latestRoot: string;
  leafCount: number;
  leaves: string[];        // sorted leaf hexes of the latest epoch
  entries: AnchorEntry[];  // sorted by address — the committed aggregates
  contract?: string;
  lastAnchoredAt?: string;
}

export function freshAnchorState(): AnchorState {
  return { latestEpoch: 0, latestRoot: '', leafCount: 0, leaves: [], entries: [] };
}

/** Leaf = keccak256(encodePacked(address, completed, disputed, slashed)). */
export function reputationLeaf(e: AnchorEntry): Hash {
  return keccak256(
    encodePacked(['address', 'uint256', 'uint256', 'uint256'],
      [e.address as `0x${string}`, BigInt(e.completedJobs), BigInt(e.disputedJobs), BigInt(e.slashed)]),
  );
}

const pair = (a: `0x${string}`, b: `0x${string}`): `0x${string}` => keccak256(concat([a, b]));

/** Standard binary Merkle root. Odd levels duplicate the last node. */
export function merkleRoot(leaves: `0x${string}`[]): `0x${string}` {
  if (leaves.length === 0) return EMPTY_ROOT;
  if (leaves.length === 1) return leaves[0];
  let level = [...leaves];
  while (level.length > 1) {
    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as `0x${string}`;
      const b = (level[i + 1] ?? a) as `0x${string}`; // odd level: duplicate last
      next.push(pair(a, b));
    }
    level = next;
  }
  return level[0] as `0x${string}`;
}

/** Sibling path for leaf `index` (verify direction from index bits). */
export function merkleProof(leaves: `0x${string}`[], index: number): `0x${string}`[] {
  if (index < 0 || index >= leaves.length) throw new Error(`proof index ${index} out of range (0..${leaves.length - 1})`);
  const proof: `0x${string}`[] = [];
  let level = [...leaves];
  let idx = index;
  while (level.length > 1) {
    const sib = idx % 2 === 0
      ? (level[idx + 1] ?? level[idx]) as `0x${string}` // odd level: sibling is self
      : (level[idx - 1] as `0x${string}`);
    proof.push(sib);
    const next: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i] as `0x${string}`;
      const b = (level[i + 1] ?? a) as `0x${string}`;
      next.push(pair(a, b));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Fold a proof from `leaf` at `index` — must equal the anchored root. */
export function verifyMerkleProof(leaf: `0x${string}`, index: number, proof: `0x${string}`[]): `0x${string}` {
  let h = leaf;
  let idx = index;
  for (const sib of proof) {
    h = idx % 2 === 0 ? pair(h, sib) : pair(sib, h);
    idx = Math.floor(idx / 2);
  }
  return h;
}

/** The epoch's aggregate set: every SELF-REGISTERED agent, sorted by address. */
export async function computeEpoch(
  pc: PublicClient,
  escrowAddr: `0x${string}`,
  store: Pick<RegistryStore, 'agents' | 'escrows'>,
): Promise<{ entries: AnchorEntry[]; leaves: `0x${string}`[]; root: `0x${string}` }> {
  const entries: AnchorEntry[] = [];
  for (const agent of store.agents.values()) {
    if (agent.status !== 'self-registered') continue; // observed agents are not ours to vouch for
    const rep = await computeReputation(pc, escrowAddr, store as RegistryStore, agent.address);
    entries.push({
      address: agent.address,
      completedJobs: String(rep.completedJobs),
      disputedJobs: String(rep.disputedJobs),
      slashed: String(rep.slashed),
    });
  }
  entries.sort((a, b) => (a.address < b.address ? -1 : 1)); // byte-order deterministic
  const leaves = entries.map(reputationLeaf);
  return { entries, leaves, root: merkleRoot(leaves) };
}

export interface AnchorSchedulerDeps {
  pc: PublicClient;
  rpc: string;
  escrowAddr: `0x${string}`;
  store: Pick<RegistryStore, 'agents' | 'escrows'> & { anchorState: AnchorState; save: () => unknown };
  anchorAddr: `0x${string}`;
  anchorerKey: `0x${string}`;
  epochSeconds: number;
}

/**
 * Start the anchoring cadence with 429-aware backoff (a provider RPC can
 * rate-limit the anchor tx; the loop doubles its wait with jitter on
 * failure and returns to the epoch cadence on success). Epoch ids are
 * SEQUENCE numbers: the chain only accepts latestEpoch + 1, so a restart
 * anchors the next epoch with the then-current root — the on-chain
 * sequence never gaps and never lies. A boot-time tick catches the
 * sequence up immediately.
 */
export function startAnchorScheduler(deps: AnchorSchedulerDeps): void {
  const { pc, rpc, escrowAddr, store, anchorAddr, anchorerKey, epochSeconds } = deps;
  const wc = walletClient(anchorerKey, rpc);
  const backoff = makeBackoff(epochSeconds * 1000, Math.max(epochSeconds * 1000 * 12, 60_000));
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const latest = (await pc.readContract({
        address: anchorAddr, abi: ANCHOR_ABI, functionName: 'latestEpoch',
      })) as bigint;
      const { entries, leaves, root } = await computeEpoch(pc, escrowAddr, store);
      const epoch = Number(latest) + 1;
      const hash = await wc.writeContract({
        address: anchorAddr,
        abi: ANCHOR_ABI,
        functionName: 'anchor',
        args: [BigInt(epoch), root, BigInt(leaves.length)],
        gas: 200_000n, // explicit: fresh-contract estimates can be stale (spec-pins)
      });
      await pc.waitForTransactionReceipt({ hash });
      store.anchorState = {
        latestEpoch: epoch,
        latestRoot: root,
        leafCount: leaves.length,
        leaves,
        entries,
        contract: anchorAddr,
        lastAnchoredAt: new Date().toISOString(),
      };
      store.save();
      console.log(`[anchor] epoch ${epoch} anchored: root ${root.slice(0, 12)}… over ${leaves.length} leaf/leaves`);
    } finally {
      running = false;
    }
  };

  const loop = async (): Promise<void> => {
    for (;;) {
      let wait = epochSeconds * 1000;
      try {
        await tick();
        wait = backoff.success();
      } catch (e) {
        wait = backoff.fail();
        console.error(`[anchor] tick error — retrying in ${Math.round(wait / 1000)}s:`, String(e));
      }
      await sleep(wait);
    }
  };

  void loop(); // boot-time catch-up: latestEpoch + 1 keeps the sequence gapless
}
