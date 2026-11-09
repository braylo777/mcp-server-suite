export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window ends. 0 when the call was allowed. */
  retryAfterMs: number;
  windowMs: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * Fixed-window counter, one bucket per key, stored in memory.
 * The window starts at the first call after the previous window elapsed.
 * This is not a sliding window: a client can send `limit` calls at the end of
 * one window and `limit` more at the start of the next.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  readonly limit: number;
  readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error("rate limit must be an integer >= 1");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("rate limit window must be an integer number of milliseconds >= 1");
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  take(key: string): RateDecision {
    if (key.length === 0) throw new Error("rate limit key is empty");
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.limit) {
      const retryAfterMs = bucket.windowStart + this.windowMs - now;
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        retryAfterMs: Math.max(0, retryAfterMs),
        windowMs: this.windowMs,
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - bucket.count,
      retryAfterMs: 0,
      windowMs: this.windowMs,
    };
  }

  /** Drops buckets whose window has elapsed. Called so a long-lived process does not keep every client id forever. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

export function rateLimiterFromEnv(env: NodeJS.ProcessEnv, now?: () => number): RateLimiter {
  return new RateLimiter({
    limit: readPositiveInt(env.MCP_RATE_LIMIT, 60, "MCP_RATE_LIMIT"),
    windowMs: readPositiveInt(env.MCP_RATE_WINDOW_MS, 60_000, "MCP_RATE_WINDOW_MS"),
    now,
  });
}

export function authFailLimiterFromEnv(env: NodeJS.ProcessEnv, now?: () => number): RateLimiter {
  return new RateLimiter({
    limit: readPositiveInt(env.MCP_AUTH_FAIL_LIMIT, 20, "MCP_AUTH_FAIL_LIMIT"),
    windowMs: readPositiveInt(env.MCP_RATE_WINDOW_MS, 60_000, "MCP_RATE_WINDOW_MS"),
    now,
  });
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a positive integer. Got ${JSON.stringify(value)}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer. Got ${JSON.stringify(value)}.`);
  }
  return parsed;
}
