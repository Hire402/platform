import { parseAbi } from 'viem';

/**
 * AdvancedEscrow ABI (spec §8 Advances) — mirrors
 * contracts/src/AdvancedEscrow.sol (which inherits Hire402Escrow; the
 * inherited lifecycle surface lives in ESCROW_ABI).
 */
export const ADVANCED_ESCROW_ABI = parseAbi([
  // advance rail
  'function acceptAdvance(uint256 escrowId, uint256 principal, uint16 aprBps, uint64 offerExpiry, uint8 v, bytes32 r, bytes32 s)',
  'function repayAdvance(uint256 escrowId, uint256 amount)',
  // config views
  'function desk() view returns (address)',
  'function MIN_APR_BPS() view returns (uint16)',
  'function MAX_APR_BPS() view returns (uint16)',
  'function ADVANCE_BPS() view returns (uint16)',
  // advance views
  'function advanceOfferDigest(uint256 escrowId, address seller, uint256 principal, uint16 aprBps, uint64 offerExpiry) view returns (bytes32)',
  'function getAdvance(uint256 escrowId) view returns (uint256 principal, uint16 aprBps, uint256 accruedInterestNow, uint64 lastAccrual, uint256 totalRepaid)',
  'function advanceDebt(uint256 escrowId) view returns (uint256)',
  'function remainingReceivables(uint256 escrowId) view returns (uint256)',
  // events (indexer contract — spec §8)
  'event AdvanceAccepted(uint256 indexed escrowId, address indexed seller, uint256 principal, uint16 aprBps)',
  'event AdvanceRepaidFromRelease(uint256 indexed escrowId, uint256 indexed index, uint256 toDesk, uint256 interestPart, uint256 principalPart, uint256 remainingPrincipal)',
  'event AdvanceRepaid(uint256 indexed escrowId, address indexed payer, uint256 amount, uint256 interestPart, uint256 principalPart, uint256 remainingPrincipal)',
  'event DeskUpdated(address oldDesk, address newDesk)',
]);
