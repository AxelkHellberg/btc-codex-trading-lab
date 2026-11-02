import { config } from "./config.js";
import { BinanceFuturesClient } from "./infra/binance/binanceFuturesClient.js";
import { TelegramNotifier } from "./infra/notifier/telegramNotifier.js";
import { PostgresStateStore } from "./infra/store/postgresStateStore.js";
import { RedisHotStore } from "./infra/store/redisHotStore.js";
import { createHttpServer } from "./http/server.js";
import { logger } from "./logger.js";
import { LiveBroker, PaperBroker, type Broker } from "./services/brokers.js";
import { CodexDecisionWorker } from "./services/codexDecisionWorker.js";
import { EventDetector } from "./services/eventDetector.js";
import { ExecutionEngine } from "./services/executionEngine.js";
import { MarketIngestor } from "./services/marketIngestor.js";
import { NewsIngestor } from "./services/newsIngestor.js";
import { OnchainIngestor } from "./services/onchainIngestor.js";
import { RiskEngine } from "./services/riskEngine.js";
import { RuntimeState } from "./services/runtimeState.js";
import { ServiceLifecycle } from "./services/serviceLifecycle.js";
import { StrategyPlanner } from "./services/strategyPlanner.js";

const main = async (): Promise<void> => {
  const runtime = new RuntimeState(config.paperStartingBalance);
  const store = new PostgresStateStore(config.postgresUrl, logger);
  const hotStore = new RedisHotStore(config.redisUrl, logger);
  const lifecycle = new ServiceLifecycle();
  lifecycle.own("Postgres", () => store.close());
  lifecycle.own("Redis", () => hotStore.close());
  let cleanupReported = false;
  const cleanup = async (): Promise<void> => {
    const failures = await lifecycle.stop();
    if (!cleanupReported) {
      cleanupReported = true;
      for (const failure of failures) {
        logger.warn({ service: failure.name, error: failure.error }, "Service teardown failed");
      }
    }
  };

  try {
    const notifier = new TelegramNotifier(config.telegram.botToken, config.telegram.chatId, logger);
    const binance = new BinanceFuturesClient(
      config.binance.restBaseUrl,
      config.binance.wsBaseUrl,
      config.binance.apiKey,
      config.binance.apiSecret,
      logger
    );
    const broker: Broker =
      config.tradingMode === "live"
        ? new LiveBroker(config, binance, logger)
        : new PaperBroker(config);
    const executionEngine = new ExecutionEngine(config, runtime, store, notifier, broker, logger);
    const decisionWorker = new CodexDecisionWorker(config, logger);
    const planner = new StrategyPlanner(config);
    const riskEngine = new RiskEngine(config);

    await store.init();

    const evaluateTrigger = async (trigger: {
      reason:
        | "minute_recheck"
        | "market_breakout"
        | "open_interest_spike"
        | "funding_extreme"
        | "news_relevant"
        | "macro_relevant"
        | "onchain_shift"
        | "manual_recheck";
      priority: number;
      details: string;
      triggeredAt: number;
    }): Promise<void> => {
      const lockToken = `${process.pid}-${trigger.reason}-${trigger.triggeredAt}`;
      const acquired = await hotStore.acquireLock("decision-loop", lockToken, 55_000);
      if (!acquired) {
        return;
      }

      try {
        const context = runtime.buildDecisionContext(trigger, config.riskPolicy);
        if (!context) {
          return;
        }

        await hotStore.setJson("latest:context", context, 300);
        const signal = await decisionWorker.decide(context);
        const planning = planner.plan(context, signal);
        const evaluation = riskEngine.evaluate(context, planning);
        await executionEngine.maybeExecute(context, signal, evaluation);
      } catch (error) {
        logger.error({ error, trigger }, "Decision loop failed");
        await notifier.notify(`Decision loop failed: ${String(error)}`);
      } finally {
        await hotStore.releaseLock("decision-loop", lockToken);
      }
    };

    const eventDetector = new EventDetector(evaluateTrigger, () => runtime.getMarket());

    const marketIngestor = new MarketIngestor(config, binance, logger, {
      onMarket: async (snapshot) => {
        runtime.setMarket(snapshot);
        await store.saveSnapshot("market", snapshot);
        await hotStore.setJson("latest:market", snapshot, 300);
        await eventDetector.handleMarket(snapshot);
        if ("onMarketSnapshot" in broker && typeof broker.onMarketSnapshot === "function") {
          const result = await broker.onMarketSnapshot(snapshot);
          if ("getState" in broker && typeof broker.getState === "function") {
            const state = broker.getState();
            runtime.setAccount(state.accountState);
            runtime.setPosition(state.positionState);
          }
          if (result) {
            await executionEngine.handleExecutionResult(result);
            await store.saveSnapshot("account", result.accountState);
            await store.saveSnapshot("position", result.positionState);
            await hotStore.setJson("latest:account", result.accountState, 300);
            await hotStore.setJson("latest:position", result.positionState, 300);
          }
        }
      },
      onAccount: async (account) => {
        runtime.setAccount(account);
        await store.saveSnapshot("account", account);
        await hotStore.setJson("latest:account", account, 300);
      },
      onPosition: async (position) => {
        runtime.setPosition(position);
        await store.saveSnapshot("position", position);
        await hotStore.setJson("latest:position", position, 300);
      }
    });

    const newsIngestor = new NewsIngestor(config, logger, async (events) => {
      runtime.pushNews(events);
      await store.saveSnapshot("news", events);
      await hotStore.setJson("latest:news", events, 300);
      await eventDetector.handleNews(events);
    });

    const onchainIngestor = new OnchainIngestor(config, logger, async (snapshot) => {
      runtime.setOnchain(snapshot);
      await store.saveSnapshot("onchain", snapshot);
      await hotStore.setJson("latest:onchain", snapshot, 300);
      await eventDetector.handleOnchain(snapshot);
    });

    const httpServer = await createHttpServer(runtime, config.port, async () => {
      await evaluateTrigger({
        reason: "manual_recheck",
        priority: 3,
        details: "manual HTTP trigger",
        triggeredAt: Date.now()
      });
    });
    await lifecycle.start([
      { name: "HTTP server", start: () => httpServer.start(), stop: () => httpServer.stop() },
      { name: "Market ingestor", start: () => marketIngestor.start(), stop: () => marketIngestor.stop() },
      { name: "News ingestor", start: () => newsIngestor.start(), stop: () => newsIngestor.stop() },
      { name: "On-chain ingestor", start: () => onchainIngestor.start(), stop: () => onchainIngestor.stop() }
    ]);

    const heartbeatTimer = setInterval(() => {
      void (async () => {
        await store.heartbeat("btc-codex-trader", {
          mode: config.tradingMode,
          symbol: config.symbol,
          ts: Date.now()
        });
        await eventDetector.heartbeat();
      })();
    }, 60_000);

    lifecycle.own("Heartbeat", () => clearInterval(heartbeatTimer));

    const shutdown = async (): Promise<void> => {
      await cleanup();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });

    logger.info(
      {
        mode: config.tradingMode,
        symbol: config.symbol,
        port: config.port
      },
      "BTC Codex trader started"
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
};

void main().catch((error) => {
  logger.error({ error }, "Fatal startup failure");
  process.exit(1);
});
