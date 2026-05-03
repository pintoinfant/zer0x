# PayAgent — Deploy from Scratch

Complete step-by-step guide to deploy all components of PayAgent from a clean state.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | >= 22 |
| pnpm | >= 9 |
| Sepolia ETH | ~0.5 ETH for gas + pool liquidity. Faucet: https://cloud.google.com/application/web3/faucet/ethereum/sepolia |
| 0G Testnet A0GI | ~1 A0GI for contract deployment gas. Faucet: https://faucet.0g.ai |
| Telegram Bot Token | Create via [@BotFather](https://t.me/BotFather) |
| 0G Compute API Key | From https://router-api-testnet.integratenetwork.work |

## 1. Install Dependencies

```bash
pnpm install
```

## 2. Configure Environment

Create `.env` in the project root:

```env
# Wallet (same key used on 0G Testnet + Sepolia)
PRIVATE_KEY=<your-private-key-without-0x-prefix>

# 0G Network
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai
ZG_STORAGE_FLOW_CONTRACT=0x22E03a6A89B950F1c82ec5e74F8eCa321a105296

# 0G Compute (OpenAI-compatible)
ZG_COMPUTE_API_KEY=<your-0g-compute-api-key>
ZG_COMPUTE_BASE_URL=https://router-api-testnet.integratenetwork.work/v1
ZG_COMPUTE_MODEL=deepseek-chat

# Contract addresses (filled after step 5)
PAYAGENT_NFT_ADDRESS=
PAYAGENT_VERIFIER_ADDRESS=

# Sepolia (for Uniswap swaps)
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

# Telegram
BOT_TOKEN=<your-telegram-bot-token>

# NFT metadata
ZG_NFT_NAME=PayAgent iNFT
ZG_NFT_SYMBOL=PAYAGENT
```

## 3. Compile All Workspaces

```bash
pnpm --filter @zer0x/contracts compile
pnpm --filter @zer0x/uniswap compile
pnpm --filter @zer0x/agent build
```

All three must succeed with zero errors before proceeding.

## 4. Deploy Mock Tokens (Sepolia)

```bash
pnpm --filter @zer0x/uniswap deploy:tokens
```

Deploys 4 MockERC20 tokens to Sepolia:
- **USDC** (6 decimals)
- **USDT** (6 decimals)
- **WETH** (18 decimals)
- **DAI** (18 decimals)

Addresses are saved to `uniswap/deployments/sepolia.json`. Script is idempotent — re-running skips already-deployed tokens.

## 5. Create Uniswap V3 Pools (Sepolia)

```bash
pnpm --filter @zer0x/uniswap create:pools
```

Creates 3 pools on the Uniswap V3 Sepolia factory (`0x0227628f3F023bb0B980b67D528571c95c6DaC1c`):

| Pool | Fee Tier | Initial Price |
|------|----------|---------------|
| USDC/WETH | 10000 (1%) | 1 WETH = 2000 USDC |
| USDC/DAI | 3000 (0.3%) | 1:1 |
| USDC/USDT | 500 (0.05%) | 1:1 |

Each pool is initialized with the correct `sqrtPriceX96` (computed via BigInt math accounting for decimal differences) and seeded with initial liquidity.

Pool addresses are appended to `uniswap/deployments/sepolia.json`. Idempotent.

> **Note:** If liquidity minting fails for the USDC/WETH pool (tick spacing alignment), run `npx hardhat run scripts/addLiquidity.ts --network sepolia` from the `uniswap/` directory.

## 6. Mint Test Tokens (Sepolia)

```bash
pnpm --filter @zer0x/uniswap mint
```

Mints 100,000 of each token to the deployer wallet. Ensures sufficient balance for swap execution and pool operations.

## 7. Deploy PayAgentNFT (0G Testnet)

```bash
pnpm --filter @zer0x/contracts deploy
```

Deploys the ERC-7857 iNFT stack to 0G Testnet (chain 16602):
1. **PayAgentVerifier** — data verification contract
2. **PayAgentNFT** — implementation contract
3. **UpgradeableBeacon** — points to implementation
4. **BeaconProxy** — user-facing proxy, initialized with name/symbol/verifier

The script prints the proxy and verifier addresses. Copy them into `.env`:

```env
PAYAGENT_NFT_ADDRESS=<proxy-address-from-output>
PAYAGENT_VERIFIER_ADDRESS=<verifier-address-from-output>
```

## 8. Start the Bot

```bash
pnpm --filter @zer0x/agent build
pnpm --filter @zer0x/agent start
```

On successful startup you should see:

```
=== PayAgent Bot @<your-bot-name> is running ===

Components:
  iNFT Contract: 0x...
  0G Compute:    https://router-api-testnet.integratenetwork.work/v1
  0G Storage:    https://indexer-storage-testnet-turbo.0g.ai
  Uniswap:       Sepolia (...)
  Wallet:        0x...
```

## 9. Verify End-to-End

Open Telegram and message your bot:

| Step | Command | Expected |
|------|---------|----------|
| Onboard | `/start` | Prompts for name, risk tolerance, base currency |
| Add bills | `/bills` | Add bill (e.g. "Rent", $1500) |
| Add goals | `/goals` | Add goal (e.g. "ETH savings", 30%, ETH) |
| Check balances | `/balances` | Shows per-token balances on Sepolia |
| Submit paycheck | `/pay 5000` | LLM generates allocation plan |
| Approve/Override | Tap approve or override | Executes real Uniswap swaps on Sepolia |
| View history | `/history` | Shows past allocations (stored in 0G Storage) |
| Edit config | `/config` | Shows current config with edit button |

## Redeploying from Scratch

If you need to wipe everything and start over:

```bash
# 1. Remove deployment artifacts
rm uniswap/deployments/sepolia.json

# 2. Clear .env contract addresses
#    Set PAYAGENT_NFT_ADDRESS= and PAYAGENT_VERIFIER_ADDRESS= to empty

# 3. Re-run steps 4-8 above
```

Existing Uniswap V3 pools cannot be re-initialized once created. If pool prices are wrong, the script will create new pools at the configured fee tiers. To force new pools, change the fee tier values in `uniswap/scripts/createPools.ts` (available tiers: 100, 500, 3000, 10000).

## Architecture Reference

```
zer0x/
├── .env                          # All secrets and config
├── pnpm-workspace.yaml           # Workspaces: contracts, agent, uniswap
├── contracts/
│   ├── contracts/
│   │   ├── PayAgentNFT.sol       # ERC-7857 iNFT (BeaconProxy pattern)
│   │   ├── verifiers/            # PayAgentVerifier + BaseVerifier
│   │   ├── proxy/                # UpgradeableBeacon + BeaconProxy
│   │   └── interfaces/           # IERC7857, IERC7857Metadata, IERC7857DataVerifier
│   └── scripts/deploy.ts         # Plain Hardhat deploy (no hardhat-deploy)
├── agent/
│   └── src/
│       ├── index.ts              # Entry point, wires all components
│       ├── bot.ts                # Telegram bot (grammY), all commands + conversations
│       ├── agent.ts              # Core orchestrator (config, balances, allocation)
│       ├── llm.ts                # 0G Compute client (OpenAI-compatible)
│       ├── storage.ts            # 0G Storage with local .data/ fallback
│       ├── contract.ts           # PayAgentNFT interaction (mint, updateDataHashes)
│       ├── swap.ts               # Uniswap V3 execution + slot0 quotes + USDC fallback
│       └── types.ts              # Shared TypeScript types
└── uniswap/
    ├── contracts/MockERC20.sol   # Mintable ERC20 (configurable decimals)
    ├── scripts/
    │   ├── deployTokens.ts       # Deploy 4 mock tokens (idempotent)
    │   ├── createPools.ts        # Create 3 pools + liquidity (idempotent)
    │   ├── mintTokens.ts         # Top-up 100K per token
    │   └── addLiquidity.ts       # Manual liquidity add (fallback)
    └── deployments/sepolia.json  # Token + pool addresses (generated)
```

## Key Addresses (Sepolia Uniswap V3 Infrastructure)

| Contract | Address |
|----------|---------|
| Factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |
| QuoterV2 | `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3` |
| NonfungiblePositionManager | `0x1238536071E1c677A632429e3655c799b22cDA52` |

## Troubleshooting

**QuoterV2 returns "Unexpected error"**
Normal for custom mock token pools on Sepolia. The agent automatically falls back to pool `slot0()` math for quotes. Actual swaps still execute correctly via SwapRouter02.

**Liquidity mint fails with "execution reverted"**
Likely a tick spacing alignment issue. The 10000 fee tier requires ticks divisible by 200. Run `scripts/addLiquidity.ts` which uses the correct tick range.

**Bot shows "0.0" for estimated output**
Means all 3 quote methods failed. Check that `uniswap/deployments/sepolia.json` has pool entries matching the fee tiers in `agent/src/swap.ts` (`PAIR_FEES` constant).

**0G Compute returns 401/403**
Verify `ZG_COMPUTE_API_KEY` is valid and `ZG_COMPUTE_BASE_URL` points to the correct endpoint.

**Contract deploy fails on 0G Testnet**
Check wallet has A0GI balance. The `cancun` EVM version in hardhat.config.ts may need to be changed to `shanghai` if 0G Testnet doesn't support all cancun opcodes.
