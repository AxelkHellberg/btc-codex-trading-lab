import "dotenv/config";

import { z } from "zod";

import type { RiskPolicy, TradingMode } from "./domain/types.js";

const csvToList = (raw: string): string[] =>
  raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const parseBooleanEnv = (raw: string | undefined, defaultValue: boolean): boolean => {
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "") {
    return defaultValue;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  return defaultValue;
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
  SYMBOL: z.string().default("BTCUSDT"),
  BINANCE_FUTURES_BASE_URL: z.string().url().default("https://fapi.binance.com"),
  BINANCE_FUTURES_WS_URL: z.string().url().default("wss://fstream.binance.com/stream"),
  BINANCE_API_KEY: z.string().default(""),
  BINANCE_API_SECRET: z.string().default(""),
  POSTGRES_URL: z.string().default("postgres://postgres:postgres@localhost:5432/trader"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  NEWS_FEEDS: z.string().default(""),
  MACRO_FEEDS: z.string().default(""),
  ONCHAIN_BASE_URL: z.string().url().default("https://mempool.space/api"),
  RISK_PER_TRADE: z.coerce.number().positive().default(0.005),
  MAX_LEVERAGE: z.coerce.number().int().positive().default(3),
  MAX_DAILY_LOSS: z.coerce.number().positive().default(0.02),
  MAX_WEEKLY_DRAWDOWN: z.coerce.number().positive().default(0.05),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(1),
  COOLDOWN_MINUTES: z.coerce.number().int().positive().default(60),
  MIN_RISK_REWARD: z.coerce.number().positive().default(1.5),
  SLIPPAGE_BPS: z.coerce.number().nonnegative().default(3),
  TAKER_FEE_BPS: z.coerce.number().nonnegative().default(4),
  PAPER_STARTING_BALANCE: z.coerce.number().positive().default(10000),
  CODEX_DECISION_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  CODEX_DECISION_MODEL: z.string().default("gpt-5.1-codex"),
  CODEX_USE_CLI_FALLBACK: z
    .string()
    .optional()
    .transform((value) => parseBooleanEnv(value, true))
});

const parsed = envSchema.parse(process.env);

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  tradingMode: TradingMode;
  symbol: string;
  binance: {
    restBaseUrl: string;
    wsBaseUrl: string;
    apiKey: string;
    apiSecret: string;
  };
  postgresUrl: string;
  redisUrl: string;
  telegram: {
    botToken?: string;
    chatId?: string;
  };
  feeds: {
    news: string[];
    macro: string[];
  };
  onchainBaseUrl: string;
  riskPolicy: RiskPolicy;
  slippageBps: number;
  takerFeeBps: number;
  paperStartingBalance: number;
  codex: {
    timeoutMs: number;
    model: string;
    useCliFallback: boolean;
  };
}

export const config: AppConfig = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.APP_PORT,
  logLevel: parsed.LOG_LEVEL,
  tradingMode: parsed.TRADING_MODE,
  symbol: parsed.SYMBOL.toUpperCase(),
  binance: {
    restBaseUrl: parsed.BINANCE_FUTURES_BASE_URL,
    wsBaseUrl: parsed.BINANCE_FUTURES_WS_URL,
    apiKey: parsed.BINANCE_API_KEY,
    apiSecret: parsed.BINANCE_API_SECRET
  },
  postgresUrl: parsed.POSTGRES_URL,
  redisUrl: parsed.REDIS_URL,
  telegram: {
    botToken: parsed.TELEGRAM_BOT_TOKEN || undefined,
    chatId: parsed.TELEGRAM_CHAT_ID || undefined
  },
  feeds: {
    news: csvToList(parsed.NEWS_FEEDS),
    macro: csvToList(parsed.MACRO_FEEDS)
  },
  onchainBaseUrl: parsed.ONCHAIN_BASE_URL,
  riskPolicy: {
    maxLeverage: parsed.MAX_LEVERAGE,
    riskPerTrade: parsed.RISK_PER_TRADE,
    maxDailyLoss: parsed.MAX_DAILY_LOSS,
    maxWeeklyDrawdown: parsed.MAX_WEEKLY_DRAWDOWN,
    maxOpenPositions: parsed.MAX_OPEN_POSITIONS,
    cooldownMinutes: parsed.COOLDOWN_MINUTES,
    minRiskReward: parsed.MIN_RISK_REWARD
  },
  slippageBps: parsed.SLIPPAGE_BPS,
  takerFeeBps: parsed.TAKER_FEE_BPS,
  paperStartingBalance: parsed.PAPER_STARTING_BALANCE,
  codex: {
    timeoutMs: parsed.CODEX_DECISION_TIMEOUT_MS,
    model: parsed.CODEX_DECISION_MODEL,
    useCliFallback: parsed.CODEX_USE_CLI_FALLBACK
  }
};
