// Counter-store DI seam for chunk 7 rate-wall middleware.
//
// One interface, two adapters:
//   - InMemoryCounter: process-local Map; resets on dev-server restart.
//     Used when UPSTASH_REDIS_REST_URL is not set (local dev without creds).
//   - UpstashCounter:  @upstash/redis REST mode; edge-runtime compatible.
//     Used when both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.
//
// Switching is env-driven: presence of the URL flips production-stub to real.
// Same `incrWithTTL(key, ttl)` contract on both: returns the post-increment
// count and ensures the key has a TTL set (on first INCR; later INCRs leave
// the existing TTL alone).

import { Redis } from '@upstash/redis';

export interface CounterStore {
  incrWithTTL(key: string, ttlSeconds: number): Promise<number>;
}

type Entry = { count: number; expiresAt: number };

class InMemoryCounter implements CounterStore {
  private data = new Map<string, Entry>();

  async incrWithTTL(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const existing = this.data.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.data.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
}

class UpstashCounter implements CounterStore {
  private redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token });
  }

  async incrWithTTL(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    return count;
  }
}

let cached: CounterStore | null = null;

export function getCounterStore(): CounterStore {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    cached = new UpstashCounter(url, token);
  } else {
    cached = new InMemoryCounter();
  }
  return cached;
}
