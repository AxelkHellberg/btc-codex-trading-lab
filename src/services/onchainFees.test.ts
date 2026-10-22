import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { OnchainIngestor } from "./onchainIngestor.js";

vi.mock("../lib/http.js", () => ({ fetchJson: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const validFees = { fastestFee: 30, halfHourFee: 20, hourFee: 10 };
const invalidFees = [
  ...["fastestFee", "halfHourFee", "hourFee"].flatMap((field) =>
    [undefined, null, "30", -1, NaN, Infinity, -Infinity].map((value) => ({
      label: `${field}=${String(value)}`,
      payload: { ...validFees, [field]: value },
      field
    }))
  ),
  ...[null, [], "fees", 30].map((payload) => ({ label: String(payload), payload, field: "response" }))
];

function setup() {
  let fees: unknown = validFees;
  let height = 100;
  const onSnapshot = vi.fn();
  const warn = vi.fn();
  vi.mocked(fetchJson).mockImplementation(async (url) => {
    if (url.endsWith("/mempool")) return { count: 1000 };
    if (url.endsWith("/recommended")) return fees;
    return { progressPercent: 50 };
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(String(height))));
  const ingestor = new OnchainIngestor(
    { onchainBaseUrl: "https://onchain.invalid/api" } as AppConfig,
    { warn } as unknown as Logger,
    onSnapshot
  );
  return {
    onSnapshot,
    warn,
    poll: () => (ingestor as unknown as { poll(): Promise<void> }).poll(),
    setFees: (value: unknown) => { fees = value; },
    setHeight: (value: number) => { height = value; }
  };
}

describe("OnchainIngestor recommended fees", () => {
  it.each(invalidFees)("rejects $label without changing the cadence baseline", async ({ payload, field }) => {
    const fixture = setup();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await fixture.poll();
    expect(fixture.onSnapshot).toHaveBeenCalledTimes(1);

    fixture.setFees(payload);
    fixture.setHeight(101);
    now.mockReturnValue(1_060_000);
    await fixture.poll();
    expect(fixture.onSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.warn).toHaveBeenCalledTimes(1);
    expect(fixture.warn.mock.calls[0]?.[0].error.message).toContain("/v1/fees/recommended");
    expect(fixture.warn.mock.calls[0]?.[0].error.message).toContain(field);

    fixture.setFees(validFees);
    fixture.setHeight(102);
    now.mockReturnValue(1_600_000);
    await fixture.poll();
    expect(fixture.onSnapshot).toHaveBeenCalledTimes(2);
    expect(fixture.onSnapshot.mock.calls[1]?.[0]).toMatchObject({
      ...validFees,
      tipHeight: 102,
      blockCadenceSeconds: 300
    });
  });

  it("accepts zero and fractional fee rates without coercion", async () => {
    const fixture = setup();
    const fees = { fastestFee: 1.5, halfHourFee: 0.5, hourFee: 0 };
    fixture.setFees(fees);
    await fixture.poll();
    expect(fixture.onSnapshot).toHaveBeenCalledWith(expect.objectContaining(fees));
    expect(fixture.warn).not.toHaveBeenCalled();
  });
});
