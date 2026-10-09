import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { baseSepolia, foundry } from 'viem/chains';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const ANVIL_RPC = process.env.HIRE402_RPC ?? 'http://127.0.0.1:8545';

/**
 * Chain selection: `HIRE402_CHAIN=base-sepolia` selects Base Sepolia
 * (chainId 84532); anything else defaults to the local anvil chain.
 * `HIRE402_RPC` must point at the matching RPC endpoint.
 */
export const CHAIN: Chain = process.env.HIRE402_CHAIN === 'base-sepolia' ? baseSepolia : foundry;

export function publicClient(rpc: string = ANVIL_RPC): PublicClient<Transport, Chain> {
  return createPublicClient({ chain: CHAIN, transport: http(rpc) });
}

export function account(privKey: `0x${string}`): PrivateKeyAccount {
  return privateKeyToAccount(privKey);
}

/** Wallet client with known chain and account (so writes need no extra params). */
export function walletClient(
  privKey: `0x${string}`,
  rpc: string = ANVIL_RPC,
): WalletClient<Transport, Chain, Account> {
  const acct = privateKeyToAccount(privKey);
  return createWalletClient({ chain: CHAIN, account: acct, transport: http(rpc) });
}

/**
 * Deterministic dev identities for the local Genesis Run (Phase 1).
 * genesis and provider hold ZERO USDC at start; ETH for gas is granted by
 * the deploy script. (Documented stance: gas is infrastructure; income is
 * economics. On mainnet, paymasters/relayers fill this role.)
 */
export const DEV = {
  // anvil[0] — 10,000 ETH, deploys contracts, is treasury+arbiter for dev
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  buyer:    '0x0000000000000000000000000000000000000000000000000000000000000b04',
  genesis:  '0x0000000000000000000000000000000000000000000000000000000000009e51',
  provider: '0x0000000000000000000000000000000000000000000000000000000000000de5',
  // Phase 2: courts. verifier = honest staked verifier; badVerifier = the
  // scripted meta-dispute participant that gets slashed. Phase 2.5: a
  // 3-verifier jury + the spawned child agent (reproduction demo).
  verifier:    '0x0000000000000000000000000000000000000000000000000000000000000fe5',
  badVerifier: '0x0000000000000000000000000000000000000000000000000000000000000bad',
  verifier2:   '0x0000000000000000000000000000000000000000000000000000000000000f26',
  verifier3:   '0x0000000000000000000000000000000000000000000000000000000000000f27',
  child:       '0x0000000000000000000000000000000000000000000000000000000000005eed',
  // Phase 3: the capital desk (spec §8) — advances working capital
  // against escrowed receivables; repaid first at milestone release.
  desk:        '0x000000000000000000000000000000000000000000000000000000000000de5c',
} as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** chain id of the dev chain (anvil / Base Sepolia set via CHAIN) */
export const CHAIN_ID = CHAIN.id;
