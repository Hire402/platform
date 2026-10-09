import { parseAbi } from 'viem';

/**
 * BondVault ABI (spec §8) — mirrors contracts/src/BondVault.sol.
 */
export const BOND_ABI = parseAbi([
  'function stake(uint256 amount)',
  'function unstake(uint256 amount)',
  'function slash(address verifier, address beneficiary, uint256 amount, string reason)',
  'function setSlasher(address who, bool allowed)',
  'function setPool(address newPool)',
  'function stakeOf(address) view returns (uint256)',
  'function slasher(address) view returns (bool)',
  'function owner() view returns (address)',
  'function pool() view returns (address)',
  'function totalStaked() view returns (uint256)',
  'function totalSlashed() view returns (uint256)',
  'event Staked(address indexed verifier, uint256 amount)',
  'event Unstaked(address indexed verifier, uint256 amount)',
  'event Slashed(address indexed verifier, address indexed beneficiary, uint256 amount, string reason)',
  'event SlasherUpdated(address indexed slasher, bool allowed)',
]);
