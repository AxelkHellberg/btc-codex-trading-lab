import type { AccountState, RiskPolicy, RiskState } from "../domain/types.js";

export type AccountRiskPolicy = Pick<RiskPolicy, "maxDailyLoss" | "maxWeeklyDrawdown" | "cooldownMinutes">;

export const evaluateAccountRisk = (
  account: AccountState,
  policy: AccountRiskPolicy,
  now: number = Date.now()
): RiskState => {
  const reasons: string[] = [];
  const dailyLossHit = account.dailyPnl <= -policy.maxDailyLoss * account.walletBalance;
  const weeklyDrawdownHit = account.weeklyDrawdown >= policy.maxWeeklyDrawdown;
  const cooldownActive = account.consecutiveLosses >= 2 && account.lastLossAt !== undefined &&
    now - account.lastLossAt < policy.cooldownMinutes * 60_000;

  if (dailyLossHit) reasons.push("daily loss limit reached");
  if (weeklyDrawdownHit) reasons.push("weekly drawdown limit reached");
  if (cooldownActive) reasons.push("loss cooldown active");

  return {
    withinDailyLossLimit: !dailyLossHit,
    withinWeeklyDrawdown: !weeklyDrawdownHit,
    cooldownActive,
    reasons
  };
};
