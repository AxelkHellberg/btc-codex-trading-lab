export interface AppHealthResult {
  state: "ok" | "down";
  status?: number;
  reason?: "http_error" | "invalid_json" | "unhealthy_payload" | "request_failed";
}

export const probeAppHealth = async (url: string): Promise<AppHealthResult> => {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return { state: "down", reason: "request_failed" };
  }

  if (!response.ok) {
    // Status is sufficient diagnostic context; do not log arbitrary response bodies.
    await response.body?.cancel().catch(() => undefined);
    return { state: "down", status: response.status, reason: "http_error" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { state: "down", status: response.status, reason: "invalid_json" };
  }

  if (typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) {
    return { state: "down", status: response.status, reason: "unhealthy_payload" };
  }
  return { state: "ok", status: response.status };
};
