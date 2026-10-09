import { parseAbi } from 'viem';

/**
 * Hire402Escrow ABI (spec §5.3) — mirrors contracts/src/Hire402Escrow.sol.
 * Plain-text form for type safety via viem's parseAbi.
 */
export const ESCROW_ABI = parseAbi([
  // lifecycle
  'function create((address token, address seller, address verifier, address arbiter, uint16 feeBps, uint32 challengeSeconds, (uint128 amount, uint64 deadline, string descriptionURI)[] milestones) p) returns (uint256)',
  'function fund(uint256 escrowId)',
  'function start(uint256 escrowId)',
  'function submit(uint256 escrowId, uint256 index, string attestationURI)',
  'function approve(uint256 escrowId, uint256 index)',
  'function claim(uint256 escrowId, uint256 index, uint8 v, bytes32 r, bytes32 s, uint64 sigExpiry)',
  'function dispute(uint256 escrowId, uint256 index, string reasonURI)',
  'function resolve(uint256 escrowId, uint256 index, bool releaseToSeller, string verdictURI)',
  'function expireRefund(uint256 escrowId, uint256 index)',
  'function cancel(uint256 escrowId)',
  // config views
  'function escrowCount() view returns (uint256)',
  'function treasury() view returns (address)',
  'function defaultArbiter() view returns (address)',
  'function minFeeBps() view returns (uint16)',
  'function maxFeeBps() view returns (uint16)',
  // escrow views
  'function approvalDigest(uint256 escrowId, uint256 milestoneIndex, uint128 amount, uint64 sigExpiry) view returns (bytes32)',
  'function getEscrowCore(uint256 escrowId) view returns (address buyer, address seller, address verifier, address arbiter, address token, uint16 feeBps, uint32 challengeSeconds, uint8 state)',
  'function getEscrowTotals(uint256 escrowId) view returns (uint256 totalAmount, uint256 released, uint256 refunded, uint256 feesPaid, uint64 fundedAt)',
  'function milestoneCount(uint256 escrowId) view returns (uint256)',
  'function getMilestone(uint256 escrowId, uint256 index) view returns (uint128 amount, uint64 deadline, uint64 submittedAt, uint8 status, bool resolvedRelease)',
  'function getMilestoneURIs(uint256 escrowId, uint256 index) view returns (string descriptionURI, string attestationURI)',
  // events (indexer contract — spec §5.6)
  'event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed seller, address verifier, address arbiter, address token, uint256 totalAmount, uint16 feeBps, uint32 challengeSeconds, uint256 milestoneCount)',
  'event EscrowFunded(uint256 indexed escrowId, uint256 totalAmount)',
  'event EscrowStarted(uint256 indexed escrowId)',
  'event MilestoneSubmitted(uint256 indexed escrowId, uint256 indexed index, string attestationURI)',
  'event MilestoneApproved(uint256 indexed escrowId, uint256 indexed index, address indexed approver)',
  'event MilestoneReleased(uint256 indexed escrowId, uint256 indexed index, address indexed payee, uint256 payout, uint256 fee)',
  'event MilestoneRefunded(uint256 indexed escrowId, uint256 indexed index, uint256 amount, uint8 reason)',
  'event MilestoneDisputed(uint256 indexed escrowId, uint256 indexed index, address indexed disputer, string reasonURI)',
  'event MilestoneResolved(uint256 indexed escrowId, uint256 indexed index, address indexed arbiter, bool releaseToSeller, string verdictURI)',
  'event EscrowCompleted(uint256 indexed escrowId, uint256 released, uint256 refunded, uint256 feesPaid)',
  'event EscrowCancelled(uint256 indexed escrowId, uint256 refundedAmount)',
]);
