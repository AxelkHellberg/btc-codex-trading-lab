import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStateStore } from "./postgresStateStore.js";

const databaseUrl = process.env.NEWS_DEDUPE_TEST_DATABASE_URL;
// Opt in only against a disposable local database: init creates the application tables.
describe.skipIf(!databaseUrl)("Postgres news acknowledgements", () => {
  let store: PostgresStateStore;
  const scope = `test-${process.pid}-${Date.now()}`;
  const first = "a".repeat(40); const second = "b".repeat(40);
  const makeStore = () => new PostgresStateStore(databaseUrl!, { warn() {} } as unknown as Logger);
  beforeAll(async () => { store = makeStore(); await store.init(); });
  afterAll(async () => { await store.close(); });
  it("starts empty for an unknown scope", async () => {
    expect(await store.loadAcknowledgedNews(scope)).toEqual([]);
  });
  it("persists across a fresh store connection and isolates scopes", async () => {
    await store.saveAcknowledgedNews(scope, [first]);
    await store.close(); store = makeStore();
    expect(await store.loadAcknowledgedNews(scope)).toEqual([first]);
    expect(await store.loadAcknowledgedNews(`${scope}-other`)).toEqual([]);
  });
  it("upserts the current window rather than appending obsolete windows", async () => {
    await store.saveAcknowledgedNews(scope, [second]);
    expect(await store.loadAcknowledgedNews(scope)).toEqual([second]);
  });
  it("rejects a corrupt stored window", async () => {
    await store.saveAcknowledgedNews(scope, ["corrupt"]);
    await expect(store.loadAcknowledgedNews(scope)).rejects.toThrow("Invalid persisted");
  });
});
