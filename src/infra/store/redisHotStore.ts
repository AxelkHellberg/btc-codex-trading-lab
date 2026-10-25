import { Redis } from "ioredis";
import type { Logger } from "pino";

export class RedisHotStore {
  private readonly redis: Redis;
  private readonly ready: Promise<void>;
  private unavailable = false;

  public constructor(url: string, private readonly logger: Logger) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 0,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      retryStrategy: () => null
    });
    this.redis.on("error", (error: unknown) => {
      // Only known transport codes are safe to log; errors can contain URLs or command arguments.
      const knownCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"];
      const code = error !== null && typeof error === "object" && "code" in error
        && typeof error.code === "string" && knownCodes.includes(error.code)
        ? error.code : "UNKNOWN";
      this.logger.warn({ code }, "Redis connection error");
    });
    this.ready = this.redis.connect();
    // Construction may precede the first command; keep a rejected readiness
    // promise observable by operations without an unhandled rejection.
    void this.ready.catch(() => {});
  }

  private async perform<T>(command: () => Promise<T>): Promise<T> {
    if (this.unavailable) throw new Error("Redis store unavailable; restart required");
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          await this.ready;
          if (this.unavailable) throw new Error("Redis store unavailable; restart required");
          return command();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Redis operation exceeded 5000ms; outcome may be unknown")), 5_000);
        })
      ]);
    } catch (error) {
      // A failed command may already have executed. Discard the connection and
      // reject future work rather than replaying queued writes or lock requests.
      this.unavailable = true;
      this.redis.disconnect(false);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  public async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.perform(() => this.redis.set(key, payload, "EX", ttlSeconds));
      return;
    }

    await this.perform(() => this.redis.set(key, payload));
  }

  public async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.perform(() => this.redis.set(key, token, "PX", ttlMs, "NX"));
    return result === "OK";
  }

  // Security fix: Use atomic Lua script to prevent race condition in lock release
  public async releaseLock(key: string, token: string): Promise<void> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.perform(() => this.redis.eval(luaScript, 1, key, token));
  }

  public async close(): Promise<void> {
    if (this.unavailable) return;
    try {
      await this.perform(() => this.redis.quit());
    } catch {
      this.logger.warn("Redis shutdown failed; connection disconnected");
    } finally {
      this.unavailable = true;
      this.redis.disconnect(false);
    }
  }
}
