import type { AppConfig } from "../config.js";

// Reserve initial margin and the opening taker fee at an adverse slippage fill.
// Use the higher fill factor for both directions so the short path is conservative too.
export const entryFundingRate = (config: AppConfig, leverage: number): number => {
  if (
    !Number.isInteger(leverage) || leverage < 1 || leverage > config.riskPolicy.maxLeverage ||
    !Number.isFinite(config.slippageBps) || config.slippageBps < 0 ||
    !Number.isFinite(config.takerFeeBps) || config.takerFeeBps < 0
  ) {
    return Infinity;
  }
  const rate = (1 + config.slippageBps / 10_000) * (1 / leverage + config.takerFeeBps / 10_000);
  return Number.isFinite(rate) && rate > 0 ? rate : Infinity;
};
