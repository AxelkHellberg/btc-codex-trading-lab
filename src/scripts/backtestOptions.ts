type BacktestEnvironment = {
  BACKTEST_DAYS?: string;
  BACKTEST_INITIAL_BALANCE?: string;
};

const positiveFiniteNumber = (name: string, value: string | number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite number greater than zero`);
  }
  return parsed;
};

export const readBacktestOptions = (
  env: BacktestEnvironment,
  defaultInitialBalance: number
): { days: number; initialBalance: number } => ({
  days: positiveFiniteNumber("BACKTEST_DAYS", env.BACKTEST_DAYS ?? 90),
  initialBalance: positiveFiniteNumber(
    "BACKTEST_INITIAL_BALANCE",
    env.BACKTEST_INITIAL_BALANCE ?? defaultInitialBalance
  )
});
