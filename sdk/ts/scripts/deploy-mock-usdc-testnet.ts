import fs from 'node:fs';
import path from 'node:path';
import { ANVIL_RPC, DEV, account, publicClient, walletClient } from '../src/chain';
import { ERC20_ABI, balanceOf } from '../src/erc20';

/**
 * Deploys MockUSDC on the chain at HIRE402_RPC (testnet fallback settlement
 * asset when real CDP testnet USDC isn't funded yet), records the address
 * IMMEDIATELY (so failures don't orphan contracts), then seeds the buyer.
 *
 * Public-RPC gotcha (found live): eth_estimateGas can hit a backend node
 * that hasn't indexed a just-deployed contract, estimating an EOA call
 * (~23k gas) — the tx then mines out-of-gas against the real contract.
 * Fix: explicit gas limits on all post-deploy calls to fresh contracts.
 */
const SEED = 100_000_000n;
const TRANSFER_GAS = 120_000n;

async function main() {
  const root = process.cwd();
  const keyFile = path.join(root, 'ops', 'data', 'base-sepolia-deployer.json');
  if (!fs.existsSync(keyFile)) throw new Error('deployer key file missing');
  const d = JSON.parse(fs.readFileSync(keyFile, 'utf8')).data;
  const deployerData = Array.isArray(d) ? d[0] : d;
  const deployer = walletClient(deployerData.private_key as `0x${string}`, ANVIL_RPC);
  const pc = publicClient(ANVIL_RPC);
  const buyerAddr = account(DEV.buyer as `0x${string}`).address;

  const recordFile = path.join(root, 'ops', 'data', 'testnet-mock-usdc.json');
  let usdc: `0x${string}`;

  if (fs.existsSync(recordFile)) {
    usdc = (JSON.parse(fs.readFileSync(recordFile, 'utf8')) as { usdc: `0x${string}` }).usdc;
    console.log(`[deploy] reusing MockUSDC at ${usdc}`);
  } else {
    const artPath = path.join(root, 'contracts', 'out', 'MockUSDC.sol', 'MockUSDC.json');
    if (!fs.existsSync(artPath)) throw new Error(`artifact missing: ${artPath} (run \`forge build\` first)`);
    const usdcArt = JSON.parse(fs.readFileSync(artPath, 'utf8'));

    console.log(`[deploy] MockUSDC on ${ANVIL_RPC} …`);
    const hash = await deployer.deployContract({
      abi: usdcArt.abi,
      bytecode: usdcArt.bytecode.object as `0x${string}`,
    });
    const receipt = await pc.waitForTransactionReceipt({ hash });
    usdc = receipt.contractAddress as `0x${string}`;
    if (!usdc) throw new Error('MockUSDC deploy failed');
    console.log(`[deploy] MockUSDC deployed at ${usdc} (tx ${hash})`);

    // Record the address IMMEDIATELY — before any further steps that might
    // fail — so re-runs reuse this contract instead of deploying orphans.
    fs.writeFileSync(recordFile, JSON.stringify({
      usdc,
      chainRpc: ANVIL_RPC,
      deployTx: hash,
      generatedAt: new Date().toISOString(),
    }, null, 2));
  }

  // Seed the buyer (platform as the market's first buyer). Explicit gas:
  // the fresh contract may not be indexed on every RPC backend yet.
  let buyerBal = 0n;
  for (let i = 0; i < 12 && buyerBal < SEED; i++) {
    buyerBal = await balanceOf(pc, usdc, buyerAddr);
    if (buyerBal >= SEED) break;
    if (i === 0) {
      const seedTx = await deployer.writeContract({
        address: usdc,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [buyerAddr, SEED],
        gas: TRANSFER_GAS, // explicit: never trust estimates against a fresh contract
      });
      await pc.waitForTransactionReceipt({ hash: seedTx });
      console.log(`[seed  ] transfer sent (${seedTx})`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (buyerBal !== SEED) throw new Error(`buyer seed failed: ${buyerBal}`);
  console.log(`[seed  ] 100.00 USDC → buyer ${buyerAddr} (confirmed)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
