import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Create Uniswap V3 pools with our mock tokens and add initial liquidity.
 *
 * Uses the existing Uniswap V3 deployment on Sepolia:
 * - Factory:                    0x0227628f3F023bb0B980b67D528571c95c6DaC1c
 * - NonfungiblePositionManager: 0x1238536071E1c677A632429e3655c799b22cDA52
 * - SwapRouter02:               0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E
 *
 * Idempotent: if pools already recorded in sepolia.json, skips creation.
 */

const DEPLOYMENTS_PATH = path.join(__dirname, "../deployments/sepolia.json");

// Uniswap V3 Sepolia addresses
const UNISWAP = {
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
  swapRouter: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
};

// ABIs (minimal)
const FACTORY_ABI = [
  "function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)",
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const POOL_ABI = [
  "function initialize(uint160 sqrtPriceX96) external",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const POSITION_MANAGER_ABI = [
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

interface Deployments {
  network: string;
  deployer: string;
  tokens: Record<string, { address: string; decimals: number }>;
  pools: Record<string, { address: string; fee: number }>;
}

interface PoolConfig {
  name: string;       // e.g. "USDC/WETH"
  tokenA: string;     // symbol
  tokenB: string;     // symbol
  fee: number;        // fee tier in bps * 100 (e.g. 3000 = 0.3%)
  // price: how many tokenA per tokenB (e.g. 2000 USDC per WETH)
  price: number;
  // Liquidity amounts (human readable)
  amountA: string;
  amountB: string;
}

const POOLS: PoolConfig[] = [
  {
    name: "USDC/WETH",
    tokenA: "USDC",
    tokenB: "WETH",
    fee: 10000,       // 1% — new fee tier (old 3000 pool has wrong price, can't reinitialize)
    price: 2000,      // 1 WETH = 2000 USDC
    amountA: "10000", // 10000 USDC
    amountB: "5",     // 5 WETH
  },
  {
    name: "USDC/DAI",
    tokenA: "USDC",
    tokenB: "DAI",
    fee: 3000,        // 0.3% — new fee tier (old 500 pool has wrong price)
    price: 1,         // 1:1 stablecoin
    amountA: "10000",
    amountB: "10000",
  },
  {
    name: "USDC/USDT",
    tokenA: "USDC",
    tokenB: "USDT",
    fee: 500,         // 0.05% — keep existing (correct price)
    price: 1,         // 1:1 stablecoin
    amountA: "5000",
    amountB: "5000",
  },
];

/**
 * Integer square root via Newton's method (BigInt).
 */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("Square root of negative number");
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Compute sqrtPriceX96 for a given human-readable price.
 *
 * In Uniswap V3, sqrtPriceX96 = sqrt(token1_raw / token0_raw) * 2^96.
 * token0 is the token with the lower address.
 *
 * priceOfBInA means "1 unit of B costs `priceOfBInA` units of A" in human terms.
 *
 * Uses BigInt arithmetic throughout to avoid floating-point precision loss.
 */
function computeSqrtPriceX96(
  priceOfBInA: number,
  decimalsA: number,
  decimalsB: number,
  addressA: string,
  addressB: string
): bigint {
  // Uniswap V3 sorts tokens by address — token0 is the lower address
  const aIsToken0 = addressA.toLowerCase() < addressB.toLowerCase();
  const Q96 = BigInt(2) ** BigInt(96);
  const Q192 = Q96 * Q96;

  // Express price as integer ratio: priceOfBInA = priceNum / priceDen
  // For integer prices (2000, 1, etc.) priceDen = 1
  const priceNum = BigInt(Math.round(priceOfBInA * 1e6));
  const priceDen = BigInt(1e6);

  // price_raw = token1_raw / token0_raw
  // We need to express this correctly depending on which token is token0.
  let numerator: bigint;
  let denominator: bigint;

  if (aIsToken0) {
    // token0 = A, token1 = B
    // 1 human A = (1/priceOfBInA) human B
    // In raw: 10^decimalsA raw_A → (1/priceOfBInA) * 10^decimalsB raw_B
    // price_raw = raw_B / raw_A = (10^decimalsB / priceOfBInA) / 10^decimalsA
    //           = 10^decimalsB * priceDen / (priceNum * 10^decimalsA)
    numerator = BigInt(10) ** BigInt(decimalsB) * priceDen;
    denominator = priceNum * BigInt(10) ** BigInt(decimalsA);
  } else {
    // token0 = B, token1 = A
    // 1 human B = priceOfBInA human A
    // In raw: 10^decimalsB raw_B → priceOfBInA * 10^decimalsA raw_A
    // price_raw = raw_A / raw_B = priceOfBInA * 10^decimalsA / 10^decimalsB
    numerator = priceNum * BigInt(10) ** BigInt(decimalsA);
    denominator = priceDen * BigInt(10) ** BigInt(decimalsB);
  }

  // sqrtPriceX96 = sqrt(numerator / denominator) * 2^96
  //              = isqrt(numerator * Q192 / denominator)
  const sqrtPriceX96 = isqrt((numerator * Q192) / denominator);

  return sqrtPriceX96;
}

function loadDeployments(): Deployments {
  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error("No deployments/sepolia.json found. Run deploy:tokens first.");
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf-8"));
}

function saveDeployments(data: Deployments): void {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
  console.log(`💾 Saved to ${DEPLOYMENTS_PATH}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🚀 Creating Uniswap V3 pools with: ${deployer.address}\n`);

  const deployments = loadDeployments();

  // Verify all tokens exist
  for (const pool of POOLS) {
    if (!deployments.tokens[pool.tokenA]) {
      throw new Error(`Token ${pool.tokenA} not found in deployments. Run deploy:tokens first.`);
    }
    if (!deployments.tokens[pool.tokenB]) {
      throw new Error(`Token ${pool.tokenB} not found in deployments. Run deploy:tokens first.`);
    }
  }

  if (!deployments.pools) {
    deployments.pools = {};
  }

  const factory = new ethers.Contract(UNISWAP.factory, FACTORY_ABI, deployer);
  const positionManager = new ethers.Contract(UNISWAP.positionManager, POSITION_MANAGER_ABI, deployer);

  for (const poolCfg of POOLS) {
    // Skip if already created
    if (deployments.pools[poolCfg.name]) {
      console.log(`⏭ Pool ${poolCfg.name} already exists at ${deployments.pools[poolCfg.name].address}`);
      continue;
    }

    const tokenAInfo = deployments.tokens[poolCfg.tokenA];
    const tokenBInfo = deployments.tokens[poolCfg.tokenB];

    console.log(`\n🏊 Creating pool: ${poolCfg.name} (fee: ${poolCfg.fee / 10000}%)...`);

    // Check if pool already exists on-chain
    let poolAddress = await factory.getPool(tokenAInfo.address, tokenBInfo.address, poolCfg.fee);

    if (poolAddress === ethers.ZeroAddress) {
      console.log(`   📦 Creating pool...`);
      const createTx = await factory.createPool(tokenAInfo.address, tokenBInfo.address, poolCfg.fee);
      await createTx.wait();
      poolAddress = await factory.getPool(tokenAInfo.address, tokenBInfo.address, poolCfg.fee);
      console.log(`   ✅ Pool created: ${poolAddress}`);
    } else {
      console.log(`   ✅ Pool already exists on-chain: ${poolAddress}`);
    }

    // Initialize the pool with the price
    const pool = new ethers.Contract(poolAddress, POOL_ABI, deployer);

    try {
      const slot0 = await pool.slot0();
      if (slot0.sqrtPriceX96 === BigInt(0)) {
        throw new Error("Not initialized");
      }
      console.log(`   ✅ Pool already initialized (sqrtPriceX96: ${slot0.sqrtPriceX96})`);
    } catch {
      const sqrtPriceX96 = computeSqrtPriceX96(
        poolCfg.price,
        tokenAInfo.decimals,
        tokenBInfo.decimals,
        tokenAInfo.address,
        tokenBInfo.address
      );
      console.log(`   ⏳ Initializing pool with sqrtPriceX96: ${sqrtPriceX96}...`);
      const initTx = await pool.initialize(sqrtPriceX96);
      await initTx.wait();
      console.log(`   ✅ Pool initialized`);
    }

    // Add liquidity
    console.log(`   💧 Adding liquidity: ${poolCfg.amountA} ${poolCfg.tokenA} + ${poolCfg.amountB} ${poolCfg.tokenB}...`);

    // Approve tokens
    const tokenAContract = new ethers.Contract(tokenAInfo.address, ERC20_ABI, deployer);
    const tokenBContract = new ethers.Contract(tokenBInfo.address, ERC20_ABI, deployer);

    const amountAWei = ethers.parseUnits(poolCfg.amountA, tokenAInfo.decimals);
    const amountBWei = ethers.parseUnits(poolCfg.amountB, tokenBInfo.decimals);

    const approveTxA = await tokenAContract.approve(UNISWAP.positionManager, amountAWei);
    await approveTxA.wait();
    const approveTxB = await tokenBContract.approve(UNISWAP.positionManager, amountBWei);
    await approveTxB.wait();

    // Determine token0/token1 order (lower address = token0)
    const token0 = tokenAInfo.address.toLowerCase() < tokenBInfo.address.toLowerCase()
      ? tokenAInfo.address
      : tokenBInfo.address;
    const token1 = token0 === tokenAInfo.address ? tokenBInfo.address : tokenAInfo.address;
    const amount0 = token0 === tokenAInfo.address ? amountAWei : amountBWei;
    const amount1 = token0 === tokenAInfo.address ? amountBWei : amountAWei;

    // Use wide tick range (nearly full range, aligned to tick spacing for the fee tier)
    // Tick spacing: fee 500 → 10, fee 3000 → 60, fee 10000 → 200
    const tickSpacing = poolCfg.fee === 500 ? 10 : poolCfg.fee === 3000 ? 60 : 200;
    const tickLower = Math.ceil(-887272 / tickSpacing) * tickSpacing;
    const tickUpper = Math.floor(887272 / tickSpacing) * tickSpacing;

    try {
      const mintTx = await positionManager.mint({
        token0,
        token1,
        fee: poolCfg.fee,
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0,
        amount1Min: 0,
        recipient: deployer.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
      });
      const receipt = await mintTx.wait();
      console.log(`   ✅ Liquidity added (tx: ${receipt.hash})`);
    } catch (error: any) {
      console.warn(`   ⚠️ Liquidity mint failed: ${error.message?.slice(0, 100)}`);
      console.warn(`   Pool was created but may need manual liquidity. Saving pool address anyway.`);
    }

    deployments.pools[poolCfg.name] = { address: poolAddress, fee: poolCfg.fee };
    saveDeployments(deployments);
  }

  console.log("\n🎉 All pools ready!");
  console.log(JSON.stringify(deployments.pools, null, 2));

  // Also log the Uniswap infrastructure addresses
  console.log("\n📍 Uniswap V3 (Sepolia):");
  console.log(`   Factory:          ${UNISWAP.factory}`);
  console.log(`   PositionManager:  ${UNISWAP.positionManager}`);
  console.log(`   SwapRouter02:     ${UNISWAP.swapRouter}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
