import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Add liquidity to ALL pools defined in deployments/sepolia.json.
 *
 * Usage:
 *   npx hardhat run scripts/addLiquidity.ts --network sepolia
 *
 * Reads pool and token info from sepolia.json. For each pool, approves
 * tokens and mints a full-range position via NonfungiblePositionManager.
 *
 * Liquidity amounts are configurable per pool in the POOL_LIQUIDITY map below.
 */

const DEPLOYMENTS_PATH = path.join(__dirname, "../deployments/sepolia.json");

const UNISWAP = {
  positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
};

// How much liquidity to add per pool (human-readable amounts for each side)
// Keys must match pool names in sepolia.json (e.g. "USDC/WETH")
const POOL_LIQUIDITY: Record<string, { amountA: string; amountB: string }> = {
  "USDC/WETH": { amountA: "10000", amountB: "5" },    // 10K USDC + 5 WETH
  "USDC/DAI":  { amountA: "10000", amountB: "10000" }, // 10K USDC + 10K DAI
  "USDC/USDT": { amountA: "10000", amountB: "10000" }, // 10K USDC + 10K USDT
};

const POSITION_MANAGER_ABI = [
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function symbol() external view returns (string)",
];

function getTickSpacing(fee: number): number {
  if (fee === 100) return 1;
  if (fee === 500) return 10;
  if (fee === 3000) return 60;
  if (fee === 10000) return 200;
  throw new Error(`Unknown fee tier: ${fee}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployments = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf-8"));

  console.log(`\n💧 Adding liquidity with: ${deployer.address}\n`);

  const positionManager = new ethers.Contract(
    UNISWAP.positionManager,
    POSITION_MANAGER_ABI,
    deployer
  );

  for (const [poolName, poolInfo] of Object.entries(deployments.pools) as [string, any][]) {
    const liquidity = POOL_LIQUIDITY[poolName];
    if (!liquidity) {
      console.log(`⏭ ${poolName}: no liquidity config, skipping`);
      continue;
    }

    // Parse pool name "USDC/WETH" → tokenA = "USDC", tokenB = "WETH"
    const [symbolA, symbolB] = poolName.split("/");
    const tokenAInfo = deployments.tokens[symbolA];
    const tokenBInfo = deployments.tokens[symbolB];

    if (!tokenAInfo || !tokenBInfo) {
      console.log(`⏭ ${poolName}: token info not found, skipping`);
      continue;
    }

    console.log(`\n🏊 ${poolName} (fee: ${poolInfo.fee / 10000}%, pool: ${poolInfo.address})`);

    // Sort by address to determine token0/token1
    const aIsToken0 = tokenAInfo.address.toLowerCase() < tokenBInfo.address.toLowerCase();
    const token0Addr = aIsToken0 ? tokenAInfo.address : tokenBInfo.address;
    const token1Addr = aIsToken0 ? tokenBInfo.address : tokenAInfo.address;
    const token0Decimals = aIsToken0 ? tokenAInfo.decimals : tokenBInfo.decimals;
    const token1Decimals = aIsToken0 ? tokenBInfo.decimals : tokenAInfo.decimals;
    const amount0Human = aIsToken0 ? liquidity.amountA : liquidity.amountB;
    const amount1Human = aIsToken0 ? liquidity.amountB : liquidity.amountA;

    const amount0 = ethers.parseUnits(amount0Human, token0Decimals);
    const amount1 = ethers.parseUnits(amount1Human, token1Decimals);

    console.log(`   token0: ${token0Addr} (${aIsToken0 ? symbolA : symbolB}), amount: ${amount0Human}`);
    console.log(`   token1: ${token1Addr} (${aIsToken0 ? symbolB : symbolA}), amount: ${amount1Human}`);

    // Check balances
    const token0Contract = new ethers.Contract(token0Addr, ERC20_ABI, deployer);
    const token1Contract = new ethers.Contract(token1Addr, ERC20_ABI, deployer);
    const bal0 = await token0Contract.balanceOf(deployer.address);
    const bal1 = await token1Contract.balanceOf(deployer.address);

    if (bal0 < amount0) {
      console.log(`   ⚠️ Insufficient token0 balance: have ${ethers.formatUnits(bal0, token0Decimals)}, need ${amount0Human}. Skipping.`);
      continue;
    }
    if (bal1 < amount1) {
      console.log(`   ⚠️ Insufficient token1 balance: have ${ethers.formatUnits(bal1, token1Decimals)}, need ${amount1Human}. Skipping.`);
      continue;
    }

    // Approve
    console.log(`   🔓 Approving tokens...`);
    await (await token0Contract.approve(UNISWAP.positionManager, amount0)).wait();
    await (await token1Contract.approve(UNISWAP.positionManager, amount1)).wait();

    // Compute tick range aligned to tick spacing
    const tickSpacing = getTickSpacing(poolInfo.fee);
    const tickLower = Math.ceil(-887272 / tickSpacing) * tickSpacing;
    const tickUpper = Math.floor(887272 / tickSpacing) * tickSpacing;
    console.log(`   📐 Tick range: ${tickLower} to ${tickUpper} (spacing: ${tickSpacing})`);

    // Mint position
    try {
      const tx = await positionManager.mint({
        token0: token0Addr,
        token1: token1Addr,
        fee: poolInfo.fee,
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        recipient: deployer.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
      });

      const receipt = await tx.wait();
      console.log(`   ✅ Liquidity added! tx: ${receipt.hash}`);
    } catch (error: any) {
      console.error(`   ❌ Mint failed: ${error.message?.slice(0, 120)}`);
    }
  }

  console.log(`\n🎉 Done!\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
