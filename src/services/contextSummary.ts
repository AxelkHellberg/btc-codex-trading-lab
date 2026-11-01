import type { DecisionContext, MarketRegime, MarketSnapshot } from "../domain/types.js";

const classifyRegime = (snapshot: MarketSnapshot): MarketRegime => {
  if (
    snapshot.emaFast > snapshot.emaMedium &&
    snapshot.priceChangePct15m >= 0.2 &&
    snapshot.priceChangePct1h >= 0.6 &&
    snapshot.trendStrengthPct >= 0.18
  ) {
    return "trend_up";
  }

  if (
    snapshot.emaFast < snapshot.emaMedium &&
    snapshot.priceChangePct15m <= -0.2 &&
    snapshot.priceChangePct1h <= -0.6 &&
    snapshot.trendStrengthPct <= -0.18
  ) {
    return "trend_down";
  }

  if (Math.abs(snapshot.priceChangePct5m) < 0.18 && Math.abs(snapshot.trendStrengthPct) < 0.14) {
    return "range";
  }

  return "transition";
};

// Replay has no news feed; its catalyst defaults to the neutral runtime value.
export const buildContextSummary = (
  snapshot: MarketSnapshot,
  averageSentiment = 0
): DecisionContext["context_summary"] => {
  const momentumScore =
    snapshot.priceChangePct1m * 0.35 +
    snapshot.priceChangePct5m * 0.3 +
    snapshot.priceChangePct15m * 0.2 +
    snapshot.trendStrengthPct * 0.15;
  const trendBias =
    snapshot.emaFast > snapshot.emaMedium && snapshot.priceChangePct15m >= 0
      ? "bullish"
      : snapshot.emaFast < snapshot.emaMedium && snapshot.priceChangePct15m <= 0
        ? "bearish"
        : "neutral";
  const catalystBias = averageSentiment > 0.12 ? "bullish" : averageSentiment < -0.12 ? "bearish" : "neutral";

  return {
    regime: classifyRegime(snapshot),
    trend_bias: trendBias,
    catalyst_bias: catalystBias,
    momentum_score: Number(momentumScore.toFixed(3)),
    key_levels: {
      intraday_high: snapshot.intradayHigh,
      intraday_low: snapshot.intradayLow
    },
    notes: [
      `volume acceleration ${snapshot.volumeAcceleration.toFixed(2)}x versus recent average`,
      `distance to intraday high ${snapshot.distanceFromIntradayHighPct.toFixed(2)}%`,
      `distance to intraday low ${snapshot.distanceFromIntradayLowPct.toFixed(2)}%`
    ]
  };
};
