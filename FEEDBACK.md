# FEEDBACK.md — 0G Developer Experience

Honest feedback on building with 0G infrastructure during a hackathon.

## What Worked Well

### 0G Chain (EVM Compatibility)
- Standard Hardhat/Foundry deployment works out of the box. No code changes needed from Ethereum.
- Chain ID, RPC, and explorer are well-documented.
- Faucet at faucet.0g.ai is straightforward.

### 0G Compute (Router API)
- The OpenAI-compatible endpoint is a great design choice. Drop-in replacement with standard `openai` npm package by changing `baseURL`.
- Setup via pc.testnet.0g.ai (connect wallet, deposit tokens, create API key) is clear.
- Model availability (deepseek-chat, etc.) is sufficient for hackathon use.

### ERC-7857 Reference Implementation
- The `0g-agent-nft` repo on the `eip-7857-draft` branch provides a solid reference.
- Interface design is clean: `IERC7857`, `IERC7857Metadata`, `IERC7857DataVerifier` separation makes sense.
- The `dataHashesOf` + `dataDescriptionsOf` pattern is a natural fit for off-chain storage references.

## Pain Points

### 0G Storage SDK
- The npm package `@0gfoundation/0g-storage-ts-sdk` is functional but the API surface is large and not always well-documented.
- KV store operations (Batcher + KvClient) require knowing a KV node URL, which isn't prominently listed in docs. We fell back to file-based uploads instead.
- Must call `merkleTree()` before upload — this is easy to forget and the error messages don't clearly indicate the fix.
- Browser support is limited (`indexer.download` uses `fs.appendFileSync` internally).

### ERC-7857 Tooling
- No OpenZeppelin implementation or npm package exists yet (expected for a Draft EIP).
- The verifier pattern is well-designed but the TEE/ZKP integration is not turnkey. The reference implementation has TODO comments for actual proof verification.
- For hackathons, a "simplified verifier" template with clear documentation would lower the barrier significantly.

### Documentation Gaps
- 0G Compute rate limits (30 req/min, 5 concurrent) aren't mentioned in the quickstart guides.
- The distinction between Router API vs Direct SDK vs Broker SDK could be clearer.
- Storage SDK version pinning: the version on npm (1.2.8) doesn't match what some docs reference.

## Suggestions

1. **Starter template**: A full "AI Agent NFT" template repo with iNFT + 0G Storage + 0G Compute wired together would dramatically reduce hackathon setup time.
2. **KV store docs**: Add a dedicated KV store quickstart with node URLs and complete read/write examples.
3. **Verifier templates**: Provide a "hackathon verifier" contract that passes through proofs for development, alongside the full TEE/ZKP verifier.
4. **Storage SDK error messages**: Improve error messages for common mistakes (missing merkleTree call, wrong indexer URL, etc.).

## Architecture Choices

### Why Telegram over Web UI
- Faster to build for a hackathon (no frontend framework, deployment, or hosting)
- Natural conversation flow for "agent proposes, user approves" pattern
- Inline keyboards map perfectly to approve/override/reject actions

### Why Cross-Chain (0G Testnet + Sepolia)
- 0G Testnet doesn't have DEX liquidity for swap execution
- iNFT contract + storage + compute all live on 0G (demonstrates full stack)
- Swap execution on Sepolia shows real DeFi integration
- Same private key on both chains keeps it simple

### Why File Upload over KV Store
- File upload via Indexer is more reliable and better documented
- KV node URLs for testnet weren't readily available
- File-based approach is simpler: upload JSON blob, get root hash, store hash on-chain
- Trade-off: no individual key lookups, must download entire file. Acceptable for hackathon data sizes.
