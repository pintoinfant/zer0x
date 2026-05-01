import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy mock ERC20 tokens for PayAgent testing on Sepolia.
 *
 * Idempotent: reads deployments/sepolia.json — if tokens exist, skips deployment.
 */

const DEPLOYMENTS_PATH = path.join(__dirname, "../deployments/sepolia.json");

interface TokenConfig {
  name: string;
  symbol: string;
  decimals: number;
  mintAmount: string; // human-readable amount to mint to deployer
}

const TOKENS: TokenConfig[] = [
  { name: "Mock USDC", symbol: "USDC", decimals: 6, mintAmount: "10000" },
  { name: "Mock USDT", symbol: "USDT", decimals: 6, mintAmount: "10000" },
  { name: "Mock WETH", symbol: "WETH", decimals: 18, mintAmount: "10" },
  { name: "Mock DAI", symbol: "DAI", decimals: 18, mintAmount: "10000" },
];

interface Deployments {
  network: string;
  deployer: string;
  tokens: Record<string, { address: string; decimals: number }>;
  pools?: Record<string, { address: string; fee: number }>;
}

function loadDeployments(): Deployments | null {
  if (fs.existsSync(DEPLOYMENTS_PATH)) {
    return JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf-8"));
  }
  return null;
}

function saveDeployments(data: Deployments): void {
  fs.writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(data, null, 2));
  console.log(`\n💾 Saved to ${DEPLOYMENTS_PATH}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🚀 Deploying mock tokens with: ${deployer.address}\n`);

  // Check existing deployments
  const existing = loadDeployments();
  if (existing && existing.tokens && Object.keys(existing.tokens).length === TOKENS.length) {
    console.log("✅ All tokens already deployed. Skipping.");
    console.log("   Tokens:", JSON.stringify(existing.tokens, null, 2));
    console.log("\n   To redeploy, delete deployments/sepolia.json");
    return;
  }

  const deployments: Deployments = {
    network: "sepolia",
    deployer: deployer.address,
    tokens: existing?.tokens ?? {},
    pools: existing?.pools ?? {},
  };

  const MockERC20 = await ethers.getContractFactory("MockERC20");

  for (const token of TOKENS) {
    // Skip if already deployed
    if (deployments.tokens[token.symbol]) {
      console.log(`⏭ ${token.symbol} already deployed at ${deployments.tokens[token.symbol].address}`);
      continue;
    }

    console.log(`📦 Deploying ${token.symbol} (${token.name}, ${token.decimals} decimals)...`);
    const contract = await MockERC20.deploy(token.name, token.symbol, token.decimals);
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    // Mint initial supply to deployer
    const mintAmount = ethers.parseUnits(token.mintAmount, token.decimals);
    const tx = await contract.mint(deployer.address, mintAmount);
    await tx.wait();

    deployments.tokens[token.symbol] = { address, decimals: token.decimals };
    console.log(`   ✅ ${token.symbol}: ${address} (minted ${token.mintAmount})`);

    // Save after each deploy so partial deploys are preserved
    saveDeployments(deployments);
  }

  console.log("\n🎉 All tokens deployed!");
  console.log(JSON.stringify(deployments.tokens, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
