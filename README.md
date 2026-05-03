# PayAgent — An ERC-7857 iNFT for Autonomous Paycheck Allocation

An AI agent minted as an intelligent NFT (iNFT) on the 0G network. It manages paycheck allocation — bills, savings, and crypto investments — learning from your corrections over time.

## Architecture

```
Telegram Bot (grammY)
      |
      v
Agent Core (TypeScript)
  |-- 0G Compute -----> LLM inference (OpenAI-compatible)
  |-- 0G Storage -----> KV (config/bills/goals) + file log (decisions)
  |-- Uniswap V3 -----> Swaps on Sepolia
  '-- PayAgentNFT -----> ERC-7857 iNFT on 0G Testnet
       (dataHashes --> 0G Storage root hashes)
```

### The Core Loop

1. **Payment arrives** — user sends `/pay <amount>` in Telegram
2. **Agent loads context** from 0G Storage: config, bills, goals, past decisions + overrides
3. **Agent reasons** via 0G Compute: generates allocation plan with explanation
4. **User reviews** in Telegram: approve, override, or reject
5. **On approve** — swaps execute on Uniswap (Sepolia), decision logged to 0G Storage, iNFT data hashes updated on-chain
6. **On override** — user correction stored in 0G Storage; next time the agent adapts its suggestions based on the override history

### How "Learning" Works

No ML training. The agent's memory is its decision log stored in 0G Storage. When generating an allocation, the full override history is injected into the LLM prompt. The agent sees patterns like "user consistently increases ETH when I suggest 30%" and adapts accordingly. Payday 1 vs Payday 3 produces visibly different recommendations.

## Tech Stack

| Layer | Technology | Network |
|-------|-----------|---------|
| Smart Contract | Solidity (ERC-7857 iNFT) | 0G Testnet (chain 16602) |
| Storage | 0G Storage SDK (file upload/download) | 0G Network |
| AI Inference | 0G Compute (OpenAI-compatible API) | 0G Network |
| Swap Execution | Uniswap V3 (Router + Quoter) | Ethereum Sepolia |
| Bot Interface | grammY (Telegram) | — |
| Runtime | Node.js >= 22, TypeScript, tsx | — |

## Project Structure

```
zer0x/
├── contracts/                       # Hardhat project
│   ├── contracts/
│   │   ├── PayAgentNFT.sol         # ERC-7857 iNFT implementation
│   │   ├── interfaces/             # IERC7857, IERC7857Metadata, IERC7857DataVerifier
│   │   ├── verifiers/              # PayAgentVerifier (simplified TEE verifier)
│   │   └── proxy/                  # BeaconProxy + UpgradeableBeacon
│   └── scripts/deploy/deploy.ts    # Deploy to 0G Testnet
├── agent/                           # Bot + agent logic
│   └── src/
│       ├── index.ts                # Entry point — wires everything, starts bot
│       ├── bot.ts                  # Telegram bot (commands, keyboards, conversations)
│       ├── agent.ts                # Core loop orchestrator
│       ├── llm.ts                  # 0G Compute LLM client
│       ├── storage.ts              # 0G Storage client (with local fallback)
│       ├── swap.ts                 # Uniswap V3 on Sepolia
│       ├── contract.ts             # PayAgentNFT interaction
│       └── types.ts                # Shared types
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
# Fill in all values in .env
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

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Onboard — set risk tolerance, mint iNFT |
| `/pay <amount>` | Simulate a paycheck, get allocation proposal |
| `/bills` | View/add/clear recurring bills |
| `/goals` | View/add/clear investment goals |
| `/history` | View past decisions and overrides |
| `/config` | View current agent configuration |

## ERC-7857 Implementation

The `PayAgentNFT` contract implements the full `IERC7857` and `IERC7857Metadata` interfaces from the [official 0G reference implementation](https://github.com/0gfoundation/0g-agent-nft/tree/eip-7857-draft):

- `mint()` — Create a new iNFT with initial data hashes
- `update()` — Update data hashes (called after each payday cycle)
- `transfer()` / `clone()` — Transfer/clone with verified data handoff
- `authorizeUsage()` — Grant usage rights without ownership transfer
- `dataHashesOf()` / `dataDescriptionsOf()` — Read the iNFT's intelligent data

Each token stores four data hashes pointing to 0G Storage: `config`, `bills`, `goals`, `decisions`.

The verifier (`PayAgentVerifier`) follows the same simplified pattern as the 0G reference — hash-based validation for hackathon, with the TEE/ZKP interface ready for production.

## Cross-Chain Design

- **0G Testnet**: iNFT contract + 0G Storage + 0G Compute (all 0G stack)
- **Ethereum Sepolia**: Uniswap V3 swap execution (real DEX with testnet liquidity)

Same private key operates on both chains.

## Fallbacks

| Component | Fallback |
|-----------|----------|
| 0G Compute | Swap `ZG_COMPUTE_BASE_URL` to `https://api.openai.com/v1` |
| 0G Storage | Local `.data/` directory (automatic, transparent) |
| Uniswap | Quotes work, execution may fail on thin testnet liquidity |
| ERC-7857 Verifier | Simplified (hash-based, no TEE/ZKP) — interface-compatible |

## License

MIT
