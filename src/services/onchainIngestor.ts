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

type DifficultyResponse = {
  progressPercent: number;
  remainingBlocks: number;
  nextRetargetHeight: number;
  previousRetarget: number;
  difficultyChange: number;
};

function parseDifficultyChange(payload: unknown): number {
  const change = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Partial<DifficultyResponse>).difficultyChange : undefined;
  // The upstream BTC estimate is clamped to the protocol's -75% to +300% range.
  if (typeof change !== "number" || !Number.isFinite(change) || change < -75 || change > 300) {
    throw new Error("Invalid /v1/difficulty-adjustment difficultyChange: expected a finite percentage from -75 to 300");
  }
  return change;
}

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
      const [mempool, fees, tipHeight, difficulty] = await Promise.all([
        fetchJson<MempoolResponse>(`${this.config.onchainBaseUrl}/mempool`),
        fetchJson<FeesResponse>(`${this.config.onchainBaseUrl}/v1/fees/recommended`),
        fetch(`${this.config.onchainBaseUrl}/blocks/tip/height`).then(async (response) =>
          Number(await response.text())
        ),
        fetchJson<DifficultyResponse>(`${this.config.onchainBaseUrl}/v1/difficulty-adjustment`)
      ]);

      const now = Date.now();
      const blockCadenceSeconds =
        this.lastHeight !== null && this.lastHeightAt !== null && tipHeight > this.lastHeight
          ? (now - this.lastHeightAt) / 1000 / (tipHeight - this.lastHeight)
          : 600;

      const difficultyAdjustment = parseDifficultyChange(difficulty);
      this.lastHeight = tipHeight;
      this.lastHeightAt = now;
      this.lastFees = fees.fastestFee;

      await this.onSnapshot({
        mempoolTxCount: mempool.count,
        fastestFee: fees.fastestFee,
        halfHourFee: fees.halfHourFee,
        hourFee: fees.hourFee,
        tipHeight,
        difficultyAdjustment,
        blockCadenceSeconds,
        timestamp: now
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to refresh on-chain metrics");
    }
  }
}
