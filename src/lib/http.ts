export class HttpError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class RequestTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

type TimedRequestInit = RequestInit & {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

async function consumeWithTimeout<T>(
  input: string,
  init: TimedRequestInit | undefined,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...requestInit } = init ?? {};
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be a nonnegative 32-bit integer");
  }
  const controller = new AbortController();
  const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => {
    controller.abort(new RequestTimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs));
  }, timeoutMs);
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const operation = async (): Promise<T> => {
    const response = await fetch(input, { ...requestInit, signal });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (!response.ok) {
      throw new HttpError(await response.text(), response.status);
    }
    return await consume(response);
  };
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectAbort);
  }
}

export async function fetchText(input: string, init?: TimedRequestInit): Promise<string> {
  return consumeWithTimeout(input, init, (response) => response.text());
}

export async function fetchJson<T>(input: string, init?: TimedRequestInit): Promise<T> {
  return consumeWithTimeout(input, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) }
  }, async (response) => (await response.json()) as T);
}
