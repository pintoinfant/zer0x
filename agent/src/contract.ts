import { ethers } from "ethers";

// =========================================================================
// PayAgentNFT contract interaction
//
// Handles minting iNFTs and updating data hashes on 0G Testnet.
// Uses the ERC-7857 interface from our deployed PayAgentNFT contract.
// =========================================================================

// Minimal ABI — only the functions we call from the agent
const PAYAGENT_NFT_ABI = [
  // Mint
  "function mint(bytes[] calldata proofs, string[] calldata dataDescriptions, address to) external payable returns (uint256)",
  // Update data hashes
  "function update(uint256 tokenId, bytes[] calldata proofs) external",
  // Authorize a user
  "function authorizeUsage(uint256 tokenId, address user) external",
  // View functions
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function dataHashesOf(uint256 tokenId) external view returns (bytes32[])",
  "function dataDescriptionsOf(uint256 tokenId) external view returns (string[])",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  // Events
  "event Minted(uint256 indexed tokenId, address indexed creator, address indexed owner, bytes32[] dataHashes, string[] dataDescriptions)",
  "event Updated(uint256 indexed tokenId, bytes32[] oldDataHashes, bytes32[] newDataHashes)",
];

interface ContractConfig {
  nftAddress: string;
  rpcUrl: string;
  privateKey: string;
}

/** The four data slots stored in each PayAgent iNFT */
export const DATA_DESCRIPTIONS = ["config", "bills", "goals", "decisions"] as const;

export class PayAgentContract {
  private contract: ethers.Contract;
  private signer: ethers.Wallet;

  constructor(config: ContractConfig) {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, provider);
    this.contract = new ethers.Contract(config.nftAddress, PAYAGENT_NFT_ABI, this.signer);
  }

  /**
   * Mint a new PayAgent iNFT with initial data hashes.
   * @param to - Address to mint to (defaults to signer)
   * @param initialHashes - Initial root hashes for [config, bills, goals, decisions]
   * @returns The newly minted token ID
   */
  async mint(
    to?: string,
    initialHashes?: {
      configHash: string;
      billsHash: string;
      goalsHash: string;
      decisionsHash: string;
    }
  ): Promise<number> {
    const recipient = to || (await this.signer.getAddress());

    // Build proofs: each proof is the 32-byte hash (simplified verifier accepts raw hashes)
    const hashes = initialHashes
      ? [
          initialHashes.configHash,
          initialHashes.billsHash,
          initialHashes.goalsHash,
          initialHashes.decisionsHash,
        ]
      : [
          ethers.ZeroHash,
          ethers.ZeroHash,
          ethers.ZeroHash,
          ethers.ZeroHash,
        ];

    const proofs = hashes.map((h) => ethers.getBytes(h));
    const descriptions = [...DATA_DESCRIPTIONS];

    console.log(`[contract] Minting PayAgent iNFT for ${recipient}...`);
    const tx = await this.contract.mint(proofs, descriptions, recipient);
    const receipt = await tx.wait();

    // Parse Minted event to get tokenId
    const mintedEvent = receipt.logs.find((log: ethers.Log) => {
      try {
        const parsed = this.contract.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        return parsed?.name === "Minted";
      } catch {
        return false;
      }
    });

    if (mintedEvent) {
      const parsed = this.contract.interface.parseLog({
        topics: mintedEvent.topics as string[],
        data: mintedEvent.data,
      });
      const tokenId = Number(parsed!.args[0]);
      console.log(`[contract] Minted iNFT tokenId: ${tokenId}, tx: ${receipt.hash}`);
      return tokenId;
    }

    // Fallback: assume sequential IDs starting from 0
    console.warn("[contract] Could not parse Minted event, assuming tokenId from tx");
    return 0;
  }

  /**
   * Update the data hashes on an existing iNFT.
   * Called after each payday cycle to point the iNFT at new 0G Storage roots.
   */
  async updateDataHashes(
    tokenId: number,
    hashes: {
      configHash: string;
      billsHash: string;
      goalsHash: string;
      decisionsHash: string;
    }
  ): Promise<string> {
    const proofs = [
      ethers.getBytes(hashes.configHash),
      ethers.getBytes(hashes.billsHash),
      ethers.getBytes(hashes.goalsHash),
      ethers.getBytes(hashes.decisionsHash),
    ];

    console.log(`[contract] Updating data hashes for tokenId ${tokenId}...`);
    const tx = await this.contract.update(tokenId, proofs);
    const receipt = await tx.wait();
    console.log(`[contract] Updated data hashes, tx: ${receipt.hash}`);
    return receipt.hash;
  }

  /**
   * Read current data hashes from the iNFT.
   * Returns an object mapping description → hash.
   */
  async getDataHashes(tokenId: number): Promise<Record<string, string>> {
    const hashes: string[] = await this.contract.dataHashesOf(tokenId);
    const descriptions: string[] = await this.contract.dataDescriptionsOf(tokenId);

    const result: Record<string, string> = {};
    for (let i = 0; i < descriptions.length; i++) {
      result[descriptions[i]] = hashes[i];
    }
    return result;
  }

  /** Get the owner of an iNFT */
  async getOwner(tokenId: number): Promise<string> {
    return this.contract.ownerOf(tokenId);
  }

  /** Authorize another address to use the iNFT */
  async authorizeUsage(tokenId: number, user: string): Promise<string> {
    const tx = await this.contract.authorizeUsage(tokenId, user);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /** Get token URI (contains chainURL and indexerURL) */
  async getTokenURI(tokenId: number): Promise<string> {
    return this.contract.tokenURI(tokenId);
  }

  /** Get the signer's address */
  async getAddress(): Promise<string> {
    return this.signer.getAddress();
  }
}
