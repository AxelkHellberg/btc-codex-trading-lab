export class HttpError extends Error {
  public readonly status: number;

  public constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const diagnosticEndpoint = (input: string): string => {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "unknown endpoint";
    }
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return "unknown endpoint";
  }
};

export class InvalidJsonResponseError extends HttpError {
  public readonly endpoint: string;
  public readonly contentType: string;

  public constructor(input: string, status: number, rawContentType: string | null) {
    const endpoint = diagnosticEndpoint(input);
    const mediaType = rawContentType?.split(";")[0]?.trim() ?? "";
    const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)
      ? mediaType.slice(0, 128)
      : "unknown";
    super(`Invalid JSON response from ${endpoint} (HTTP ${status}, content-type ${contentType})`, status);
    this.name = "InvalidJsonResponseError";
    this.endpoint = endpoint;
    this.contentType = contentType;
  }
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new HttpError(await response.text(), response.status);
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Do not retain parse errors or payload snippets: upstream bodies and signed
    // query strings can contain account data or credentials.
    throw new InvalidJsonResponseError(input, response.status, response.headers.get("content-type"));
  }
}
