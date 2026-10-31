export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

const endpoint = "/fapi/v1/klines";

// One deadline covers both response headers and the complete JSON body.
const fetchPage = async (url: string, symbol: string, cursor: number, endTime: number): Promise<{ payload: unknown; context: string }> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Binance historical klines ${endpoint} ${symbol} startTime=${cursor} endTime=${endTime} timed out after 10000ms`));
      controller.abort();
    }, 10_000);
  });
  try {
    return await Promise.race([
      (async () => {
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } catch {
          throw new Error(`Binance historical klines request to ${endpoint} failed before an HTTP response`);
        }
        const context = `Binance historical klines response from ${endpoint} (HTTP ${response.status})`;
        if (!response.ok) {
          throw new Error(`${context}: request failed`);
        }
        try {
          return { payload: await response.json(), context };
        } catch {
          throw new Error(`${context}: invalid JSON`);
        }
      })(),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const parseCandle = (row: unknown, index: number, context: string): Candle => {
  const invalid = (reason: string): never => {
    throw new Error(`${context}: invalid row ${index + 1} (${reason})`);
  };
  if (!Array.isArray(row) || row.length < 12) {
    return invalid("expected a complete kline tuple");
  }

  const timestamp = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return invalid(`${name} must be a nonnegative integer timestamp`);
    }
    return value;
  };
  const amount = (value: unknown, name: string, allowZero = false): number => {
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "string" && value.trim() === "")
    ) {
      return invalid(`${name} must be numeric`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
      return invalid(`${name} must be finite and ${allowZero ? "nonnegative" : "positive"}`);
    }
    return parsed;
  };

  const candle = {
    openTime: timestamp(row[0], "openTime"),
    open: amount(row[1], "open"),
    high: amount(row[2], "high"),
    low: amount(row[3], "low"),
    close: amount(row[4], "close"),
    volume: amount(row[5], "volume", true),
    closeTime: timestamp(row[6], "closeTime")
  };
  if (candle.closeTime < candle.openTime) {
    return invalid("closeTime precedes openTime");
  }
  if (
    candle.high < Math.max(candle.open, candle.close, candle.low) ||
    candle.low > Math.min(candle.open, candle.close)
  ) {
    return invalid("inconsistent OHLC prices");
  }
  return candle;
};

export const fetchHistoricalKlines = async (
  restBaseUrl: string,
  symbol: string,
  startTime: number,
  endTime: number
): Promise<Candle[]> => {
  const rows: Candle[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const url = `${restBaseUrl}${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1500&startTime=${cursor}&endTime=${endTime}`;
    const { payload, context } = await fetchPage(url, symbol, cursor, endTime);
    if (!Array.isArray(payload)) {
      throw new Error(`${context}: expected a kline array`);
    }
    if (payload.length === 0) {
      break;
    }

    const candles = payload.map((row, index) => parseCandle(row, index, context));
    const nextCursor = candles[candles.length - 1]!.closeTime + 1;
    if (nextCursor <= cursor) {
      throw new Error(`${context}: page did not advance the historical cursor`);
    }
    rows.push(...candles);
    cursor = nextCursor;
  }

  return rows;
};
