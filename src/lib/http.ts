import { readErrorCode } from "./httpErrorCode.js";

export class HttpError extends Error {
  public readonly status: number;
  public readonly code?: number;

  public constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export async function fetchJson<T>(input: string, init?: RequestInit, options?: { captureErrorCode: boolean }): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    if (options?.captureErrorCode) {
      // Retain only a numeric API code; never expose response text in diagnostics.
      const code = response.status === 400 ? await readErrorCode(response) : undefined;
      void response.body?.cancel().catch(() => undefined);
      throw new HttpError(`HTTP request failed (status ${response.status})`, response.status, code);
    }
    throw new HttpError(await response.text(), response.status);
  }

  return (await response.json()) as T;
}
