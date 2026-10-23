import { Redis } from "ioredis";
import type { Logger } from "pino";

export class RedisHotStore {
  private readonly redis: Redis;

  public constructor(url: string, private readonly logger: Logger) {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false
    });
    this.redis.on("error", (error: unknown) => {
      // Only known transport codes are safe to log; errors can contain URLs or command arguments.
      const knownCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE"];
      const code = error !== null && typeof error === "object" && "code" in error
        && typeof error.code === "string" && knownCodes.includes(error.code)
        ? error.code : "UNKNOWN";
      this.logger.warn({ code }, "Redis connection error");
    });
  }

  public async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds) {
      await this.redis.set(key, payload, "EX", ttlSeconds);
      return;
    }

    await this.redis.set(key, payload);
  }

  public async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, token, "PX", ttlMs, "NX");
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
    await this.redis.eval(luaScript, 1, key, token);
  }

  public async close(): Promise<void> {
    await this.redis.quit().catch((error: unknown) => {
      this.logger.warn({ error }, "Failed to close Redis connection");
    });
  }
}
