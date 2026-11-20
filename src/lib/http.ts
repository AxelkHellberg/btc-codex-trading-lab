export class HttpError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers
  });

  if (!response.ok) {
    throw new HttpError(await response.text(), response.status);
  }

  return (await response.json()) as T;
}
