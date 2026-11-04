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
import { RuntimeWork } from "./services/runtimeWork.js";
import { RuntimeState } from "./services/runtimeState.js";
import { ServiceLifecycle } from "./services/serviceLifecycle.js";
import { StartupInterrupted, StartupShutdown } from "./services/startupShutdown.js";
import { StrategyPlanner } from "./services/strategyPlanner.js";

const main = async (): Promise<void> => {
  const runtime = new RuntimeState(config.paperStartingBalance);
  const store = new PostgresStateStore(config.postgresUrl, logger);
  const hotStore = new RedisHotStore(config.redisUrl, logger);
  const lifecycle = new ServiceLifecycle();
  const work = new RuntimeWork();
  lifecycle.own("Postgres", () => store.close());
  lifecycle.own("Redis", () => hotStore.close());
  lifecycle.own("In-flight runtime work", () => work.drain());
  let cleanupReported = false;
  const cleanup = async (): Promise<void> => {
    work.close();
    const failures = await lifecycle.stop();
    if (!cleanupReported) {
      cleanupReported = true;
      for (const failure of failures) {
        logger.warn({ service: failure.name, error: failure.error }, "Service teardown failed");
      }
    }
  };

  const shutdown = new StartupShutdown(
    cleanup,
    code => process.exit(code),
    error => logger.error({ error }, "Shutdown failed")
  );
  const requestShutdown = () => { work.close(); shutdown.request(); };
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
  let startupFailed = false;

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
    shutdown.checkpoint();

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
    }): Promise<void> => work.run(async () => {
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
    });

    const eventDetector = new EventDetector(evaluateTrigger, () => runtime.getMarket());

    const marketIngestor = new MarketIngestor(config, binance, logger, {
      onMarket: (snapshot) => work.run(async () => {
        runtime.setMarket(snapshot);
        // Process the paper price before storage or model work can delay this tick.
        // The real PaperBroker applies its deterministic lifecycle before its promise settles.
        const failures: unknown[] = [];
        const persist = async (operation: () => Promise<unknown>): Promise<void> => {
          try { await operation(); } catch (error) { failures.push(error); }
        };
        if ("onMarketSnapshot" in broker && typeof broker.onMarketSnapshot === "function") {
          const result = await broker.onMarketSnapshot(snapshot);
          const state = "getState" in broker && typeof broker.getState === "function"
            ? broker.getState()
            : result;
          if (state) {
            runtime.setAccount(state.accountState);
            runtime.setPosition(state.positionState);
          }
          if (result) {
            await persist(async () => {
              try { await executionEngine.handleExecutionResult(result); }
              catch (error) {
                logger.error({ tradeId: result.tradeRecord?.tradeId },
                  "Paper execution result handling failed; inspect audit state");
                throw error;
              }
            });
          }
          // Attempt every state sink even when another write failed. Never replay the fill.
          if (state) {
            await persist(() => store.saveSnapshot("account", state.accountState));
            await persist(() => store.saveSnapshot("position", state.positionState));
            await persist(() => hotStore.setJson("latest:account", state.accountState, 300));
            await persist(() => hotStore.setJson("latest:position", state.positionState, 300));
          }
        }
        await persist(() => store.saveSnapshot("market", snapshot));
        await persist(() => hotStore.setJson("latest:market", snapshot, 300));
        // New decisions remain fail-closed when any required persistence step failed.
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Market callback persistence failed");
        await eventDetector.handleMarket(snapshot);
      }),
      onAccount: (account) => work.run(async () => {
        runtime.setAccount(account);
        await store.saveSnapshot("account", account);
        await hotStore.setJson("latest:account", account, 300);
      }),
      onPosition: (position) => work.run(async () => {
        runtime.setPosition(position);
        await store.saveSnapshot("position", position);
        await hotStore.setJson("latest:position", position, 300);
      })
    });

    const newsIngestor = new NewsIngestor(config, logger, (events) => work.run(async () => {
      runtime.pushNews(events);
      await store.saveSnapshot("news", events);
      await hotStore.setJson("latest:news", events, 300);
      await eventDetector.handleNews(events);
    }));

    const onchainIngestor = new OnchainIngestor(config, logger, (snapshot) => work.run(async () => {
      runtime.setOnchain(snapshot);
      await store.saveSnapshot("onchain", snapshot);
      await hotStore.setJson("latest:onchain", snapshot, 300);
      await eventDetector.handleOnchain(snapshot);
    }));

    const httpServer = await createHttpServer(runtime, config.port, async () => {
      await evaluateTrigger({
        reason: "manual_recheck",
        priority: 3,
        details: "manual HTTP trigger",
        triggeredAt: Date.now()
      });
    });
    lifecycle.own("HTTP server", () => httpServer.stop());
    shutdown.checkpoint();
    await httpServer.start();
    shutdown.checkpoint();
    await lifecycle.start([
      { name: "Market ingestor", start: () => marketIngestor.start(), stop: () => marketIngestor.stop() },
      { name: "News ingestor", start: () => newsIngestor.start(), stop: () => newsIngestor.stop() },
      { name: "On-chain ingestor", start: () => onchainIngestor.start(), stop: () => onchainIngestor.stop() }
    ], shutdown.checkpoint);

    const heartbeatTimer = setInterval(() => {
      void work.run(async () => {
        await store.heartbeat("btc-codex-trader", {
          mode: config.tradingMode,
          symbol: config.symbol,
          ts: Date.now()
        });
        await eventDetector.heartbeat();
      }).catch(error => logger.error({ error }, "Heartbeat failed"));
    }, 60_000);

    lifecycle.own("Heartbeat", () => clearInterval(heartbeatTimer));

    logger.info(
      {
        mode: config.tradingMode,
        symbol: config.symbol,
        port: config.port
      },
      "BTC Codex trader started"
    );
  } catch (error) {
    startupFailed = !(error instanceof StartupInterrupted);
    await cleanup();
    if (startupFailed) throw error;
  } finally {
    shutdown.finishStartup(startupFailed);
  }
};

void main().catch((error) => {
  logger.error({ error }, "Fatal startup failure");
  process.exit(1);
});
