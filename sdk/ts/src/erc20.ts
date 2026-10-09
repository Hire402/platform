import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem';

type Wc = WalletClient<Transport, Chain, Account>;
type Pc = PublicClient<Transport, Chain>;

export const ERC20_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export async function balanceOf(
  pc: PublicClient,
  erc20: `0x${string}`,
  holder: `0x${string}`,
): Promise<bigint> {
  return pc.readContract({
    address: erc20,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [holder],
  });
}

export async function approve(
  wc: Wc,
  erc20: `0x${string}`,
  spender: `0x${string}`,
  amount: bigint,
): Promise<`0x${string}`> {
  return wc.writeContract({
    address: erc20,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

export async function transfer(
  wc: Wc,
  pc: Pc,
  erc20: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<{ hash: `0x${string}`; receipt: unknown }> {
  const hash = await wc.writeContract({
    address: erc20,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}
