import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load .env from project root (two levels up from agent/src/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import { PayAgentStorage } from "./storage.js";
import { PayAgentLLM } from "./llm.js";
import { PayAgentContract } from "./contract.js";
import { SwapExecutor } from "./swap.js";
import { PayAgent } from "./agent.js";
import { createBot, setGlobalAgent } from "./bot.js";

// =========================================================================
// PayAgent — Entry Point
//
// Initializes all components and starts the Telegram bot.
// =========================================================================

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getPrivateKey(): string {
  const raw = requireEnv("PRIVATE_KEY");
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function main() {
  console.log("=== PayAgent Starting ===\n");

  // -----------------------------------------------------------------------
  // 1. Initialize 0G Storage
  // -----------------------------------------------------------------------
  console.log("[init] Setting up 0G Storage...");
  const storage = new PayAgentStorage({
    rpcUrl: process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai",
    indexerUrl: process.env.ZG_INDEXER_URL || "https://indexer-storage-testnet-turbo.0g.ai",
    flowContractAddress:
      process.env.ZG_STORAGE_FLOW_CONTRACT || "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296",
    privateKey: getPrivateKey(),
  });
  await storage.init();
  console.log("[init] 0G Storage ready (with local fallback)\n");

  // -----------------------------------------------------------------------
  // 2. Initialize 0G Compute (LLM)
  // -----------------------------------------------------------------------
  console.log("[init] Setting up 0G Compute LLM...");
  const llm = new PayAgentLLM({
    baseUrl:
      process.env.ZG_COMPUTE_BASE_URL ||
      "https://router-api-testnet.integratenetwork.work/v1",
    apiKey: requireEnv("ZG_COMPUTE_API_KEY"),
    model: process.env.ZG_COMPUTE_MODEL || "deepseek-chat",
  });
  console.log("[init] 0G Compute LLM ready\n");

  // -----------------------------------------------------------------------
  // 3. Initialize PayAgentNFT contract (0G Testnet)
  // -----------------------------------------------------------------------
  console.log("[init] Setting up PayAgentNFT contract...");
  const contract = new PayAgentContract({
    nftAddress: requireEnv("PAYAGENT_NFT_ADDRESS"),
    rpcUrl: process.env.ZG_RPC_URL || "https://evmrpc-testnet.0g.ai",
    privateKey: getPrivateKey(),
  });
  const walletAddr = await contract.getAddress();
  console.log(`[init] Contract ready, wallet: ${walletAddr}\n`);

  // -----------------------------------------------------------------------
  // 4. Initialize Uniswap swap executor (Sepolia)
  // -----------------------------------------------------------------------
  console.log("[init] Setting up Uniswap swap executor (Sepolia)...");
  const swap = new SwapExecutor({
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    privateKey: getPrivateKey(),
    maxSlippageBps: 100, // 1%
  });
  console.log("[init] Swap executor ready\n");

  // -----------------------------------------------------------------------
  // 5. Create the PayAgent
  // -----------------------------------------------------------------------
  const agent = new PayAgent({ storage, llm, contract, swap });
  setGlobalAgent(agent);

  // -----------------------------------------------------------------------
  // 6. Start Telegram bot
  // -----------------------------------------------------------------------
  console.log("[init] Starting Telegram bot...");
  const bot = createBot(requireEnv("BOT_TOKEN"), agent);

  bot.catch((err) => {
    console.error("[bot] Error:", err);
  });

  await bot.start({
    onStart: (me) => {
      console.log(`\n=== PayAgent Bot @${me.username} is running ===`);
      console.log(`\nComponents:`);
      console.log(`  iNFT Contract: ${process.env.PAYAGENT_NFT_ADDRESS}`);
      console.log(`  0G Compute:    ${process.env.ZG_COMPUTE_BASE_URL || "https://router-api-testnet.integratenetwork.work/v1"}`);
      console.log(`  0G Storage:    ${process.env.ZG_INDEXER_URL || "https://indexer-storage-testnet-turbo.0g.ai"}`);
      console.log(`  Uniswap:       Sepolia (${process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org"})`);
      console.log(`  Wallet:        ${walletAddr}`);
      console.log(`\nSend /start to @${me.username} to begin.`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
