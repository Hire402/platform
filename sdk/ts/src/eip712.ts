import type { Account, Chain, Transport, WalletClient } from 'viem';

type Wc = WalletClient<Transport, Chain, Account>;

/** EIP-712 domain for the escrow contract (spec §5.4). */
export function escrowDomain(chainId: bigint, verifyingContract: `0x${string}`) {
  return {
    name: 'Hire402Escrow',
    version: '1',
    chainId,
    verifyingContract,
  };
}

/**
 * EIP-712 domain for registry request signatures (spec §10). The registry is
 * off-chain, so `verifyingContract` is a protocol-wide sentinel address.
 */
export const REGISTRY_SENTINEL = '0x0000000000000000000000000000000000000001' as const;

export function registryDomain(chainId: bigint) {
  return {
    name: 'Hire402Registry',
    version: '1',
    chainId,
    verifyingContract: REGISTRY_SENTINEL,
  };
}

export const MILESTONE_APPROVAL_TYPES = {
  MilestoneApproval: [
    { name: 'escrowId', type: 'uint256' },
    { name: 'milestoneIndex', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'sigExpiry', type: 'uint64' },
  ],
} as const;

export const REGISTRY_TYPES = {
  RegistryRequest: [
    { name: 'payload', type: 'bytes' },
    { name: 'ts', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Verdict signatures (spec §6): staked verifiers sign these for the court. */
export const VERDICT_TYPES = {
  Verdict: [
    { name: 'escrowId', type: 'uint256' },
    { name: 'milestoneIndex', type: 'uint256' },
    { name: 'releaseToSeller', type: 'bool' },
    { name: 'proofHash', type: 'bytes32' },
    { name: 'verdictURI', type: 'string' },
    { name: 'ts', type: 'uint64' },
  ],
} as const;

/** EIP-712 domain sentinel for off-chain court signatures. */
export const COURT_SENTINEL = '0x0000000000000000000000000000000000000002' as const;

export function courtDomain(chainId: bigint) {
  return {
    name: 'Hire402Court',
    version: '1',
    chainId,
    verifyingContract: COURT_SENTINEL,
  };
}

export interface MilestoneApprovalMessage {
  escrowId: bigint;
  milestoneIndex: bigint;
  amount: bigint;
  sigExpiry: bigint;
}

export interface RegistryRequestMessage {
  payload: `0x${string}`; // keccak256 of the raw request body
  ts: bigint;
  nonce: bigint;
}

/** Buyer signs a milestone approval off-chain (gas-free for the buyer). */
export async function signMilestoneApproval(
  wc: Wc,
  domain: ReturnType<typeof escrowDomain>,
  message: MilestoneApprovalMessage,
): Promise<`0x${string}`> {
  return wc.signTypedData({
    domain,
    types: MILESTONE_APPROVAL_TYPES,
    primaryType: 'MilestoneApproval',
    message,
  });
}

export interface VerdictMessage {
  escrowId: bigint;
  milestoneIndex: bigint;
  releaseToSeller: boolean;
  proofHash: `0x${string}`;
  verdictURI: string;
  ts: bigint;
}

/** Staked verifier signs a verdict for the court (spec §6). */
export async function signVerdict(
  wc: Wc,
  domain: ReturnType<typeof courtDomain>,
  message: VerdictMessage,
): Promise<`0x${string}`> {
  return wc.signTypedData({
    domain,
    types: VERDICT_TYPES,
    primaryType: 'Verdict',
    message,
  });
}

/** Agent signs a registry mutation (register / list / post receipt / …). */
export async function signRegistryRequest(
  wc: Wc,
  domain: ReturnType<typeof registryDomain>,
  message: RegistryRequestMessage,
): Promise<`0x${string}`> {
  return wc.signTypedData({
    domain,
    types: REGISTRY_TYPES,
    primaryType: 'RegistryRequest',
    message,
  });
}

/** EIP-712 domain for AdvancedEscrow advance offers (spec §8). */
export function advancedEscrowDomain(chainId: bigint, verifyingContract: `0x${string}`) {
  return {
    name: 'Hire402AdvancedEscrow',
    version: '1',
    chainId,
    verifyingContract,
  };
}

export const ADVANCE_OFFER_TYPES = {
  AdvanceOffer: [
    { name: 'escrowId', type: 'uint256' },
    { name: 'seller', type: 'address' },
    { name: 'principal', type: 'uint256' },
    { name: 'aprBps', type: 'uint16' },
    { name: 'offerExpiry', type: 'uint64' },
  ],
} as const;

export interface AdvanceOfferMessage {
  escrowId: bigint;
  seller: `0x${string}`;
  principal: bigint;
  aprBps: number;
  offerExpiry: bigint;
}

/** The desk signs an advance offer off-chain (gas-free for the desk). */
export async function signAdvanceOffer(
  wc: Wc,
  domain: ReturnType<typeof advancedEscrowDomain>,
  message: AdvanceOfferMessage,
): Promise<`0x${string}`> {
  return wc.signTypedData({
    domain,
    types: ADVANCE_OFFER_TYPES,
    primaryType: 'AdvanceOffer',
    message,
  });
}
