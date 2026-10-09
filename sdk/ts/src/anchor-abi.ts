import { parseAbi } from 'viem';

/**
 * ReputationAnchor ABI (spec §7) — mirrors
 * contracts/src/ReputationAnchor.sol. The registry anchors one Merkle root
 * over all self-registered agents' reputation aggregates per epoch; the
 * chain enforces the gapless epoch sequence.
 */
export const ANCHOR_ABI = parseAbi([
  // errors (so viem can decode reverts — anchorABI without them reports
  // raw selectors like 0xd5b25b63 instead of InvalidEpoch)
  'error NotAnchorer()',
  'error NotOwner()',
  'error InvalidAddress()',
  'error InvalidEpoch()',
  'error EmptyRoot()',
  'function anchor(uint256 epoch, bytes32 root, uint256 leafCount)',
  'function setAnchorer(address newAnchorer)',
  // config views
  'function EPOCH_SECONDS() view returns (uint256)',
  'function owner() view returns (address)',
  'function anchorer() view returns (address)',
  'function latestEpoch() view returns (uint256)',
  // epoch views
  'function roots(uint256 epoch) view returns (bytes32)',
  'function leafCounts(uint256 epoch) view returns (uint256)',
  'function epochAt(uint256 epoch) view returns (bytes32 root, uint256 leafCount, bool anchored)',
  // events
  'event ReputationAnchored(uint256 indexed epoch, bytes32 root, uint256 leafCount)',
  'event AnchorerUpdated(address oldAnchorer, address newAnchorer)',
]);
