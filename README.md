# PayAgent

AI agent iNFT that allocates your paycheck, executes real swaps, and learns from your overrides.

## What is PayAgent?

PayAgent is an autonomous AI financial agent that lives on-chain as an ERC-7857 iNFT on the 0G Network. Users interact through a Telegram bot to manage their monthly paycheck allocation. Set your bills and investment goals once. Each month, tell the bot how much you earned. The agent allocates your paycheck (bills first, then goals), executes real Uniswap V3 swaps on Ethereum Sepolia, and learns from your corrections over time through pure in-context learning -- no fine-tuning, no retraining.

## Architecture

```
Telegram Bot (grammY)
      |
      v
Agent Core (TypeScript)
  |-- 0G Compute -----> LLM inference (DeepSeek via OpenAI-compatible API)
  |-- 0G Storage -----> Decentralized persistence (config, bills, goals, decisions)
  |-- Uniswap V3 -----> Real token swaps on Sepolia
  '-- PayAgentNFT -----> ERC-7857 iNFT on 0G Testnet
       (dataHashes --> 0G Storage root hashes)
```

### The Core Loop

1. User sends `/pay 5000` in Telegram
2. Agent loads context from 0G Storage: config, bills, goals, past decisions + overrides
3. Agent reasons via 0G Compute LLM: generates allocation plan with explanation
4. User reviews in Telegram: approve, override, or reject
5. On approve: swaps execute on Uniswap V3 (Sepolia), decision logged to 0G Storage, iNFT hashes updated on-chain
6. On override: user correction stored with reasoning; next month the agent adapts based on override history

### How Learning Works

No ML training or fine-tuning. The agent's memory is its decision log stored in 0G Storage. When generating an allocation, the full override history (including the user's exact reasons) is injected into the LLM prompt. The agent sees patterns like "user reduced ETH from 40% to 15% because of market volatility" and adjusts accordingly. Month 1 vs Month 3 produces visibly different recommendations.

## Partner Technologies

### 0G Network

PayAgent uses three 0G products as core infrastructure:

- **0G Compute** provides LLM inference via the OpenAI-compatible API (DeepSeek model) to reason about paycheck allocations. The agent sends user context (bills, goals, decision history) and receives a structured allocation plan with reasoning.
  - Code: [agent/src/llm.ts](https://github.com/pintoinfant/zer0x/blob/master/agent/src/llm.ts)

- **0G Storage** persists all user data (config, bills, goals, decision history) as decentralized JSON blobs. Every decision record -- including overrides with user reasoning -- is stored here and retrieved for the next allocation cycle.
  - Code: [agent/src/storage.ts](https://github.com/pintoinfant/zer0x/blob/master/agent/src/storage.ts)

- **ERC-7857 iNFT** deployed on 0G Testnet (chain 16602) anchors content hashes on-chain, giving users verifiable ownership of their AI agent and its data. The contract stores four hash slots (config, bills, goals, decisions) pointing to 0G Storage roots, updated after every decision.
  - Contract: [contracts/contracts/PayAgentNFT.sol](https://github.com/pintoinfant/zer0x/blob/master/contracts/contracts/PayAgentNFT.sol)
  - Interaction: [agent/src/contract.ts](https://github.com/pintoinfant/zer0x/blob/master/agent/src/contract.ts)

### Uniswap Foundation

PayAgent executes real Uniswap V3 swaps on Sepolia as part of its automated paycheck allocation:

- **4 mock ERC-20 tokens** (USDC, WETH, DAI, USDT) deployed on Sepolia
- **3 Uniswap V3 pools** created on the official Sepolia factory (`0x0227628f3F023bb0B980b67D528571c95c6DaC1c`) with correct sqrtPriceX96 pricing and liquidity
- **SwapRouter02** used for exactInputSingle swaps with slippage protection
- **3-tier quoting fallback**: QuoterV2 -> router staticCall -> raw pool slot0() sqrtPriceX96 math
- Graceful USDC fallback on any swap failure -- never crashes
  - Swap executor: [agent/src/swap.ts](https://github.com/pintoinfant/zer0x/blob/master/agent/src/swap.ts)
  - Pool creation: [uniswap/scripts/createPools.ts](https://github.com/pintoinfant/zer0x/blob/master/uniswap/scripts/createPools.ts)
  - Liquidity: [uniswap/scripts/addLiquidity.ts](https://github.com/pintoinfant/zer0x/blob/master/uniswap/scripts/addLiquidity.ts)
  - Developer feedback: [FEEDBACK.md](https://github.com/pintoinfant/zer0x/blob/master/FEEDBACK.md)

## Deployed Contracts

| Contract | Address | Network |
|----------|---------|---------|
| PayAgentNFT (proxy) | `0xD73A6B20182082CeCeAc4E6c8aD16d8a89a9ee48` | 0G Testnet (16602) |
| PayAgentVerifier | `0x77288aD3D8fb17dFA87431c72CcCF395feA7Fd33` | 0G Testnet (16602) |
| USDC (mock) | `0x7D040aA7...` | Sepolia |
| WETH (mock) | `0xfa7089dB...` | Sepolia |
| DAI (mock) | `0x411E5A8C...` | Sepolia |
| USDT (mock) | `0xE476DF41...` | Sepolia |
| USDC/WETH Pool | `0xFB332Dd3...` (fee 10000) | Sepolia |
| USDC/DAI Pool | `0x73dB67FB...` (fee 3000) | Sepolia |
| USDC/USDT Pool | `0x9De00d3c...` (fee 500) | Sepolia |

## Tech Stack

| Layer | Technology | Network |
|-------|-----------|---------|
| Smart Contract | Solidity (ERC-7857 iNFT) | 0G Testnet (chain 16602) |
| Storage | 0G Storage SDK | 0G Network |
| AI Inference | 0G Compute (OpenAI-compatible) | 0G Network |
| Swap Execution | Uniswap V3 (SwapRouter02 + QuoterV2) | Ethereum Sepolia |
| Bot Interface | grammY + grammyjs/conversations | Telegram |
| Runtime | Node.js >= 22, TypeScript, pnpm monorepo | -- |
| Contracts | Hardhat, ethers.js v6 | -- |

## Project Structure

```
zer0x/
├── contracts/                       # Hardhat project
│   ├── contracts/
│   │   ├── PayAgentNFT.sol         # ERC-7857 iNFT implementation
│   │   ├── interfaces/             # IERC7857, IERC7857Metadata, IERC7857DataVerifier
│   │   ├── verifiers/              # PayAgentVerifier
│   │   └── proxy/                  # BeaconProxy + UpgradeableBeacon
│   └── scripts/deploy.ts           # Deploy to 0G Testnet
├── agent/                           # Bot + agent logic
│   ├── src/
│   │   ├── index.ts                # Entry point
│   │   ├── bot.ts                  # Telegram bot (commands, conversations)
│   │   ├── agent.ts                # Core loop orchestrator
│   │   ├── llm.ts                  # 0G Compute LLM client
│   │   ├── storage.ts              # 0G Storage client (with local fallback)
│   │   ├── swap.ts                 # Uniswap V3 swap executor
│   │   ├── contract.ts             # PayAgentNFT interaction
│   │   └── types.ts                # Shared types
│   └── scripts/
│       └── demo.ts                 # 3-month demo simulation
├── uniswap/                         # Pool deployment scripts
│   ├── scripts/
│   │   ├── createPools.ts          # Create Uniswap V3 pools
│   │   └── addLiquidity.ts         # Add liquidity to pools
│   └── deployments/sepolia.json    # Token + pool addresses
├── FEEDBACK.md                      # Uniswap developer feedback (required)
├── DEPLOY_GUIDE.md                  # Full from-scratch deployment guide
├── .env.example                     # Required environment variables
└── pnpm-workspace.yaml
```

## Setup

### Prerequisites

- Node.js >= 22
- pnpm
- A Telegram bot token (from @BotFather)
- 0G Testnet tokens (from https://faucet.0g.ai)
- 0G Compute API key (from https://pc.testnet.0g.ai)
- Sepolia ETH (for Uniswap swaps)

### Install

```bash
pnpm install
```

### Configure

```bash
cp .env.example .env
# Fill in all values
```

### Deploy Contracts

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network 0g-testnet
```

Copy the deployed proxy address into `.env` as `PAYAGENT_NFT_ADDRESS`.

### Run the Bot

```bash
cd agent
pnpm dev
```

Then open Telegram and send `/start` to your bot.

### Run the Demo

```bash
cd agent
pnpm demo
```

Simulates 3 consecutive paychecks: approve, override, and agent adaptation.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Onboard -- set risk tolerance, mint iNFT |
| `/pay <amount>` | Simulate a paycheck, get allocation proposal |
| `/bills` | View/add/clear recurring bills |
| `/goals` | View/add/clear investment goals |
| `/balances` | View wallet token balances on Sepolia |
| `/history` | View past decisions and overrides |
| `/config` | View current agent configuration |

## ERC-7857 Implementation

The PayAgentNFT contract implements the full IERC7857 and IERC7857Metadata interfaces:

- `mint()` -- Create a new iNFT with initial data hashes
- `update()` -- Update data hashes (called after each payday cycle)
- `transfer()` / `clone()` -- Transfer/clone with verified data handoff
- `authorizeUsage()` -- Grant usage rights without ownership transfer
- `dataHashesOf()` / `dataDescriptionsOf()` -- Read the iNFT's intelligent data

Each token stores four data hashes pointing to 0G Storage: config, bills, goals, decisions.

## Cross-Chain Design

- **0G Testnet (chain 16602)**: iNFT contract + 0G Storage + 0G Compute
- **Ethereum Sepolia**: Uniswap V3 swap execution (real DEX with testnet liquidity)

Same private key operates on both chains.

## License

MIT
