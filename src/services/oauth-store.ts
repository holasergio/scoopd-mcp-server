/**
 * OAuth authorization code store.
 *
 * Two implementations:
 *   - InMemoryOAuthStore (default) — Map with TTL cleanup. Lost on restart.
 *   - RedisOAuthStore — survives restart, supports horizontal scaling.
 *
 * Switch via env: OAUTH_STORE=redis (requires REDIS_URL).
 * Default: in-memory (no breaking change).
 */

import { Redis } from "ioredis";

export interface AuthCodeEntry {
  apiKey: string;
  codeChallenge: string;
  redirectUri: string;
  clientId?: string;
  expiresAt: number;
}

export interface OAuthStore {
  set(code: string, entry: AuthCodeEntry, ttlSec: number): Promise<void>;
  get(code: string): Promise<AuthCodeEntry | null>;
  delete(code: string): Promise<void>;
  close(): Promise<void>;
}

class InMemoryOAuthStore implements OAuthStore {
  private codes = new Map<string, AuthCodeEntry>();
  private cleanupHandle: NodeJS.Timeout;

  constructor() {
    this.cleanupHandle = setInterval(() => {
      const now = Date.now();
      for (const [code, entry] of this.codes) {
        if (entry.expiresAt < now) this.codes.delete(code);
      }
    }, 60_000);
    if (typeof this.cleanupHandle.unref === "function") this.cleanupHandle.unref();
  }

  async set(code: string, entry: AuthCodeEntry, _ttlSec: number): Promise<void> {
    this.codes.set(code, entry);
  }

  async get(code: string): Promise<AuthCodeEntry | null> {
    const entry = this.codes.get(code) ?? null;
    if (entry && entry.expiresAt < Date.now()) {
      this.codes.delete(code);
      return null;
    }
    return entry;
  }

  async delete(code: string): Promise<void> {
    this.codes.delete(code);
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupHandle);
    this.codes.clear();
  }
}

class RedisOAuthStore implements OAuthStore {
  private redis: Redis;
  private prefix = "scoopd:oauth:code:";

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async set(code: string, entry: AuthCodeEntry, ttlSec: number): Promise<void> {
    await this.redis.setex(this.prefix + code, ttlSec, JSON.stringify(entry));
  }

  async get(code: string): Promise<AuthCodeEntry | null> {
    const raw = await this.redis.get(this.prefix + code);
    if (!raw) return null;
    return JSON.parse(raw) as AuthCodeEntry;
  }

  async delete(code: string): Promise<void> {
    await this.redis.del(this.prefix + code);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

export async function createOAuthStore(): Promise<OAuthStore> {
  const mode = (process.env.OAUTH_STORE ?? "memory").toLowerCase();
  if (mode === "redis") {
    const url = process.env.REDIS_URL;
    if (!url) {
      console.error("[oauth-store] OAUTH_STORE=redis but REDIS_URL not set — falling back to in-memory");
      return new InMemoryOAuthStore();
    }
    try {
      const client = new Redis(url, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 2,
      });
      client.on("error", (err: Error) => console.error("[oauth-store] redis error:", err.message));
      console.error(`[oauth-store] using Redis at ${url.replace(/:[^:@]+@/, ":***@")}`);
      return new RedisOAuthStore(client);
    } catch (err) {
      console.error("[oauth-store] failed to instantiate Redis — falling back to in-memory:", err);
      return new InMemoryOAuthStore();
    }
  }
  console.error("[oauth-store] using in-memory store (lost on restart)");
  return new InMemoryOAuthStore();
}
