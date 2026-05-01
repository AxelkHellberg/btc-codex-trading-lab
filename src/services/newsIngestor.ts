import crypto from "node:crypto";

import type { Logger } from "pino";
import Parser from "rss-parser";

import type { AppConfig } from "../config.js";
import type { NewsEvent } from "../domain/types.js";

const parser = new Parser();

const POSITIVE_WORDS = ["approval", "inflow", "bull", "surge", "record", "adoption", "breakout"];
const NEGATIVE_WORDS = ["hack", "ban", "liquidation", "lawsuit", "outflow", "bear", "dump"];
const BTC_KEYWORDS = ["bitcoin", "btc", "etf", "fomc", "cpi", "inflation", "fed", "rates", "sec"];

export class NewsIngestor {
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly onEvents: (events: NewsEvent[]) => Promise<void> | void
  ) {}

  public async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, 60_000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async poll(): Promise<void> {
    const feeds = [
      ...this.config.feeds.news.map((feed) => ({ feed, tag: "news" })),
      ...this.config.feeds.macro.map((feed) => ({ feed, tag: "macro" }))
    ];

    if (feeds.length === 0) {
      return;
    }

    const collected: NewsEvent[] = [];
    await Promise.all(
      feeds.map(async ({ feed, tag }) => {
        try {
          const parsed = await parser.parseURL(feed);
          for (const item of parsed.items.slice(0, 10)) {
            const title = item.title?.trim();
            if (!title) {
              continue;
            }
            const url = item.link ?? undefined;
            const publishedAt = item.isoDate ? Date.parse(item.isoDate) : Date.now();
            const id = crypto
              .createHash("sha1")
              .update(`${parsed.title}:${title}:${url ?? ""}`)
              .digest("hex");
            if (this.seen.has(id)) {
              continue;
            }
            this.seen.add(id);
            collected.push({
              id,
              source: parsed.title ?? new URL(feed).hostname,
              title,
              url,
              publishedAt,
              relevanceScore: this.scoreRelevance(title, tag),
              sentimentScore: this.scoreSentiment(title),
              tags: this.extractTags(title, tag)
            });
          }
        } catch (error) {
          this.logger.warn({ error, feed }, "Failed to fetch RSS feed");
        }
      })
    );

    if (collected.length > 0) {
      await this.onEvents(
        collected.sort((left, right) => right.relevanceScore - left.relevanceScore)
      );
    }
  }

  private scoreRelevance(title: string, tag: string): number {
    const lower = title.toLowerCase();
    const keywordHits = BTC_KEYWORDS.filter((keyword) => lower.includes(keyword)).length;
    const freshnessBonus = 0.15;
    const base = tag === "macro" ? 0.55 : 0.45;
    return Math.min(1, base + keywordHits * 0.12 + freshnessBonus);
  }

  private scoreSentiment(title: string): number {
    const lower = title.toLowerCase();
    const positive = POSITIVE_WORDS.filter((keyword) => lower.includes(keyword)).length;
    const negative = NEGATIVE_WORDS.filter((keyword) => lower.includes(keyword)).length;
    if (positive === negative) {
      return 0;
    }
    return Math.max(-1, Math.min(1, (positive - negative) / 3));
  }

  private extractTags(title: string, tag: string): string[] {
    const lower = title.toLowerCase();
    const tags = [tag];
    for (const keyword of BTC_KEYWORDS) {
      if (lower.includes(keyword)) {
        tags.push(keyword);
      }
    }
    return [...new Set(tags)];
  }
}
