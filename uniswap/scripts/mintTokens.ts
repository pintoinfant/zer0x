import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Mint additional mock tokens to the deployer wallet.
 * Use this when you've run out of tokens after providing pool liquidity.
 *
 * Usage: pnpm --filter @zer0x/uniswap mint
 */

const DEPLOYMENTS_PATH = path.join(__dirname, "../deployments/sepolia.json");

const ERC20_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

// How much to mint per token
const MINT_AMOUNTS: Record<string, string> = {
  USDC: "100000",   // 100K USDC
  USDT: "100000",   // 100K USDT
  WETH: "100",      // 100 WETH
  DAI:  "100000",   // 100K DAI
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🪙 Minting tokens to: ${deployer.address}\n`);

  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error("No deployments/sepolia.json found. Run deploy:tokens first.");
  }

  const data = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf-8"));

  for (const [symbol, info] of Object.entries(data.tokens) as [string, { address: string; decimals: number }][]) {
    const mintAmount = MINT_AMOUNTS[symbol];
    if (!mintAmount) continue;

    const token = new ethers.Contract(info.address, ERC20_ABI, deployer);

    // Check current balance
    const balBefore = await token.balanceOf(deployer.address);
    const balStr = ethers.formatUnits(balBefore, info.decimals);

    console.log(`📊 ${symbol}: current balance = ${balStr}`);

    // Mint
    const amount = ethers.parseUnits(mintAmount, info.decimals);
    const tx = await token.mint(deployer.address, amount);
    await tx.wait();

    const balAfter = await token.balanceOf(deployer.address);
    const balAfterStr = ethers.formatUnits(balAfter, info.decimals);
    console.log(`   ✅ Minted ${mintAmount} ${symbol} → new balance: ${balAfterStr}\n`);
  }

  console.log("🎉 Done! Your wallet is topped up.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
