import assert from "node:assert/strict";
import { test } from "node:test";

import { RateLimiter } from "../src/rate-limit.ts";

test("a fixed window allows exactly limit calls, then denies until the window moves", () => {
  let now = 1_000;
  const limiter = new RateLimiter({ limit: 3, windowMs: 500, now: () => now });
  const decisions = [limiter.take("shop"), limiter.take("shop"), limiter.take("shop"), limiter.take("shop")];
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, true, false]);
  assert.equal(decisions[2]?.remaining, 0);
  assert.equal(decisions[3]?.retryAfterMs, 500);
  now = 1_499;
  assert.equal(limiter.take("shop").allowed, false);
  now = 1_500;
  const reset = limiter.take("shop");
  assert.equal(reset.allowed, true);
  assert.equal(reset.remaining, 2);
});

test("buckets are per client id", () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
  assert.equal(limiter.take("b").allowed, true);
});

test("prune drops windows that have elapsed", () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 1, windowMs: 100, now: () => now });
  limiter.take("a");
  limiter.take("b");
  assert.equal(limiter.prune(), 0);
  now = 100;
  assert.equal(limiter.prune(), 2);
});
