import { Bot, Context, InlineKeyboard, session, type SessionFlavor } from "grammy";
import {
  type Conversation,
  type ConversationFlavor,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import type { PayAgent } from "./agent.js";
import type { AllocationPlan, Bill, Goal } from "./types.js";

// =========================================================================
// Session data — stored per-user in memory
// =========================================================================

interface SessionData {
  // Session kept for grammY middleware compatibility
}

// Pending plans stored outside session so conversations can access them
// (grammY conversations replay from scratch and can't read session during replay)
const pendingPlans = new Map<string, AllocationPlan>();

// grammY v2 conversations: OC is the "outer context", C is the "conversation context"
type BotContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context & SessionFlavor<SessionData>>;
type BotConversation = Conversation<BotContext, BotContext>;

// =========================================================================
// Helpers
// =========================================================================

/** Format a number as currency: 5000 → $5,000.00 */
function fmtUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// =========================================================================
// Create the bot
// =========================================================================

export function createBot(token: string, agent: PayAgent): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Session middleware
  bot.use(
    session({
      initial: (): SessionData => ({}),
    })
  );

  // Conversations middleware
  bot.use(conversations());

  // Register conversation handlers
  bot.use(createConversation(onboardConversation, "onboard"));
  bot.use(createConversation(addBillConversation, "addBill"));
  bot.use(createConversation(addGoalConversation, "addGoal"));
  bot.use(createConversation(overrideConversation, "override"));
  bot.use(createConversation(editConfigConversation, "editConfig"));

  // Register commands with Telegram (shows in the / menu)
  bot.api.setMyCommands([
    { command: "start", description: "🚀 Set up your PayAgent iNFT" },
    { command: "pay", description: "💰 Simulate a paycheck (e.g. /pay 5000)" },
    { command: "bills", description: "📄 View and manage your bills" },
    { command: "goals", description: "🎯 View and manage investment goals" },
    { command: "balances", description: "💰 View wallet token balances" },
    { command: "history", description: "📊 View past decisions and overrides" },
    { command: "config", description: "⚙️ View your agent configuration" },
  ]);

  // =========================================================================
  // /start — Onboard new user
  // =========================================================================

  bot.command("start", async (ctx) => {
    const userId = String(ctx.from?.id);
    const existing = await agent.getConfig(userId);

    if (existing) {
      await ctx.reply(
        `👋 Welcome back! Your PayAgent iNFT is token *#${existing.tokenId ?? "pending"}*.\n\n` +
          `Here's what I can do:\n` +
          `💰 /pay <amount> — Simulate a paycheck\n` +
          `📄 /bills — View / manage bills\n` +
          `🎯 /goals — Set investment goals\n` +
          `💰 /balances — View wallet balances\n` +
          `📊 /history — View past decisions\n` +
          `⚙️ /config — View / edit config`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ctx.conversation.enter("onboard");
  });

  // =========================================================================
  // /pay <amount> — Trigger payday
  // =========================================================================

  bot.command("pay", async (ctx) => {
    const userId = String(ctx.from?.id);
    const config = await agent.getConfig(userId);

    if (!config) {
      await ctx.reply("⚠️ You haven't set up your PayAgent yet. Run /start first.");
      return;
    }

    const text = ctx.message?.text ?? "";
    const amount = parseFloat(text.split(" ").slice(1).join(" "));

    if (!amount || amount <= 0) {
      await ctx.reply("📝 Usage: `/pay <amount>`\nExample: `/pay 5000`", { parse_mode: "Markdown" });
      return;
    }

    await ctx.reply(
      `💰 Processing your ${fmtUsd(amount)} payment...\n` +
        `🧠 Loading context from 0G Storage and consulting your AI agent...`
    );

    try {
      const plan = await agent.proposeAllocation(userId, amount);

      // Store pending plan
      pendingPlans.set(userId, plan);

      // Format the plan
      const message = formatPlan(plan);
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", "approve_plan").row()
        .text("✏️ Override", "override_plan").row()
        .text("❌ Reject", "reject_plan");

      await ctx.reply(message, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Error generating allocation: ${errMsg}`);
    }
  });

  // =========================================================================
  // Callback: Approve plan
  // =========================================================================

  bot.callbackQuery("approve_plan", async (ctx) => {
    const userId = String(ctx.from?.id);
    const plan = pendingPlans.get(userId);

    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan found." });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Executing..." });
    await ctx.editMessageText(
      "⏳ Executing approved plan...\n" +
        "🔗 Swapping on Uniswap V3 (Sepolia) and logging to 0G Storage..."
    );

    try {
      const { decision, swapResults } = await agent.executePlan(userId, plan);

      const swapped = swapResults.filter((r) => r.success && !r.error).length;
      const keptAsUsdc = swapResults.filter((r) => r.error).length;
      let resultMsg = `✅ *Plan Executed Successfully*\n\n`;

      if (swapped > 0) resultMsg += `🔄 ${swapped} swap(s) completed on-chain\n`;
      if (keptAsUsdc > 0) resultMsg += `🏦 ${keptAsUsdc} allocation(s) kept as USDC\n`;
      resultMsg += `\n`;

      for (const result of swapResults) {
        if (result.error) {
          // USDC fallback case
          resultMsg += `🏦 ${result.amountIn} USDC — _${result.error}_\n`;
        } else if (result.tokenIn === result.tokenOut) {
          // No swap needed (already USDC)
          resultMsg += `💵 ${result.amountIn} USDC — no swap needed\n`;
        } else {
          // Real swap
          resultMsg += `✅ ${result.tokenIn} → ${result.tokenOut}: ${result.amountIn}`;
          if (result.amountOut && result.amountOut !== "0") {
            resultMsg += ` (got ${result.amountOut} ${result.tokenOut})`;
          }
          if (result.txHash) {
            resultMsg += `\n   🔗 \`${result.txHash.slice(0, 18)}...\``;
          }
          resultMsg += `\n`;
        }
      }

      if (decision.storageRootHash) {
        resultMsg += `\n📦 0G Storage: \`${decision.storageRootHash.slice(0, 16)}...\``;
      }

      pendingPlans.delete(userId);
      await ctx.editMessageText(resultMsg, { parse_mode: "Markdown" });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.editMessageText(`❌ Execution failed: ${errMsg}`);
    }
  });

  // =========================================================================
  // Callback: Override plan
  // =========================================================================

  bot.callbackQuery("override_plan", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("override");
  });

  // =========================================================================
  // Callback: Reject plan
  // =========================================================================

  bot.callbackQuery("reject_plan", async (ctx) => {
    const userId = String(ctx.from?.id);
    const plan = pendingPlans.get(userId);

    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan." });
      return;
    }

    await agent.handleRejection(userId, plan);
    pendingPlans.delete(userId);
    await ctx.answerCallbackQuery({ text: "Plan rejected." });
    await ctx.editMessageText(
      "❌ Plan rejected.\n\n" +
        "Your feedback has been stored — I'll adapt to your preferences next time! 🧠"
    );
  });

  // =========================================================================
  // /bills — List and manage bills
  // =========================================================================

  bot.command("bills", async (ctx) => {
    const userId = String(ctx.from?.id);
    const bills = await agent.getBills(userId);

    if (bills.length === 0) {
      const keyboard = new InlineKeyboard().text("➕ Add a bill", "add_bill");
      await ctx.reply(
        "📄 No bills configured yet. Tap below to add one!",
        { reply_markup: keyboard }
      );
      return;
    }

    let msg = "📄 *Your Bills:*\n\n";
    let totalMonthly = 0;
    for (const bill of bills) {
      const priorityLabel = bill.priority === 1 ? "Must-pay" : bill.priority === 2 ? "Important" : "Nice-to-have";
      msg += `  • *${bill.name}*: ${fmtUsd(bill.amount)} — ${bill.frequency}, ${priorityLabel}\n`;
      totalMonthly += bill.amount;
    }
    msg += `\n💵 Total: ${fmtUsd(totalMonthly)}`;

    const keyboard = new InlineKeyboard()
      .text("➕ Add bill", "add_bill").row()
      .text("🗑 Clear all", "clear_bills");

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  bot.callbackQuery("add_bill", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("addBill");
  });

  bot.callbackQuery("clear_bills", async (ctx) => {
    const userId = String(ctx.from?.id);
    await agent.setBills(userId, []);
    await ctx.answerCallbackQuery({ text: "Bills cleared." });
    await ctx.editMessageText("🗑 All bills cleared.");
  });

  // =========================================================================
  // /goals — List and manage goals
  // =========================================================================

  bot.command("goals", async (ctx) => {
    const userId = String(ctx.from?.id);
    const goals = await agent.getGoals(userId);

    if (goals.length === 0) {
      const keyboard = new InlineKeyboard().text("➕ Add a goal", "add_goal");
      await ctx.reply(
        "🎯 No investment goals configured yet. Let's set one up!",
        { reply_markup: keyboard }
      );
      return;
    }

    let msg = "🎯 *Your Goals:*\n\n";
    for (const goal of goals) {
      const allocLabel = goal.allocationPercent === 100
        ? "full remaining"
        : `${goal.allocationPercent}% of remaining`;
      msg += `  • *${goal.name}*: ${allocLabel} → ${goal.targetToken}\n`;
    }

    const keyboard = new InlineKeyboard()
      .text("➕ Add goal", "add_goal").row()
      .text("🗑 Clear all", "clear_goals");

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  bot.callbackQuery("add_goal", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("addGoal");
  });

  bot.callbackQuery("clear_goals", async (ctx) => {
    const userId = String(ctx.from?.id);
    await agent.setGoals(userId, []);
    await ctx.answerCallbackQuery({ text: "Goals cleared." });
    await ctx.editMessageText("🗑 All goals cleared.");
  });

  // =========================================================================
  // /balances — View wallet token balances
  // =========================================================================

  bot.command("balances", async (ctx) => {
    const userId = String(ctx.from?.id);
    const config = await agent.getConfig(userId);

    if (!config) {
      await ctx.reply("⚠️ You haven't set up your PayAgent yet. Run /start first.");
      return;
    }

    await ctx.reply("⏳ Fetching balances from Sepolia...");

    try {
      const walletAddress = await agent.getWalletAddress();
      const balances = await agent.getBalances();

      let msg = `💰 *Wallet Balances*\n\n`;
      msg += `💳 \`${walletAddress}\`\n`;
      msg += `🌐 Network: Sepolia\n\n`;

      for (const [symbol, balance] of Object.entries(balances)) {
        const numBal = parseFloat(balance);
        if (symbol === "ETH (gas)") {
          msg += `  ⛽ *${symbol}*: ${numBal.toFixed(6)}\n`;
        } else {
          // Format based on likely decimals
          const formatted = numBal < 0.01 && numBal > 0
            ? numBal.toFixed(8)
            : numBal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
          msg += `  🪙 *${symbol}*: ${formatted}\n`;
        }
      }

      await ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Failed to fetch balances: ${errMsg}`);
    }
  });

  // =========================================================================
  // /history — Show past decisions
  // =========================================================================

  bot.command("history", async (ctx) => {
    const userId = String(ctx.from?.id);
    const history = await agent.getDecisionHistory(userId);

    if (history.length === 0) {
      await ctx.reply("📊 No past decisions yet. Use /pay to simulate your first paycheck!");
      return;
    }

    let msg = `📊 *Decision History* (${history.length} total)\n\n`;

    const recent = history.slice(-5);
    for (const decision of recent) {
      const date = new Date(decision.timestamp).toLocaleDateString();
      const outcomeEmoji = decision.outcome === "approved" ? "✅"
        : decision.outcome === "overridden" ? "✏️"
        : "❌";
      msg += `*${date}* — ${fmtUsd(decision.paymentAmount)} — ${outcomeEmoji} ${decision.outcome}\n`;

      const plan = decision.finalPlan ?? decision.proposedPlan;
      for (const a of plan.allocations) {
        msg += `  ${a.label}: ${fmtUsd(a.amount)} (${a.percent.toFixed(1)}%) → ${a.token}\n`;
      }

      if (decision.overrideReason) {
        msg += `  💬 _"${decision.overrideReason}"_\n`;
      }
      msg += `\n`;
    }

    if (history.length > 5) {
      msg += `_... and ${history.length - 5} earlier decisions_`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  // =========================================================================
  // /config — Show current config + edit button
  // =========================================================================

  bot.command("config", async (ctx) => {
    const userId = String(ctx.from?.id);
    const config = await agent.getConfig(userId);

    if (!config) {
      await ctx.reply("⚠️ No config found. Run /start first.");
      return;
    }

    const msg =
      `⚙️ *PayAgent Config*\n\n` +
      `👤 User: \`${config.userId}\`\n` +
      `🪪 iNFT Token: #${config.tokenId ?? "not minted"}\n` +
      `📈 Risk: ${config.riskTolerance}\n` +
      `💱 Base currency: ${config.baseCurrency}\n` +
      `💳 Wallet: \`${config.walletAddress}\`\n` +
      `📅 Created: ${new Date(config.createdAt).toLocaleDateString()}`;

    const keyboard = new InlineKeyboard().text("✏️ Edit config", "edit_config");

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  });

  bot.callbackQuery("edit_config", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("editConfig");
  });

  return bot;
}

// =========================================================================
// Conversation: Onboarding
// =========================================================================

async function onboardConversation(conversation: BotConversation, ctx: BotContext) {
  const userId = String(ctx.from?.id);

  await ctx.reply(
    "🚀 *Welcome to PayAgent!*\n\n" +
      "I'm an AI agent stored as an ERC-7857 iNFT on the 0G network.\n" +
      "I'll help manage your paycheck allocations — bills, savings, and investments.\n\n" +
      "Let's get started! What's your risk tolerance?",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🛡 Conservative", "risk_conservative").row()
        .text("⚖️ Moderate", "risk_moderate").row()
        .text("🔥 Aggressive", "risk_aggressive"),
    }
  );

  const riskCb = await conversation.waitForCallbackQuery([
    "risk_conservative",
    "risk_moderate",
    "risk_aggressive",
  ]);

  const riskMap: Record<string, "conservative" | "moderate" | "aggressive"> = {
    risk_conservative: "conservative",
    risk_moderate: "moderate",
    risk_aggressive: "aggressive",
  };
  const riskTolerance = riskMap[String(riskCb.match)];
  await riskCb.answerCallbackQuery({ text: `Risk: ${riskTolerance}` });

  await ctx.reply(`⏳ Setting risk tolerance to *${riskTolerance}*.\nMinting your PayAgent iNFT on 0G Testnet...`, { parse_mode: "Markdown" });

  try {
    const { config, tokenId } = await globalAgent!.onboardUser(userId, riskTolerance);

    await ctx.reply(
      `🎉 *Your PayAgent iNFT has been minted!*\n\n` +
        `🪪 Token ID: *#${tokenId}*\n` +
        `📈 Risk: ${riskTolerance}\n` +
        `💳 Wallet: \`${config.walletAddress}\`\n\n` +
        `*Next steps:*\n` +
        `📄 /bills — Add your recurring bills\n` +
        `🎯 /goals — Set investment goals\n` +
        `💰 /pay <amount> — Simulate a paycheck`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Failed to mint iNFT: ${errMsg}\nPlease try /start again.`);
  }
}

// =========================================================================
// Conversation: Add Bill
// =========================================================================

async function addBillConversation(conversation: BotConversation, ctx: BotContext) {
  const userId = String(ctx.from?.id);

  await ctx.reply("📄 What's the name of this bill? (e.g., _Rent_, _Netflix_)", { parse_mode: "Markdown" });
  const nameResp = await conversation.wait();
  const name = nameResp.message?.text ?? "Unknown Bill";

  await ctx.reply(`💵 How much is *${name}*? (number only, in USD)`, { parse_mode: "Markdown" });
  const amountResp = await conversation.wait();
  const amount = parseFloat(amountResp.message?.text ?? "0");

  if (!amount || amount <= 0) {
    await ctx.reply("⚠️ Invalid amount. Bill not added.");
    return;
  }

  await ctx.reply("🗓 How often?", {
    reply_markup: new InlineKeyboard()
      .text("📅 Monthly", "freq_monthly").row()
      .text("📅 Biweekly", "freq_biweekly").row()
      .text("📅 Weekly", "freq_weekly"),
  });

  const freqCb = await conversation.waitForCallbackQuery([
    "freq_monthly",
    "freq_biweekly",
    "freq_weekly",
  ]);
  const freqMap: Record<string, Bill["frequency"]> = {
    freq_monthly: "monthly",
    freq_biweekly: "biweekly",
    freq_weekly: "weekly",
  };
  const frequency = freqMap[String(freqCb.match)];
  await freqCb.answerCallbackQuery();

  await ctx.reply("⚡ Priority?", {
    reply_markup: new InlineKeyboard()
      .text("🔴 1 — Must pay", "pri_1").row()
      .text("🟡 2 — Important", "pri_2").row()
      .text("🟢 3 — Nice to have", "pri_3"),
  });

  const priCb = await conversation.waitForCallbackQuery(["pri_1", "pri_2", "pri_3"]);
  const priority = parseInt(String(priCb.match).split("_")[1]) as 1 | 2 | 3;
  await priCb.answerCallbackQuery();

  const bill: Bill = { name, amount, frequency, priority };

  const bills = await globalAgent!.getBills(userId);
  bills.push(bill);
  await globalAgent!.setBills(userId, bills);

  await ctx.reply(
    `✅ *Bill added!*\n\n` +
      `📄 *${name}*: ${fmtUsd(amount)} (${frequency}, priority ${priority})\n` +
      `📋 Total bills: ${bills.length}\n\n` +
      `Add more with /bills or set goals with /goals`,
    { parse_mode: "Markdown" }
  );
}

// =========================================================================
// Conversation: Add Goal
// =========================================================================

async function addGoalConversation(conversation: BotConversation, ctx: BotContext) {
  const userId = String(ctx.from?.id);

  await ctx.reply("🎯 What's the name of this goal? (e.g., _ETH Stack_, _Stablecoin Reserve_)", { parse_mode: "Markdown" });
  const nameResp = await conversation.wait();
  const name = nameResp.message?.text ?? "Unknown Goal";

  await ctx.reply("🪙 Which token do you want to accumulate?", {
    reply_markup: new InlineKeyboard()
      .text("ETH", "token_ETH").row()
      .text("DAI", "token_DAI").row()
      .text("USDT", "token_USDT"),
  });

  const tokenCb = await conversation.waitForCallbackQuery(["token_ETH", "token_DAI", "token_USDT"]);
  const targetToken = String(tokenCb.match).split("_")[1];
  await tokenCb.answerCallbackQuery();

  await ctx.reply(
    `📐 What % of remaining funds (after bills) should go toward this goal?\n\n` +
      `Type a number (e.g. \`60\`) or type \`full\` to use the entire remaining balance.`,
    { parse_mode: "Markdown" }
  );
  const pctResp = await conversation.wait();
  const pctText = (pctResp.message?.text ?? "0").trim().toLowerCase();
  const allocationPercent = pctText === "full" ? 100 : parseFloat(pctText);

  const goal: Goal = {
    name,
    targetToken,
    allocationPercent: Math.min(100, Math.max(0, allocationPercent || 50)),
  };

  const goals = await globalAgent!.getGoals(userId);
  goals.push(goal);
  await globalAgent!.setGoals(userId, goals);

  const allocLabel = goal.allocationPercent === 100
    ? "full remaining balance"
    : `${goal.allocationPercent}% of remaining`;

  await ctx.reply(
    `✅ *Goal added!*\n\n` +
      `🎯 *${name}*: ${allocLabel} → ${targetToken}\n` +
      `📋 Total goals: ${goals.length}\n\n` +
      `Try /pay <amount> to see how I allocate your next paycheck! 🧠`,
    { parse_mode: "Markdown" }
  );
}

// =========================================================================
// Conversation: Override allocation
// =========================================================================

async function overrideConversation(conversation: BotConversation, ctx: BotContext) {
  const userId = String(ctx.from?.id);
  const plan = pendingPlans.get(userId);

  if (!plan) {
    await ctx.reply("⚠️ No pending plan to override.");
    return;
  }

  await ctx.reply(
    "✏️ *Override Mode*\n\n" +
      "Send your changes as a comma-separated list:\n" +
      "`label:amount, label:amount, ...`\n\n" +
      "Example: `ETH Stack:2500, Savings:500`\n\n" +
      "Or type _cancel_ to go back.",
    { parse_mode: "Markdown" }
  );

  const resp = await conversation.wait();
  const text = resp.message?.text ?? "";

  if (text.toLowerCase() === "cancel") {
    await ctx.reply("↩️ Override cancelled. Use the buttons above to approve or reject.");
    return;
  }

  // Parse overrides
  const overrides = new Map<string, number>();
  const parts = text.split(",").map((p) => p.trim());
  for (const part of parts) {
    const [label, amountStr] = part.split(":").map((s) => s.trim());
    if (label && amountStr) {
      overrides.set(label.toLowerCase(), parseFloat(amountStr));
    }
  }

  if (overrides.size === 0) {
    await ctx.reply("⚠️ Could not parse overrides. Try again with format: `label:amount, label:amount`", { parse_mode: "Markdown" });
    return;
  }

  // Apply overrides to plan
  const newPlan: AllocationPlan = {
    ...plan,
    allocations: plan.allocations.map((a: AllocationPlan["allocations"][number]) => {
      const override = overrides.get(a.label.toLowerCase());
      if (override !== undefined) {
        return { ...a, amount: override, percent: (override / plan.totalPayment) * 100 };
      }
      return a;
    }),
  };

  // Recalculate percentages
  const total = newPlan.allocations.reduce((s, a) => s + a.amount, 0);
  if (Math.abs(total - plan.totalPayment) > 1) {
    await ctx.reply(
      `⚠️ Your overrides total ${fmtUsd(total)} but payment is ${fmtUsd(plan.totalPayment)}.\n` +
        `The difference will be held as USDC savings.`
    );
    if (total < plan.totalPayment) {
      newPlan.allocations.push({
        category: "savings",
        label: "Remaining Savings",
        token: "USDC",
        amount: plan.totalPayment - total,
        percent: ((plan.totalPayment - total) / plan.totalPayment) * 100,
      });
    }
  }

  await ctx.reply("💬 Why are you making this change? (helps me learn for next time)");
  const reasonResp = await conversation.wait();
  const reason = reasonResp.message?.text ?? "No reason given";

  await ctx.reply("⏳ Executing overridden plan...");

  try {
    const { decision, swapResults } = await globalAgent!.handleOverride(
      userId,
      plan,
      newPlan,
      reason
    );

    const successCount = swapResults.filter((r) => r.success).length;
    await ctx.reply(
      `✅ *Override Executed*\n\n` +
        `📊 Swaps: ${successCount}/${swapResults.length} completed\n` +
        `🧠 Your correction has been stored — I'll adapt to your preferences next time!\n\n` +
        `💬 Override reason: _"${reason}"_`,
      { parse_mode: "Markdown" }
    );

    pendingPlans.delete(userId);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Override execution failed: ${errMsg}`);
  }
}

// =========================================================================
// Conversation: Edit Config
// =========================================================================

async function editConfigConversation(conversation: BotConversation, ctx: BotContext) {
  const userId = String(ctx.from?.id);
  const config = await globalAgent!.getConfig(userId);

  if (!config) {
    await ctx.reply("⚠️ No config found. Run /start first.");
    return;
  }

  const updates: Record<string, string> = {};

  // --- Risk tolerance ---
  await ctx.reply(
    `📈 *Risk tolerance* (current: ${config.riskTolerance})\n\nSelect a new value or skip:`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🛡 Conservative", "cfg_risk_conservative").row()
        .text("⚖️ Moderate", "cfg_risk_moderate").row()
        .text("🔥 Aggressive", "cfg_risk_aggressive").row()
        .text("⏭ Skip", "cfg_risk_skip"),
    }
  );

  const riskCb = await conversation.waitForCallbackQuery([
    "cfg_risk_conservative",
    "cfg_risk_moderate",
    "cfg_risk_aggressive",
    "cfg_risk_skip",
  ]);
  await riskCb.answerCallbackQuery();

  const riskMatch = String(riskCb.match);
  if (riskMatch !== "cfg_risk_skip") {
    const riskMap: Record<string, "conservative" | "moderate" | "aggressive"> = {
      cfg_risk_conservative: "conservative",
      cfg_risk_moderate: "moderate",
      cfg_risk_aggressive: "aggressive",
    };
    updates.riskTolerance = riskMap[riskMatch];
  }

  // --- Base currency ---
  await ctx.reply(
    `💱 *Base currency* (current: ${config.baseCurrency})\n\nType a new currency symbol or \`skip\`:`,
    { parse_mode: "Markdown" }
  );

  const currResp = await conversation.wait();
  const currText = (currResp.message?.text ?? "").trim();
  if (currText.toLowerCase() !== "skip" && currText.length > 0) {
    updates.baseCurrency = currText.toUpperCase();
  }

  // --- Wallet address ---
  await ctx.reply(
    `💳 *Wallet address* (current: \`${config.walletAddress}\`)\n\nPaste a new address or type \`skip\`:`,
    { parse_mode: "Markdown" }
  );

  const walletResp = await conversation.wait();
  const walletText = (walletResp.message?.text ?? "").trim();
  if (walletText.toLowerCase() !== "skip" && walletText.length > 0) {
    // Basic validation
    if (/^0x[a-fA-F0-9]{40}$/.test(walletText)) {
      updates.walletAddress = walletText;
    } else {
      await ctx.reply("⚠️ Invalid address format — skipping wallet update.");
    }
  }

  // --- Apply updates ---
  if (Object.keys(updates).length === 0) {
    await ctx.reply("ℹ️ No changes made. Config stays the same.");
    return;
  }

  try {
    const updated = await globalAgent!.updateConfig(userId, updates);

    let msg = `✅ *Config updated!*\n\n`;
    for (const [key, value] of Object.entries(updates)) {
      const label = key === "riskTolerance" ? "📈 Risk"
        : key === "baseCurrency" ? "💱 Currency"
        : "💳 Wallet";
      msg += `${label}: ${value}\n`;
    }
    msg += `\n_Changes saved to 0G Storage._`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Failed to update config: ${errMsg}`);
  }
}

// =========================================================================
// Helpers
// =========================================================================

function formatPlan(plan: AllocationPlan): string {
  let msg = `🧠 *PayAgent Allocation Plan*\n`;
  msg += `💰 Payment: ${fmtUsd(plan.totalPayment)}\n\n`;

  for (const a of plan.allocations) {
    const icon =
      a.category === "bill"
        ? "📄"
        : a.category === "goal"
        ? "🎯"
        : a.category === "savings"
        ? "🏦"
        : "📈";
    msg += `${icon} *${a.label}*: ${fmtUsd(a.amount)} (${a.percent.toFixed(1)}%) → ${a.token}\n`;
  }

  msg += `\n💡 *Reasoning:* ${plan.reasoning}`;

  if (plan.adaptationNotes) {
    msg += `\n\n🧠 *Adaptation:* ${plan.adaptationNotes}`;
  }

  return msg;
}

// Global agent reference for conversations (grammY conversations can't close over external state easily)
let globalAgent: PayAgent | null = null;

export function setGlobalAgent(agent: PayAgent): void {
  globalAgent = agent;
}
