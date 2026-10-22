import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { OnchainSnapshot } from "../domain/types.js";
import { fetchJson } from "../lib/http.js";

type MempoolResponse = {
  count: number;
};

type FeesResponse = {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
};

function parseFees(payload: unknown): FeesResponse {
  const endpoint = "/v1/fees/recommended";
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`${endpoint}: expected a response object`);
  }
  const values = payload as Record<string, unknown>;
  const fee = (field: keyof FeesResponse): number => {
    const value = values[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${endpoint}: ${field} must be a finite non-negative number`);
    }
    return value;
  };
  return { fastestFee: fee("fastestFee"), halfHourFee: fee("halfHourFee"), hourFee: fee("hourFee") };
}

type DifficultyResponse = {
  progressPercent: number;
  remainingBlocks: number;
  nextRetargetHeight: number;
  previousRetarget: number;
};

export class OnchainIngestor {
  private timer: NodeJS.Timeout | null = null;
  private lastHeight: number | null = null;
  private lastHeightAt: number | null = null;
  private lastFees: number | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly onSnapshot: (snapshot: OnchainSnapshot) => Promise<void> | void
  ) {}

  public async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 5 * 60_000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async poll(): Promise<void> {
    try {
      const [mempool, feesPayload, tipHeight, difficulty] = await Promise.all([
        fetchJson<MempoolResponse>(`${this.config.onchainBaseUrl}/mempool`),
        fetchJson<unknown>(`${this.config.onchainBaseUrl}/v1/fees/recommended`),
        fetch(`${this.config.onchainBaseUrl}/blocks/tip/height`).then(async (response) =>
          Number(await response.text())
        ),
        fetchJson<DifficultyResponse>(`${this.config.onchainBaseUrl}/v1/difficulty-adjustment`)
      ]);

      const fees = parseFees(feesPayload);
      const now = Date.now();
      const blockCadenceSeconds =
        this.lastHeight !== null && this.lastHeightAt !== null && tipHeight > this.lastHeight
          ? (now - this.lastHeightAt) / 1000 / (tipHeight - this.lastHeight)
          : 600;

      this.lastHeight = tipHeight;
      this.lastHeightAt = now;
      this.lastFees = fees.fastestFee;

      await this.onSnapshot({
        mempoolTxCount: mempool.count,
        fastestFee: fees.fastestFee,
        halfHourFee: fees.halfHourFee,
        hourFee: fees.hourFee,
        tipHeight,
        difficultyAdjustment: difficulty.progressPercent,
        blockCadenceSeconds,
        timestamp: now
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to refresh on-chain metrics");
    }
  }
}
