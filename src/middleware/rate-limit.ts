/**
 * Sliding-window rate limiter for /oauth/* endpoints.
 *
 * Backed by Redis (if REDIS_URL set) with in-memory fallback.
 * Default disabled — set OAUTH_RATE_LIMIT=true to enable.
 *
 * Limits (per IP):
 *   POST /oauth/register  → 5/hour   (prevent client_id flood)
 *   GET  /oauth/authorize → 30/min   (page load)
 *   POST /oauth/authorize → 10/min   (prevent API key brute-force)
 *   POST /oauth/token     → 20/min
 */

import type { Request, Response, NextFunction } from "express";
import { Redis } from "ioredis";

interface Bucket {
  windowStart: number;
  count: number;
}

interface Limiter {
  check(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number; retryAfter: number }>;
}

class InMemoryLimiter implements Limiter {
  private buckets = new Map<string, Bucket>();
  private cleanupHandle: NodeJS.Timeout;

  constructor() {
    this.cleanupHandle = setInterval(() => {
      const cutoff = Date.now() - 3_600_000;
      for (const [key, bucket] of this.buckets) {
        if (bucket.windowStart < cutoff) this.buckets.delete(key);
      }
    }, 300_000);
    if (typeof this.cleanupHandle.unref === "function") this.cleanupHandle.unref();
  }

  async check(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }

    bucket.count += 1;
    const remaining = Math.max(0, limit - bucket.count);
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }
    return { allowed: true, remaining, retryAfter: 0 };
  }
}

class RedisLimiter implements Limiter {
  private redis: Redis;
  private prefix = "scoopd:ratelimit:";

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async check(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
    const fullKey = this.prefix + key;
    const count = await this.redis.incr(fullKey);
    if (count === 1) await this.redis.expire(fullKey, windowSec);
    const ttl = count > 1 ? await this.redis.ttl(fullKey) : windowSec;
    const remaining = Math.max(0, limit - count);
    if (count > limit) {
      return { allowed: false, remaining: 0, retryAfter: Math.max(1, ttl) };
    }
    return { allowed: true, remaining, retryAfter: 0 };
  }
}

let limiterPromise: Promise<Limiter> | null = null;

async function getLimiter(): Promise<Limiter> {
  if (limiterPromise) return limiterPromise;
  limiterPromise = (async () => {
    const useRedis = (process.env.OAUTH_STORE ?? "memory").toLowerCase() === "redis" && !!process.env.REDIS_URL;
    if (useRedis) {
      try {
        const client = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false, maxRetriesPerRequest: 2 });
        client.on("error", (err: Error) => console.error("[rate-limit] redis error:", err.message));
        return new RedisLimiter(client);
      } catch (err) {
        console.error("[rate-limit] failed to instantiate Redis — using in-memory:", err);
      }
    }
    return new InMemoryLimiter();
  })();
  return limiterPromise;
}

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

export function rateLimit(opts: { limit: number; windowSec: number; keyPrefix: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if ((process.env.OAUTH_RATE_LIMIT ?? "false").toLowerCase() !== "true") {
      return next();
    }
    try {
      const limiter = await getLimiter();
      const key = `${opts.keyPrefix}:${clientIp(req)}`;
      const result = await limiter.check(key, opts.limit, opts.windowSec);
      res.setHeader("X-RateLimit-Limit", String(opts.limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryAfter));
        res.status(429).json({ error: "rate_limit_exceeded", retry_after: result.retryAfter });
        return;
      }
      next();
    } catch (err) {
      console.error("[rate-limit] check failed, allowing request:", err);
      next();
    }
  };
}

export const oauthRateLimits = {
  register: rateLimit({ limit: 5, windowSec: 3600, keyPrefix: "oauth:register" }),
  authorizeGet: rateLimit({ limit: 30, windowSec: 60, keyPrefix: "oauth:authorize:get" }),
  authorizePost: rateLimit({ limit: 10, windowSec: 60, keyPrefix: "oauth:authorize:post" }),
  token: rateLimit({ limit: 20, windowSec: 60, keyPrefix: "oauth:token" }),
};
