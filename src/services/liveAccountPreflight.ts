import type { AppConfig } from "../config.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";

/** Check compatibility before creating live execution services or callbacks. */
export const assertLiveAccountMode = async (
  mode: AppConfig["tradingMode"],
  client: Pick<BinanceFuturesClient, "getPositionMode">
): Promise<void> => {
  if (mode !== "live") return;
  if (await client.getPositionMode()) {
    throw new Error("Live trading requires Binance one-way position mode; hedge mode is unsupported. Review account mode manually before restarting.");
  }
};
