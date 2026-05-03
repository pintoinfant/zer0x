// =========================================================================
// User Configuration — stored in 0G Storage KV
// =========================================================================

export interface UserConfig {
  /** Telegram user ID */
  userId: string;
  /** On-chain iNFT token ID (set after minting) */
  tokenId?: number;
  /** Risk tolerance: conservative, moderate, aggressive */
  riskTolerance: "conservative" | "moderate" | "aggressive";
  /** Default currency for payments */
  baseCurrency: string;
  /** Wallet address on Sepolia for swaps */
  walletAddress: string;
  /** Created timestamp */
  createdAt: number;
}

export interface Bill {
  name: string;
  /** Amount in base currency (e.g., USDC) */
  amount: number;
  /** When it's due: "monthly" or "weekly" */
  frequency: "monthly" | "weekly";
  /** Priority: 1 = must pay, 2 = important, 3 = nice to have */
  priority: 1 | 2 | 3;
}

export interface Goal {
  name: string;
  /** Target token to accumulate (e.g., "ETH", "DAI") */
  targetToken: string;
  /** Percentage of remaining funds (after bills) to allocate */
  allocationPercent: number;
}

// =========================================================================
// Agent Allocation — output from LLM reasoning
// =========================================================================

export interface AllocationItem {
  category: "bill" | "goal" | "savings" | "investment";
  label: string;
  token: string;
  amount: number;
  /** Percentage of total payment */
  percent: number;
}

export interface AllocationPlan {
  totalPayment: number;
  allocations: AllocationItem[];
  reasoning: string;
  /** What the agent learned from past overrides */
  adaptationNotes: string;
}

// =========================================================================
// Decisions — stored in 0G Storage file log
// =========================================================================

export interface Decision {
  timestamp: number;
  paymentAmount: number;
  proposedPlan: AllocationPlan;
  /** "approved" if user accepted, "overridden" if user changed it, "rejected" if user declined */
  outcome: "approved" | "overridden" | "rejected";
  /** The final plan (same as proposed if approved, different if overridden) */
  finalPlan?: AllocationPlan;
  /** User's notes on why they overrode */
  overrideReason?: string;
  /** Swap transaction hashes on Sepolia */
  swapTxHashes?: string[];
  /** 0G Storage root hash for this decision */
  storageRootHash?: string;
}

// =========================================================================
// Swap types — for Uniswap integration
// =========================================================================

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  /** Price impact percentage */
  priceImpact: number;
}

export interface SwapResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  txHash: string;
  success: boolean;
  error?: string;
}

// =========================================================================
// Agent context — fed into LLM prompt
// =========================================================================

export interface AgentContext {
  config: UserConfig;
  bills: Bill[];
  goals: Goal[];
  decisionHistory: Decision[];
  currentPayment: number;
}
