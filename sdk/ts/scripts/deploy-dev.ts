import fs from 'node:fs';
import path from 'node:path';
import { parseEther } from 'viem';
import { ANVIL_RPC, DEV, account, publicClient, walletClient } from '../src/chain';
import { ERC20_ABI, balanceOf } from '../src/erc20';
import { ESCROW_ABI } from '../src/escrow-abi';
import { BOND_ABI } from '../src/bond-abi';

/**
 * Local dev deploy (anvil): MockUSDC + Hire402Escrow + BondVault (Phase 2
 * courts), gas grants, bond seeding for the verifier agents, and the
 * platform-seeded buyer. Writes ops/deployments.local.json.
 * Run from the repo root: `npx tsx sdk/ts/scripts/deploy-dev.ts`
 */
async function main() {
  const root = process.cwd();
  const readArtifact = (rel: string) => {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) throw new Error(`artifact missing: ${p} (run \`forge build\` first)`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  const escrowArt = readArtifact('contracts/out/Hire402Escrow.sol/Hire402Escrow.json');
  const advArt = readArtifact('contracts/out/AdvancedEscrow.sol/AdvancedEscrow.json');
  const anchorArt = readArtifact('contracts/out/ReputationAnchor.sol/ReputationAnchor.json');
  const usdcArt = readArtifact('contracts/out/MockUSDC.sol/MockUSDC.json');
  const bondArt = readArtifact('contracts/out/BondVault.sol/BondVault.json');

  const pc = publicClient(ANVIL_RPC);
  const deployer = walletClient(DEV.deployer, ANVIL_RPC);
  const deployerAddr = account(DEV.deployer).address;

  console.log('[deploy] MockUSDC…');
  const usdcHash = await deployer.deployContract({
    abi: usdcArt.abi,
    bytecode: usdcArt.bytecode.object as `0x${string}`,
  });
  const usdc = (await pc.waitForTransactionReceipt({ hash: usdcHash })).contractAddress;
  if (!usdc) throw new Error('USDC deploy failed');

  console.log('[deploy] Hire402Escrow(treasury=deployer, min=150bps, cap=300bps)…');
  const escrowHash = await deployer.deployContract({
    abi: escrowArt.abi,
    bytecode: escrowArt.bytecode.object as `0x${string}`,
    args: [deployerAddr, 150, 300],
  });
  const escrow = (await pc.waitForTransactionReceipt({ hash: escrowHash })).contractAddress;
  if (!escrow) throw new Error('escrow deploy failed');

  console.log('[deploy] BondVault(token=USDC, pool=deployer)…');
  const bondHash = await deployer.deployContract({
    abi: bondArt.abi,
    bytecode: bondArt.bytecode.object as `0x${string}`,
    args: [usdc, deployerAddr],
  });
  const bond = (await pc.waitForTransactionReceipt({ hash: bondHash })).contractAddress;
  if (!bond) throw new Error('BondVault deploy failed');

  console.log('[deploy] AdvancedEscrow(treasury=deployer, min=150bps, cap=300bps, desk=DEV.desk)…');
  const deskAddr = account(DEV.desk as `0x${string}`).address;
  const advHash = await deployer.deployContract({
    abi: advArt.abi,
    bytecode: advArt.bytecode.object as `0x${string}`,
    args: [deployerAddr, 150, 300, deskAddr],
  });
  const advancedEscrow = (await pc.waitForTransactionReceipt({ hash: advHash })).contractAddress;
  if (!advancedEscrow) throw new Error('AdvancedEscrow deploy failed');

  console.log('[deploy] ReputationAnchor(anchorer=deployer)…');
  const anchorHash = await deployer.deployContract({
    abi: anchorArt.abi,
    bytecode: anchorArt.bytecode.object as `0x${string}`,
    args: [deployerAddr],
  });
  const anchor = (await pc.waitForTransactionReceipt({ hash: anchorHash })).contractAddress;
  if (!anchor) throw new Error('ReputationAnchor deploy failed');

  // The court (which holds the arbiter key = deployer) must be authorized
  // to slash. Explicit gas: fresh-contract estimates can hit stale backends.
  const slasherTx = await deployer.writeContract({
    address: bond as `0x${string}`,
    abi: BOND_ABI,
    functionName: 'setSlasher',
    args: [deployerAddr, true],
    gas: 100_000n,
  });
  await pc.waitForTransactionReceipt({ hash: slasherTx });
  console.log('[court ] arbiter authorized as BondVault slasher');

  // Gas grants — gas is infrastructure, income is economics (see chain.ts).
  for (const [name, key] of [
    ['buyer', DEV.buyer],
    ['genesis', DEV.genesis],
    ['provider', DEV.provider],
    ['verifier', DEV.verifier],
    ['badVerifier', DEV.badVerifier],
    ['verifier2', DEV.verifier2],
    ['verifier3', DEV.verifier3],
    ['child', DEV.child],
    ['desk', DEV.desk],
  ] as const) {
    const tx = await deployer.sendTransaction({
      to: account(key).address,
      value: parseEther('1'),
    });
    await pc.waitForTransactionReceipt({ hash: tx });
    console.log(`[fund  ] 1 ETH → ${name} (${account(key).address})`);
  }

  // Seed: buyer (the market's first buyer) + verifier agents (the market's
  // first courts — platform dogfooding per GTM §5.6).
  const seed = async (key: string, amount: bigint, label: string) => {
    const tx = await deployer.writeContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [account(key as `0x${string}`).address, amount],
      gas: 120_000n,
    });
    await pc.waitForTransactionReceipt({ hash: tx });
    console.log(`[seed  ] ${label} ${Number(amount) / 1e6} USDC`);
  };
  await seed(DEV.buyer, 100_000_000n, 'buyer (platform as first buyer)');
  await seed(DEV.verifier, 5_000_000n, 'verifier (platform as first verifier employer)');
  await seed(DEV.verifier2, 5_000_000n, 'verifier2 (jury)');
  await seed(DEV.verifier3, 5_000_000n, 'verifier3 (jury)');
  await seed(DEV.badVerifier, 2_000_000n, 'badVerifier (scripted meta-dispute participant)');

  // Phase 3 capital desk (spec §8): a USDC float + disbursement approval.
  await seed(DEV.desk, 10_000_000n, 'desk (capital desk float)');
  const deskWc = walletClient(DEV.desk as `0x${string}`, ANVIL_RPC);
  const deskApprove = await deskWc.writeContract({
    address: usdc as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [advancedEscrow as `0x${string}`, 2n ** 256n - 1n],
    gas: 100_000n,
  });
  await pc.waitForTransactionReceipt({ hash: deskApprove });
  console.log('[desk  ] desk approved AdvancedEscrow to disburse advances');
  // NOTE: DEV.child gets NO USDC — spawned children are funded by their
  // parent's seed, not by the platform (spec §9).

  // Zero-funding invariants: genesis and provider start with 0 USDC.
  const gBal = await balanceOf(pc, usdc, account(DEV.genesis).address);
  const pBal = await balanceOf(pc, usdc, account(DEV.provider).address);
  if (gBal !== 0n || pBal !== 0n) throw new Error('zero-funding invariant violated');

  const deployment = {
    chainId: 31337,
    rpc: ANVIL_RPC,
    escrow,
    advancedEscrow,
    anchor,
    bond,
    usdc,
    treasury: deployerAddr,
    arbiter: deployerAddr,
    deployer: deployerAddr,
    desk: deskAddr,
    mock: true,
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ops/deployments.local.json'), JSON.stringify(deployment, null, 2));
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

