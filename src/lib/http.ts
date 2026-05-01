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

async function fetchWithTimeout(input: string, init?: TimedRequestInit): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  try {
    return await fetch(input, {
      ...init,
      signal
    });
  } catch (error) {
    if (timeoutSignal.aborted && !(init?.signal?.aborted ?? false)) {
      throw new RequestTimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs);
    }

    throw error;
  }
}

export async function fetchText(input: string, init?: TimedRequestInit): Promise<string> {
  const response = await fetchWithTimeout(input, init);

  if (!response.ok) {
    throw new HttpError(await response.text(), response.status);
  }

  return await response.text();
}

export async function fetchJson<T>(input: string, init?: TimedRequestInit): Promise<T> {
  const response = await fetchWithTimeout(input, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new HttpError(await response.text(), response.status);
  }

  return (await response.json()) as T;
}
