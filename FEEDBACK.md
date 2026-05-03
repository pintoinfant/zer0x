# Uniswap Developer Feedback — PayAgent

## Project Context

PayAgent is an AI financial agent that executes real Uniswap V3 swaps on Sepolia as part of an automated paycheck allocation system. We deployed four mock ERC-20 tokens, created three Uniswap V3 pools on the official Sepolia factory, and built a swap executor with a 3-tier quoting fallback.

## What Worked Well

**SwapRouter02 on Sepolia is solid.** The exactInputSingle function worked reliably once pools had liquidity. No unexpected reverts, gas estimation was accurate, and the interface is clean. We used ethers.js v6 and had no issues with the ABI.

**The official factory and position manager on Sepolia are production-quality.** We deployed pools using the canonical factory at 0x0227628f3F023bb0B980b67D528571c95c6DaC1c and added liquidity through the NonfungiblePositionManager at 0x1238536071E1c677A632429e3655c799b22cDA52. Both behaved exactly like mainnet.

**QuoterV2 works when the pool has sufficient liquidity.** For our well-funded pools the quoteExactInputSingle call returned accurate estimates that matched actual swap outputs within expected slippage.

## What Didn't Work / Bugs We Hit

**Pools cannot be reinitialized once created.** We deployed our first set of pools with incorrect sqrtPriceX96 values (a decimal adjustment bug in our computation — we were adjusting for decimals on top of sqrtPriceX96 which already encodes raw units). Since there is no way to reinitialize a pool or correct the initial price after creation, we had to redeploy entirely new pools at different fee tiers (10000 instead of 3000 for WETH/USDC, etc.) to get fresh pool addresses with correct pricing. This cost us several hours. A "pool is misconfigured, consider redeploying" diagnostic or a way to reset an empty pool would save builders time.

**sqrtPriceX96 math is a footgun.** The relationship between sqrtPriceX96, token decimals, and token0/token1 ordering is the single hardest thing to get right when working with Uniswap V3 programmatically. The formula is documented but easy to misapply. We went through three iterations: first we applied decimal adjustment on top of sqrtPriceX96 (wrong — it already encodes raw units), then we had the token0/token1 direction inverted, and finally got it right with pure BigInt math and an integer square root function. A utility function or reference implementation in the SDK for "give me sqrtPriceX96 for this human-readable price with these two tokens" would prevent a lot of pain.

**QuoterV2 fails silently on low-liquidity pools.** When our pools had minimal liquidity, QuoterV2 would revert without a useful error message. We built a 3-tier fallback: QuoterV2 first, then router staticCall (simulates the swap), then reading pool slot0() and computing the price mathematically from sqrtPriceX96. The third tier always works for any valid pool but does not account for slippage or price impact. Having a QuoterV2 that returns a structured error (insufficient liquidity, pool not found, etc.) instead of a raw revert would improve DX significantly.

**No easy way to verify pool state on Sepolia.** We had to write custom scripts to read slot0(), token0(), token1(), and liquidity from each pool to verify our deployments were correct. A simple CLI tool or dashboard for "show me the state of this pool" on testnets would be very helpful during development.

## Docs Gaps

**No end-to-end testnet guide.** The Uniswap docs cover concepts well but there is no single guide that walks through: deploy tokens, create pool, initialize with correct sqrtPriceX96, add liquidity with proper tick alignment, verify pool, execute a swap. We had to piece this together from multiple sources. A "Uniswap V3 on Sepolia from scratch" tutorial would be the single most valuable addition.

**Tick spacing and fee tier relationship is buried.** The mapping between fee tiers and tick spacing (500 -> 10, 3000 -> 60, 10000 -> 200) is critical when adding liquidity (ticks must be divisible by spacing) but is not prominently documented. We hit "tick not aligned" errors repeatedly before finding the mapping.

**Token0/token1 ordering.** The docs mention that token0 is the lower address but do not emphasize enough how this affects price direction. When token0 is USDC (lower address) and token1 is WETH (higher address), sqrtPriceX96 encodes price as token1/token0 in raw units. Getting this backwards produces prices that are off by many orders of magnitude. A prominent warning or worked example with actual addresses would help.

## DX Friction

**No TypeScript SDK for pool creation.** The Uniswap SDK packages focus on quoting and routing for existing pools. Creating pools, initializing them, and adding liquidity all require raw contract calls with manually constructed ABIs. A higher-level SDK function like createAndInitializePool(tokenA, tokenB, fee, humanReadablePrice) would save significant development time.

**Testnet token faucets are unreliable.** Getting testnet tokens on Sepolia to use with Uniswap is harder than it should be. We ended up deploying our own mock tokens with mint functions, which is probably what most hackathon builders do. Official Uniswap test tokens with public mint functions on Sepolia would lower the barrier to entry.

## What We Wish Existed

1. A sqrtPriceX96 calculator utility in the SDK — input: token addresses, decimals, human-readable price. Output: correctly computed sqrtPriceX96.
2. A pool health checker — input: pool address. Output: current price, liquidity, tick, whether the pool is functional.
3. A structured error type from QuoterV2 that distinguishes between "pool not found", "insufficient liquidity", and "price impact too high".
4. An official Sepolia deployment guide with working code examples for the full lifecycle: deploy tokens, create pool, add liquidity, swap.
5. Test tokens on Sepolia with public mint functions maintained by the Uniswap team.

## Summary

Uniswap V3 on Sepolia is production-ready infrastructure and the core swap/quote contracts work reliably. The main pain points are all around pool setup and initialization — sqrtPriceX96 math, tick alignment, and the inability to fix misconfigured pools. Better tooling and docs around these setup steps would dramatically improve the hackathon builder experience.
