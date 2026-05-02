import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { SwapQuote, SwapResult, AllocationPlan } from "./types.js";

// =========================================================================
// Uniswap V3 integration on Sepolia — REAL EXECUTION MODE
//
// Executes swaps via SwapRouter02. On any failure (unknown token, no pool,
// quote failure, revert), gracefully falls back to keeping funds as USDC.
//
// Reads token addresses from uniswap/deployments/sepolia.json if available,
// otherwise falls back to well-known Sepolia token addresses.
// =========================================================================

// Uniswap V3 contract addresses on Sepolia
const UNISWAP_ADDRESSES = {
  swapRouter: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E", // SwapRouter02
  quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",   // QuoterV2
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",     // UniswapV3Factory
};

// Fallback token addresses (well-known Sepolia tokens)
const FALLBACK_TOKENS: Record<string, { address: string; decimals: number }> = {
  WETH: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", decimals: 18 },
  USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
};

// Fee tier mapping per pair
const PAIR_FEES: Record<string, number> = {
  "USDC/WETH": 10000,  // 1% — re-created pool with correct price
  "USDC/ETH": 10000,
  "USDC/DAI": 3000,    // 0.3% — re-created pool with correct price
  "USDC/USDT": 500,    // 0.05% — original pool (correct)
};

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

interface SwapConfig {
  rpcUrl: string;
  privateKey: string;
  /** Maximum slippage in basis points (e.g., 50 = 0.5%) */
  maxSlippageBps?: number;
}

// Token address cache loaded from deployments
let tokenRegistry: Record<string, { address: string; decimals: number }> | null = null;

/**
 * Try to load mock token addresses from uniswap/deployments/sepolia.json.
 * Falls back to well-known Sepolia addresses if not found.
 */
function loadTokenRegistry(): Record<string, { address: string; decimals: number }> {
  if (tokenRegistry) return tokenRegistry;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const deploymentsPath = path.resolve(__dirname, "../../uniswap/deployments/sepolia.json");

  try {
    if (fs.existsSync(deploymentsPath)) {
      const data = JSON.parse(fs.readFileSync(deploymentsPath, "utf-8"));
      if (data.tokens && Object.keys(data.tokens).length > 0) {
        tokenRegistry = { ...data.tokens };
        // Map ETH -> WETH if WETH exists
        if (tokenRegistry!.WETH && !tokenRegistry!.ETH) {
          tokenRegistry!.ETH = tokenRegistry!.WETH;
        }
        console.log(
          `[swap] Loaded ${Object.keys(tokenRegistry!).length} token addresses from deployments`
        );
        return tokenRegistry!;
      }
    }
  } catch (err) {
    console.warn(`[swap] Could not load deployments: ${err}`);
  }

  console.log("[swap] Using fallback Sepolia token addresses");
  tokenRegistry = { ...FALLBACK_TOKENS };
  return tokenRegistry;
}

export class SwapExecutor {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private quoter: ethers.Contract;
  private router: ethers.Contract;
  private maxSlippageBps: number;

  constructor(config: SwapConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, this.provider);
    this.quoter = new ethers.Contract(UNISWAP_ADDRESSES.quoterV2, QUOTER_ABI, this.provider);
    this.router = new ethers.Contract(UNISWAP_ADDRESSES.swapRouter, ROUTER_ABI, this.signer);
    this.maxSlippageBps = config.maxSlippageBps ?? 100; // 1% default
  }

  // =========================================================================
  // Quote (read-only)
  // 1. QuoterV2
  // 2. Router staticCall (simulates swap)
  // 3. Pool slot0() sqrtPriceX96 math (always works for valid pools)
  // =========================================================================

  async getQuote(
    tokenInSymbol: string,
    tokenOutSymbol: string,
    amountIn: string
  ): Promise<SwapQuote> {
    const tokenInInfo = this.resolveToken(tokenInSymbol);
    const tokenOutInfo = this.resolveToken(tokenOutSymbol);
    const fee = this.resolveFee(tokenInSymbol, tokenOutSymbol);
    const amountInWei = ethers.parseUnits(amountIn, tokenInInfo.decimals);
    const recipient = await this.signer.getAddress();

    // --- Attempt 1: QuoterV2 ---
    try {
      const result = await this.quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenInInfo.address,
        tokenOut: tokenOutInfo.address,
        amountIn: amountInWei,
        fee,
        sqrtPriceLimitX96: 0,
      });

      const amountOut = ethers.formatUnits(result.amountOut, tokenOutInfo.decimals);
      console.log(`[swap] Quote via QuoterV2: ${amountIn} ${tokenInSymbol} → ${amountOut} ${tokenOutSymbol}`);

      return {
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        amountIn,
        amountOut,
        priceImpact: 0,
      };
    } catch {
      // QuoterV2 failed — try router staticCall as fallback
    }

    // --- Attempt 2: Router staticCall (simulates the swap without sending tx) ---
    try {
      const amountOut = await this.router.exactInputSingle.staticCall({
        tokenIn: tokenInInfo.address,
        tokenOut: tokenOutInfo.address,
        fee,
        recipient,
        amountIn: amountInWei,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      });

      const formatted = ethers.formatUnits(amountOut, tokenOutInfo.decimals);
      console.log(`[swap] Quote via router staticCall: ${amountIn} ${tokenInSymbol} → ${formatted} ${tokenOutSymbol}`);

      return {
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        amountIn,
        amountOut: formatted,
        priceImpact: 0,
      };
    } catch {
      // Router staticCall also failed — try pool slot0() math
    }

    // --- Attempt 3: Read pool slot0() and calculate price mathematically ---
    try {
      const factory = new ethers.Contract(UNISWAP_ADDRESSES.factory, FACTORY_ABI, this.provider);
      const poolAddr = await factory.getPool(tokenInInfo.address, tokenOutInfo.address, fee);

      if (poolAddr === ethers.ZeroAddress) {
        throw new Error("Pool does not exist");
      }

      const pool = new ethers.Contract(poolAddr, POOL_ABI, this.provider);
      const [slot0Result, token0Addr] = await Promise.all([
        pool.slot0(),
        pool.token0(),
      ]);

      const sqrtPriceX96 = slot0Result.sqrtPriceX96;
      const tokenInIsToken0 = tokenInInfo.address.toLowerCase() === token0Addr.toLowerCase();

      // sqrtPriceX96 = sqrt(token1_raw / token0_raw) * 2^96
      // price_raw = sqrtPriceX96^2 / 2^192
      //
      // sqrtPriceX96 already encodes the price in raw units (including decimal
      // differences), so no additional decimal adjustment is needed.
      //
      // If tokenIn is token0: amountOut_raw = amountIn_raw * sqrtPriceX96^2 / 2^192
      // If tokenIn is token1: amountOut_raw = amountIn_raw * 2^192 / sqrtPriceX96^2

      const Q192 = BigInt(1) << BigInt(192);
      const sqrtPrice = BigInt(sqrtPriceX96);
      const sqrtPriceSq = sqrtPrice * sqrtPrice;

      let amountOutWei: bigint;
      if (tokenInIsToken0) {
        amountOutWei = (amountInWei * sqrtPriceSq) / Q192;
      } else {
        amountOutWei = (amountInWei * Q192) / sqrtPriceSq;
      }

      // Apply fee deduction (e.g., 3000 = 0.3%)
      amountOutWei = amountOutWei * BigInt(1000000 - fee) / BigInt(1000000);

      const formatted = ethers.formatUnits(amountOutWei, tokenOutInfo.decimals);
      console.log(`[swap] Quote via pool slot0() math: ${amountIn} ${tokenInSymbol} → ${formatted} ${tokenOutSymbol}`);

      return {
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        amountIn,
        amountOut: formatted,
        priceImpact: 0,
      };
    } catch (error) {
      console.warn(`[swap] Quote failed for ${tokenInSymbol}→${tokenOutSymbol} (all 3 methods):`, error instanceof Error ? error.message.slice(0, 150) : error);
      return {
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        amountIn,
        amountOut: "0",
        priceImpact: -1,
      };
    }
  }

  // =========================================================================
  // Execute swap — real on-chain transaction
  // On ANY failure, gracefully keeps funds as USDC (never throws)
  // =========================================================================

  async executeSwap(
    tokenInSymbol: string,
    tokenOutSymbol: string,
    amountIn: string
  ): Promise<SwapResult> {
    try {
      const tokenInInfo = this.resolveToken(tokenInSymbol);
      const tokenOutInfo = this.resolveToken(tokenOutSymbol);
      const fee = this.resolveFee(tokenInSymbol, tokenOutSymbol);
      const amountInWei = ethers.parseUnits(amountIn, tokenInInfo.decimals);
      const recipient = await this.signer.getAddress();

      // --- Approve token if needed ---
      const tokenInContract = new ethers.Contract(tokenInInfo.address, ERC20_ABI, this.signer);
      const currentAllowance = await tokenInContract.allowance(recipient, UNISWAP_ADDRESSES.swapRouter);

      if (currentAllowance < amountInWei) {
        console.log(`[swap] 🔓 Approving ${tokenInSymbol} for router...`);
        const approveTx = await tokenInContract.approve(UNISWAP_ADDRESSES.swapRouter, ethers.MaxUint256);
        await approveTx.wait();
        console.log(`[swap]    Approved`);
      }

      // --- Get quote for minimum output ---
      const quote = await this.getQuote(tokenInSymbol, tokenOutSymbol, amountIn);

      let amountOutMinimum = BigInt(0);
      if (quote.priceImpact >= 0 && quote.amountOut !== "0") {
        const amountOutWei = ethers.parseUnits(quote.amountOut, tokenOutInfo.decimals);
        amountOutMinimum = (amountOutWei * BigInt(10000 - this.maxSlippageBps)) / BigInt(10000);
      }

      // --- Execute the swap ---
      console.log(`[swap] ──────────────────────────────────────`);
      console.log(`[swap] 🔄 Swapping: ${amountIn} ${tokenInSymbol} → ${tokenOutSymbol}`);
      console.log(`[swap] 📊 Est. output: ${quote.amountOut} ${tokenOutSymbol}`);
      console.log(`[swap] 🏷  Fee tier: ${fee / 10000}%`);
      console.log(`[swap] 📍 Router: ${UNISWAP_ADDRESSES.swapRouter}`);

      const tx = await this.router.exactInputSingle({
        tokenIn: tokenInInfo.address,
        tokenOut: tokenOutInfo.address,
        fee,
        recipient,
        amountIn: amountInWei,
        amountOutMinimum,
        sqrtPriceLimitX96: 0,
      });

      const receipt = await tx.wait();

      // --- Parse actual output from Transfer event logs ---
      let actualAmountOut = quote.amountOut; // fallback to quote estimate
      const transferTopic = ethers.id("Transfer(address,address,uint256)");
      const tokenOutAddr = tokenOutInfo.address.toLowerCase();
      const recipientPadded = ethers.zeroPadValue(recipient.toLowerCase(), 32);

      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() === tokenOutAddr &&
          log.topics[0] === transferTopic &&
          log.topics[2]?.toLowerCase() === recipientPadded
        ) {
          const value = BigInt(log.data);
          actualAmountOut = ethers.formatUnits(value, tokenOutInfo.decimals);
          break;
        }
      }

      console.log(`[swap] ✅ Swap complete — tx: ${receipt.hash}`);
      console.log(`[swap]    Received: ${actualAmountOut} ${tokenOutSymbol}`);
      console.log(`[swap] ──────────────────────────────────────`);

      return {
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        amountIn,
        amountOut: actualAmountOut,
        txHash: receipt.hash,
        success: true,
      };
    } catch (error) {
      // ── Graceful fallback: keep as USDC ──
      const errMsg = error instanceof Error ? error.message : String(error);
      const shortErr = errMsg.slice(0, 120);

      console.warn(`[swap] ⚠️ Swap failed (${tokenInSymbol}→${tokenOutSymbol}): ${shortErr}`);
      console.warn(`[swap] 🏦 Keeping ${amountIn} as USDC`);

      return {
        tokenIn: "USDC",
        tokenOut: "USDC",
        amountIn,
        amountOut: amountIn,
        txHash: "",
        success: true,
        error: `Swap unavailable, kept as USDC`,
      };
    }
  }

  // =========================================================================
  // Execute all allocations from a plan
  // =========================================================================

  async executeAllocation(plan: AllocationPlan): Promise<SwapResult[]> {
    const results: SwapResult[] = [];

    console.log(`\n[swap] ═══════════════════════════════════════`);
    console.log(`[swap] 📋 Processing allocation: ${fmtUsd(plan.totalPayment)}`);
    console.log(`[swap] 📊 ${plan.allocations.length} line items`);
    console.log(`[swap] ═══════════════════════════════════════\n`);

    for (const allocation of plan.allocations) {
      // No swap needed if staying in USDC
      if (allocation.token === "USDC" || allocation.amount <= 0) {
        console.log(`[swap] ⏭ ${allocation.label}: ${fmtUsd(allocation.amount)} → USDC (no swap needed)`);
        results.push({
          tokenIn: "USDC",
          tokenOut: "USDC",
          amountIn: String(allocation.amount),
          amountOut: String(allocation.amount),
          txHash: "",
          success: true,
        });
        continue;
      }

      // Map common names to swap-ready symbols
      let tokenOut = allocation.token;
      if (tokenOut === "BTC") tokenOut = "WBTC";
      if (tokenOut === "ETH") tokenOut = "WETH";

      // Check if token is in registry before attempting swap
      const registry = loadTokenRegistry();
      const lookupSymbol = tokenOut === "ETH" ? "WETH" : tokenOut.toUpperCase();
      if (!registry[lookupSymbol] && !registry[tokenOut.toUpperCase()]) {
        console.warn(`[swap] ⚠️ Unknown token "${tokenOut}" — keeping as USDC`);
        results.push({
          tokenIn: "USDC",
          tokenOut: "USDC",
          amountIn: String(allocation.amount),
          amountOut: String(allocation.amount),
          txHash: "",
          success: true,
          error: `Unknown token ${allocation.token}, kept as USDC`,
        });
        continue;
      }

      const result = await this.executeSwap("USDC", tokenOut, String(allocation.amount));
      results.push(result);
    }

    const swapped = results.filter((r) => r.success && !r.error).length;
    const kept = results.filter((r) => r.error).length;
    console.log(`\n[swap] ═══════════════════════════════════════`);
    console.log(`[swap] ✅ Done: ${swapped} swapped, ${kept} kept as USDC`);
    console.log(`[swap] ═══════════════════════════════════════\n`);

    return results;
  }

  // =========================================================================
  // Quote all allocations (read-only)
  // =========================================================================

  async quoteAllocation(plan: AllocationPlan): Promise<SwapQuote[]> {
    const quotes: SwapQuote[] = [];

    for (const allocation of plan.allocations) {
      if (allocation.token === "USDC" || allocation.amount <= 0) {
        quotes.push({
          tokenIn: "USDC",
          tokenOut: "USDC",
          amountIn: String(allocation.amount),
          amountOut: String(allocation.amount),
          priceImpact: 0,
        });
        continue;
      }

      let tokenOut = allocation.token;
      if (tokenOut === "BTC") tokenOut = "WBTC";
      if (tokenOut === "ETH") tokenOut = "WETH";

      const quote = await this.getQuote("USDC", tokenOut, String(allocation.amount));
      quotes.push(quote);
    }

    return quotes;
  }

  // =========================================================================
  // Balances
  // =========================================================================

  /** Get wallet address */
  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  /** Get balance of a single token */
  async getBalance(tokenSymbol: string): Promise<string> {
    if (tokenSymbol === "ETH") {
      const balance = await this.provider.getBalance(await this.signer.getAddress());
      return ethers.formatEther(balance);
    }
    const info = this.resolveToken(tokenSymbol);
    const token = new ethers.Contract(info.address, ERC20_ABI, this.provider);
    const balance = await token.balanceOf(await this.signer.getAddress());
    return ethers.formatUnits(balance, info.decimals);
  }

  /** Get balances for all known tokens + native ETH */
  async getAllBalances(): Promise<Record<string, string>> {
    const registry = loadTokenRegistry();
    const address = await this.signer.getAddress();
    const balances: Record<string, string> = {};

    // Native ETH (for gas)
    const ethBal = await this.provider.getBalance(address);
    balances["ETH (gas)"] = ethers.formatEther(ethBal);

    // All registered ERC20 tokens
    for (const [symbol, info] of Object.entries(registry)) {
      if (symbol === "ETH") continue; // skip the WETH alias
      try {
        const token = new ethers.Contract(info.address, ERC20_ABI, this.provider);
        const bal = await token.balanceOf(address);
        balances[symbol] = ethers.formatUnits(bal, info.decimals);
      } catch {
        balances[symbol] = "error";
      }
    }

    return balances;
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private resolveToken(symbol: string): { address: string; decimals: number } {
    const registry = loadTokenRegistry();
    const upper = symbol.toUpperCase();
    const lookupSymbol = upper === "ETH" ? "WETH" : upper;
    const info = registry[lookupSymbol] || registry[upper];

    if (!info) {
      throw new Error(
        `Unknown token: ${symbol}. Available: ${Object.keys(registry).join(", ")}`
      );
    }
    return info;
  }

  private resolveFee(tokenInSymbol: string, tokenOutSymbol: string): number {
    const key = `${tokenInSymbol.toUpperCase()}/${tokenOutSymbol.toUpperCase()}`;
    const reverseKey = `${tokenOutSymbol.toUpperCase()}/${tokenInSymbol.toUpperCase()}`;
    return PAIR_FEES[key] || PAIR_FEES[reverseKey] || 3000;
  }
}

/** Format a number as currency */
function fmtUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
