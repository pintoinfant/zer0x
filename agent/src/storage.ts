import { ethers } from "ethers";
import { Indexer, MemData, getFlowContract } from "@0gfoundation/0g-storage-ts-sdk";
import type { UserConfig, Bill, Goal, Decision } from "./types.js";
import * as fs from "fs/promises";
import * as path from "path";

// =========================================================================
// 0G Storage + local fallback for PayAgent data
//
// Architecture:
//   - Each data type (config, bills, goals, decisions) is a JSON blob
//     uploaded to 0G Storage.
//   - The root hash of each blob is stored on-chain in the iNFT's dataHashes.
//   - We also keep a local cache (.data/) for fast reads and as fallback
//     if 0G Storage is unavailable.
// =========================================================================

const LOCAL_DATA_DIR = path.join(process.cwd(), ".data");

interface StorageConfig {
  rpcUrl: string;
  indexerUrl: string;
  flowContractAddress: string;
  privateKey: string;
}

export class PayAgentStorage {
  private indexer: Indexer;
  private signer: ethers.Wallet;
  private flowContract: ReturnType<typeof getFlowContract>;
  private config: StorageConfig;
  private initialized = false;

  constructor(config: StorageConfig) {
    this.config = config;
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.privateKey, provider);
    this.indexer = new Indexer(config.indexerUrl);
    this.flowContract = getFlowContract(config.flowContractAddress, this.signer);
  }

  async init(): Promise<void> {
    await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
    this.initialized = true;
  }

  // =========================================================================
  // Upload: serialize to JSON → upload to 0G Storage → return root hash
  // =========================================================================

  async upload(data: unknown, label: string): Promise<string> {
    const json = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(json);
    const file = new MemData(bytes);

    try {
      const [result, err] = await this.indexer.upload(
        file,
        this.config.rpcUrl,
        this.signer,
        {
          tags: ethers.toUtf8Bytes(`payagent:${label}`),
          finalityRequired: true,
        }
      );

      if (err) {
        console.error(`[storage] Upload error for ${label}:`, err);
        throw err;
      }

      // result can be single or multi depending on file size
      const rootHash = "rootHash" in result ? result.rootHash : result.rootHashes[0];
      console.log(`[storage] Uploaded ${label}, rootHash: ${rootHash}`);

      // Cache locally
      await this.saveLocal(label, data, rootHash);

      return rootHash;
    } catch (error) {
      console.warn(`[storage] 0G upload failed for ${label}, saving locally only:`, error);
      const fallbackHash = ethers.keccak256(bytes);
      await this.saveLocal(label, data, fallbackHash);
      return fallbackHash;
    }
  }

  // =========================================================================
  // Download: fetch from 0G Storage by root hash → parse JSON
  // =========================================================================

  async download<T>(rootHash: string, label: string): Promise<T | null> {
    // Try local cache first
    const cached = await this.loadLocal<T>(label);
    if (cached && cached.rootHash === rootHash) {
      return cached.data;
    }

    try {
      const [blob, err] = await this.indexer.downloadToBlob(rootHash);
      if (err) {
        console.error(`[storage] Download error for ${label}:`, err);
        return cached?.data ?? null;
      }

      const text = await blob.text();
      const data = JSON.parse(text) as T;

      // Update local cache
      await this.saveLocal(label, data, rootHash);

      return data;
    } catch (error) {
      console.warn(`[storage] 0G download failed for ${label}, using local cache:`, error);
      return cached?.data ?? null;
    }
  }

  // =========================================================================
  // High-level operations for PayAgent data types
  // =========================================================================

  async saveConfig(userId: string, config: UserConfig): Promise<string> {
    return this.upload(config, `config:${userId}`);
  }

  async loadConfig(userId: string, rootHash?: string): Promise<UserConfig | null> {
    if (rootHash) {
      return this.download<UserConfig>(rootHash, `config:${userId}`);
    }
    const cached = await this.loadLocal<UserConfig>(`config:${userId}`);
    return cached?.data ?? null;
  }

  async saveBills(userId: string, bills: Bill[]): Promise<string> {
    return this.upload(bills, `bills:${userId}`);
  }

  async loadBills(userId: string, rootHash?: string): Promise<Bill[]> {
    if (rootHash) {
      return (await this.download<Bill[]>(rootHash, `bills:${userId}`)) ?? [];
    }
    const cached = await this.loadLocal<Bill[]>(`bills:${userId}`);
    return cached?.data ?? [];
  }

  async saveGoals(userId: string, goals: Goal[]): Promise<string> {
    return this.upload(goals, `goals:${userId}`);
  }

  async loadGoals(userId: string, rootHash?: string): Promise<Goal[]> {
    if (rootHash) {
      return (await this.download<Goal[]>(rootHash, `goals:${userId}`)) ?? [];
    }
    const cached = await this.loadLocal<Goal[]>(`goals:${userId}`);
    return cached?.data ?? [];
  }

  async saveDecision(userId: string, decision: Decision): Promise<string> {
    // Load existing history, append, re-upload
    const history = await this.loadDecisionHistory(userId);
    history.push(decision);
    return this.upload(history, `decisions:${userId}`);
  }

  async loadDecisionHistory(userId: string, rootHash?: string): Promise<Decision[]> {
    if (rootHash) {
      return (await this.download<Decision[]>(rootHash, `decisions:${userId}`)) ?? [];
    }
    const cached = await this.loadLocal<Decision[]>(`decisions:${userId}`);
    return cached?.data ?? [];
  }

  // =========================================================================
  // Upload all user data and return root hashes for iNFT update
  // =========================================================================

  async uploadAllUserData(
    userId: string,
    config: UserConfig,
    bills: Bill[],
    goals: Goal[],
    decisions: Decision[]
  ): Promise<{ configHash: string; billsHash: string; goalsHash: string; decisionsHash: string }> {
    const [configHash, billsHash, goalsHash, decisionsHash] = await Promise.all([
      this.upload(config, `config:${userId}`),
      this.upload(bills, `bills:${userId}`),
      this.upload(goals, `goals:${userId}`),
      this.upload(decisions, `decisions:${userId}`),
    ]);

    return { configHash, billsHash, goalsHash, decisionsHash };
  }

  // =========================================================================
  // Local cache helpers
  // =========================================================================

  private localPath(label: string): string {
    // Sanitize label for filesystem
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(LOCAL_DATA_DIR, `${safe}.json`);
  }

  private async saveLocal(label: string, data: unknown, rootHash: string): Promise<void> {
    try {
      await fs.writeFile(
        this.localPath(label),
        JSON.stringify({ rootHash, data, updatedAt: Date.now() }, null, 2)
      );
    } catch (error) {
      console.warn(`[storage] Local save failed for ${label}:`, error);
    }
  }

  private async loadLocal<T>(label: string): Promise<{ rootHash: string; data: T } | null> {
    try {
      const raw = await fs.readFile(this.localPath(label), "utf-8");
      const parsed = JSON.parse(raw);
      return { rootHash: parsed.rootHash, data: parsed.data as T };
    } catch {
      return null;
    }
  }
}
