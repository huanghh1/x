import assert from "node:assert/strict";
import test from "node:test";
import { createAsyncCache } from "./asyncCache.js";

test("async cache deduplicates cold loads and serves fresh values", async () => {
  let loads = 0;
  const cache = createAsyncCache();
  const loader = async () => {
    loads += 1;
    return `value-${loads}`;
  };

  const [first, second] = await Promise.all([
    cache.get("menu", loader),
    cache.get("menu", loader)
  ]);

  assert.equal(first, "value-1");
  assert.equal(second, "value-1");
  assert.equal(await cache.get("menu", loader), "value-1");
  assert.equal(loads, 1);
});

test("async cache returns stale data immediately while refreshing", async () => {
  let clock = 0;
  let loads = 0;
  let releaseRefresh;
  const cache = createAsyncCache({
    ttlMs: 10,
    staleMs: 100,
    now: () => clock
  });
  const loader = async () => {
    loads += 1;
    if (loads === 1) return "old";
    await new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    return "new";
  };

  assert.equal(await cache.get("menu", loader), "old");
  clock = 20;
  assert.equal(await cache.get("menu", loader), "old");
  assert.equal(loads, 2);

  releaseRefresh();
  await cache.refresh("menu");
  assert.equal(await cache.get("menu", loader), "new");
});
