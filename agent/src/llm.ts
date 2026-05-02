import OpenAI from "openai";
import type { AgentContext, AllocationPlan } from "./types.js";

// =========================================================================
// 0G Compute LLM client
//
// Uses the OpenAI-compatible API provided by 0G's router.
// Swap to OpenAI/Anthropic by changing baseURL + apiKey.
// =========================================================================

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class PayAgentLLM {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
    this.model = config.model;
  }

  async generateAllocation(context: AgentContext): Promise<AllocationPlan> {
    const prompt = this.buildPrompt(context);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from LLM");
    }

    return this.parseResponse(content, context.currentPayment);
  }

  private buildPrompt(ctx: AgentContext): string {
    const parts: string[] = [];

    parts.push(`## Current Payment`);
    parts.push(`Amount: $${ctx.currentPayment} USDC`);
    parts.push(``);

    parts.push(`## User Profile`);
    parts.push(`Risk tolerance: ${ctx.config.riskTolerance}`);
    parts.push(``);

    if (ctx.bills.length > 0) {
      parts.push(`## Bills (must be paid)`);
      for (const bill of ctx.bills) {
        parts.push(`- ${bill.name}: $${bill.amount} (${bill.frequency}, priority ${bill.priority})`);
      }
      parts.push(``);
    }

    if (ctx.goals.length > 0) {
      parts.push(`## Investment Goals`);
      for (const goal of ctx.goals) {
        const allocLabel = goal.allocationPercent === 100
          ? "all remaining"
          : `${goal.allocationPercent}%`;
        parts.push(
          `- ${goal.name}: ${allocLabel} of post-bills remainder → ${goal.targetToken}`
        );
      }
      parts.push(``);
    }

    if (ctx.decisionHistory.length > 0) {
      parts.push(`## Past Decisions & Overrides`);
      parts.push(`Total past decisions: ${ctx.decisionHistory.length}`);
      parts.push(``);

      // Show last 5 decisions in detail
      const recent = ctx.decisionHistory.slice(-5);
      for (const decision of recent) {
        const date = new Date(decision.timestamp).toISOString().split("T")[0];
        parts.push(`### ${date} — Payment: $${decision.paymentAmount}`);
        parts.push(`Outcome: ${decision.outcome}`);

        if (decision.outcome === "overridden" && decision.finalPlan) {
          parts.push(`Agent proposed:`);
          for (const a of decision.proposedPlan.allocations) {
            parts.push(`  - ${a.label}: $${a.amount} (${a.percent}%) → ${a.token}`);
          }
          parts.push(`User changed to:`);
          for (const a of decision.finalPlan.allocations) {
            parts.push(`  - ${a.label}: $${a.amount} (${a.percent}%) → ${a.token}`);
          }
          if (decision.overrideReason) {
            parts.push(`User's reason: "${decision.overrideReason}"`);
          }
        } else if (decision.outcome === "approved") {
          parts.push(`Agent's plan was approved:`);
          for (const a of decision.proposedPlan.allocations) {
            parts.push(`  - ${a.label}: $${a.amount} (${a.percent}%) → ${a.token}`);
          }
        }
        parts.push(``);
      }

      // Summarize override patterns
      const overrides = ctx.decisionHistory.filter((d) => d.outcome === "overridden");
      if (overrides.length > 0) {
        parts.push(`## Override Patterns (IMPORTANT — adapt to these)`);
        parts.push(`The user has overridden ${overrides.length} out of ${ctx.decisionHistory.length} decisions.`);
        parts.push(`Learn from these corrections and adjust your recommendations accordingly.`);
        parts.push(``);
      }
    }

    parts.push(`## Instructions`);
    parts.push(`Based on the above context, produce an allocation plan for the $${ctx.currentPayment} payment.`);
    parts.push(`Respond ONLY with a JSON object in the format specified in your system prompt.`);

    return parts.join("\n");
  }

  private parseResponse(content: string, totalPayment: number): AllocationPlan {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonStr);

      // Validate and normalize
      const plan: AllocationPlan = {
        totalPayment,
        allocations: Array.isArray(parsed.allocations)
          ? parsed.allocations.map((a: Record<string, unknown>) => ({
              category: a.category || "investment",
              label: a.label || "Unknown",
              token: a.token || "USDC",
              amount: Number(a.amount) || 0,
              percent: Number(a.percent) || 0,
            }))
          : [],
        reasoning: parsed.reasoning || "No reasoning provided",
        adaptationNotes: parsed.adaptationNotes || "",
      };

      // Ensure amounts sum to total
      const sum = plan.allocations.reduce((s, a) => s + a.amount, 0);
      if (Math.abs(sum - totalPayment) > 1) {
        // Scale to match
        const scale = totalPayment / sum;
        for (const a of plan.allocations) {
          a.amount = Math.round(a.amount * scale * 100) / 100;
        }
      }

      return plan;
    } catch {
      // If JSON parsing fails, create a simple plan
      console.warn("[llm] Failed to parse LLM response as JSON, creating default plan");
      return {
        totalPayment,
        allocations: [
          {
            category: "savings",
            label: "Hold as USDC",
            token: "USDC",
            amount: totalPayment,
            percent: 100,
          },
        ],
        reasoning: "Failed to parse AI response. Defaulting to hold as USDC for safety.",
        adaptationNotes: "",
      };
    }
  }
}

const SYSTEM_PROMPT = `You are PayAgent, an AI financial allocation agent stored as an ERC-7857 iNFT on the 0G network.

Your job: Given a user's incoming payment, their bills, goals, and past decisions (including their overrides of your past suggestions), produce an optimal allocation plan.

CRITICAL RULES:
1. Bills with priority 1 MUST be fully covered first. Then priority 2, then 3.
2. After bills, remaining funds go toward investment goals based on their allocation percentages.
3. If a goal has allocationPercent = 100, it means "use ALL remaining funds after bills" for that goal.
4. Any leftover after goals goes to savings (held as USDC).
5. LEARN from past overrides. If the user consistently increases ETH allocation, increase your ETH suggestion next time.
6. Never suggest putting more than 50% into a single volatile asset unless the user is aggressive AND has shown that preference.
7. Available tokens: ETH, DAI, USDT, USDC. All swaps go through Uniswap V3 on Sepolia with USDC as the base pair.

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "allocations": [
    {
      "category": "bill" | "goal" | "savings" | "investment",
      "label": "Human-readable name",
      "token": "ETH" | "DAI" | "USDT" | "USDC",
      "amount": 1234.56,
      "percent": 25.5
    }
  ],
  "reasoning": "1-3 sentence explanation of your allocation logic",
  "adaptationNotes": "What you learned from past overrides that influenced this decision (empty string if first decision)"
}`;
