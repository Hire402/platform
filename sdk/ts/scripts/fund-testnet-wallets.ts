import fs from 'node:fs';
import path from 'node:path';
import { formatEther, parseEther } from 'viem';
import { ANVIL_RPC, DEV, account, publicClient, walletClient } from '../src/chain';

/**
 * Tops up the three dev agent wallets with gas from the local deployer key —
 * sequentially, waiting for each receipt (no nonce collisions on real chains).
 */
const TOPUP = parseEther('0.001');
const MIN = parseEther('0.0003');

async function main() {
  const root = process.cwd();
  const keyFile = path.join(root, 'ops', 'data', 'base-sepolia-deployer.json');
  if (!fs.existsSync(keyFile)) throw new Error('deployer key file missing');
  const d = JSON.parse(fs.readFileSync(keyFile, 'utf8')).data;
  const deployerData = Array.isArray(d) ? d[0] : d;
  const deployer = walletClient(deployerData.private_key as `0x${string}`, ANVIL_RPC);
  const pc = publicClient(ANVIL_RPC);

  for (const [name, key] of [
    ['buyer', DEV.buyer],
    ['genesis', DEV.genesis],
    ['provider', DEV.provider],
  ] as const) {
    const addr = account(key as `0x${string}`).address;
    const bal = await pc.getBalance({ address: addr });
    if (bal >= MIN) {
      console.log(`[gas  ] ${name} ${addr} has ${formatEther(bal)} ETH — ok`);
      continue;
    }
    const hash = await deployer.sendTransaction({ to: addr, value: TOPUP });
    await pc.waitForTransactionReceipt({ hash });
    console.log(`[gas  ] +${formatEther(TOPUP)} ETH → ${name} ${addr} (tx ${hash})`);
  }
  console.log('[gas  ] all agent wallets funded');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
