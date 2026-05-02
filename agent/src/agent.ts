import type {
  UserConfig,
  Bill,
  Goal,
  Decision,
  AllocationPlan,
  AgentContext,
  SwapResult,
} from "./types.js";
import { PayAgentStorage } from "./storage.js";
import { PayAgentLLM } from "./llm.js";
import { PayAgentContract, DATA_DESCRIPTIONS } from "./contract.js";
import { SwapExecutor } from "./swap.js";

// =========================================================================
// PayAgent — the core agent that orchestrates the payday loop
//
// Flow:
//   1. Load user context from 0G Storage (config, bills, goals, history)
//   2. Call 0G Compute LLM for allocation reasoning
//   3. Return proposed plan (for bot to show user)
//   4. On approval: execute swaps, log decision, update iNFT
//   5. On override: store correction, adapt next time
// =========================================================================

interface AgentDependencies {
  storage: PayAgentStorage;
  llm: PayAgentLLM;
  contract: PayAgentContract;
  swap: SwapExecutor;
}

export class PayAgent {
  private storage: PayAgentStorage;
  private llm: PayAgentLLM;
  private contract: PayAgentContract;
  private swap: SwapExecutor;

  constructor(deps: AgentDependencies) {
    this.storage = deps.storage;
    this.llm = deps.llm;
    this.contract = deps.contract;
    this.swap = deps.swap;
  }

  // =========================================================================
  // Onboarding: create user config + mint iNFT
  // =========================================================================

  async onboardUser(
    userId: string,
    riskTolerance: UserConfig["riskTolerance"]
  ): Promise<{ config: UserConfig; tokenId: number }> {
    const walletAddress = await this.contract.getAddress();

    const config: UserConfig = {
      userId,
      riskTolerance,
      baseCurrency: "USDC",
      walletAddress,
      createdAt: Date.now(),
    };

    // Save initial data to 0G Storage
    const hashes = await this.storage.uploadAllUserData(userId, config, [], [], []);

    // Mint iNFT with data hashes
    const tokenId = await this.contract.mint(walletAddress, hashes);
    config.tokenId = tokenId;

    // Re-save config with tokenId
    const configHash = await this.storage.saveConfig(userId, config);

    // Update config hash on-chain
    await this.contract.updateDataHashes(tokenId, {
      ...hashes,
      configHash,
    });

    console.log(`[agent] Onboarded user ${userId}, tokenId: ${tokenId}`);
    return { config, tokenId };
  }

  // =========================================================================
  // Load full user context from 0G Storage
  // =========================================================================

  async loadContext(userId: string): Promise<AgentContext | null> {
    const config = await this.storage.loadConfig(userId);
    if (!config) return null;

    const bills = await this.storage.loadBills(userId);
    const goals = await this.storage.loadGoals(userId);
    const decisionHistory = await this.storage.loadDecisionHistory(userId);

    return {
      config,
      bills,
      goals,
      decisionHistory,
      currentPayment: 0, // Set by caller
    };
  }

  // =========================================================================
  // Generate allocation plan (payday step 1)
  // =========================================================================

  async proposeAllocation(userId: string, paymentAmount: number): Promise<AllocationPlan> {
    const context = await this.loadContext(userId);
    if (!context) {
      throw new Error(`No user context found for ${userId}. Run /start first.`);
    }

    context.currentPayment = paymentAmount;

    console.log(
      `[agent] Generating allocation for $${paymentAmount}...`,
      `(${context.bills.length} bills, ${context.goals.length} goals, ${context.decisionHistory.length} past decisions)`
    );

    const plan = await this.llm.generateAllocation(context);
    console.log(`[agent] Plan generated: ${plan.allocations.length} items, reasoning: ${plan.reasoning.slice(0, 100)}...`);

    return plan;
  }

  // =========================================================================
  // Execute approved plan (payday step 2)
  // =========================================================================

  async executePlan(
    userId: string,
    plan: AllocationPlan
  ): Promise<{ decision: Decision; swapResults: SwapResult[] }> {
    // Execute swaps on Sepolia
    console.log(`[agent] Executing ${plan.allocations.length} allocations on Sepolia...`);
    const swapResults = await this.swap.executeAllocation(plan);

    const successCount = swapResults.filter((r) => r.success).length;
    console.log(`[agent] Swaps complete: ${successCount}/${swapResults.length} succeeded`);

    // Build decision record
    const decision: Decision = {
      timestamp: Date.now(),
      paymentAmount: plan.totalPayment,
      proposedPlan: plan,
      outcome: "approved",
      swapTxHashes: swapResults.filter((r) => r.txHash).map((r) => r.txHash),
    };

    // Save to 0G Storage
    const rootHash = await this.storage.saveDecision(userId, decision);
    decision.storageRootHash = rootHash;

    // Update iNFT data hashes
    const config = await this.storage.loadConfig(userId);
    if (config?.tokenId != null) {
      try {
        const bills = await this.storage.loadBills(userId);
        const goals = await this.storage.loadGoals(userId);
        const hashes = await this.storage.uploadAllUserData(
          userId,
          config,
          bills,
          goals,
          await this.storage.loadDecisionHistory(userId)
        );
        await this.contract.updateDataHashes(config.tokenId, hashes);
        console.log(`[agent] iNFT data hashes updated for tokenId ${config.tokenId}`);
      } catch (error) {
        console.warn(`[agent] Failed to update iNFT hashes:`, error);
      }
    }

    return { decision, swapResults };
  }

  // =========================================================================
  // Handle user override (payday step 2 — alternative path)
  // =========================================================================

  async handleOverride(
    userId: string,
    originalPlan: AllocationPlan,
    overriddenPlan: AllocationPlan,
    reason: string
  ): Promise<{ decision: Decision; swapResults: SwapResult[] }> {
    // Execute the overridden plan
    console.log(`[agent] Executing overridden plan...`);
    const swapResults = await this.swap.executeAllocation(overriddenPlan);

    const decision: Decision = {
      timestamp: Date.now(),
      paymentAmount: originalPlan.totalPayment,
      proposedPlan: originalPlan,
      outcome: "overridden",
      finalPlan: overriddenPlan,
      overrideReason: reason,
      swapTxHashes: swapResults.filter((r) => r.txHash).map((r) => r.txHash),
    };

    // Save to 0G Storage
    const rootHash = await this.storage.saveDecision(userId, decision);
    decision.storageRootHash = rootHash;

    // Update iNFT data hashes
    const config = await this.storage.loadConfig(userId);
    if (config?.tokenId != null) {
      try {
        const bills = await this.storage.loadBills(userId);
        const goals = await this.storage.loadGoals(userId);
        const hashes = await this.storage.uploadAllUserData(
          userId,
          config,
          bills,
          goals,
          await this.storage.loadDecisionHistory(userId)
        );
        await this.contract.updateDataHashes(config.tokenId, hashes);
      } catch (error) {
        console.warn(`[agent] Failed to update iNFT hashes:`, error);
      }
    }

    return { decision, swapResults };
  }

  // =========================================================================
  // Handle rejection
  // =========================================================================

  async handleRejection(userId: string, plan: AllocationPlan): Promise<void> {
    const decision: Decision = {
      timestamp: Date.now(),
      paymentAmount: plan.totalPayment,
      proposedPlan: plan,
      outcome: "rejected",
    };

    await this.storage.saveDecision(userId, decision);
    console.log(`[agent] Plan rejected, decision logged.`);
  }

  // =========================================================================
  // User config management
  // =========================================================================

  async setBills(userId: string, bills: Bill[]): Promise<void> {
    await this.storage.saveBills(userId, bills);
    console.log(`[agent] Saved ${bills.length} bills for user ${userId}`);
  }

  async setGoals(userId: string, goals: Goal[]): Promise<void> {
    await this.storage.saveGoals(userId, goals);
    console.log(`[agent] Saved ${goals.length} goals for user ${userId}`);
  }

  async getBills(userId: string): Promise<Bill[]> {
    return this.storage.loadBills(userId);
  }

  async getGoals(userId: string): Promise<Goal[]> {
    return this.storage.loadGoals(userId);
  }

  async getDecisionHistory(userId: string): Promise<Decision[]> {
    return this.storage.loadDecisionHistory(userId);
  }

  async getConfig(userId: string): Promise<UserConfig | null> {
    return this.storage.loadConfig(userId);
  }

  async updateConfig(
    userId: string,
    updates: Partial<Pick<UserConfig, "riskTolerance" | "baseCurrency" | "walletAddress">>
  ): Promise<UserConfig> {
    const config = await this.storage.loadConfig(userId);
    if (!config) throw new Error("User not found");
    Object.assign(config, updates);
    await this.storage.saveConfig(userId, config);
    console.log(`[agent] Config updated for user ${userId}:`, Object.keys(updates).join(", "));
    return config;
  }

  // =========================================================================
  // Wallet balances (delegates to swap executor on Sepolia)
  // =========================================================================

  async getBalances(): Promise<Record<string, string>> {
    return this.swap.getAllBalances();
  }

  async getWalletAddress(): Promise<string> {
    return this.swap.getAddress();
  }
}
