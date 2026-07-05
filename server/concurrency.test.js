import assert from "node:assert/strict";
import test from "node:test";
import { mapLimit, normalizeConcurrency } from "./concurrency.js";

test("normalizeConcurrency clamps invalid and excessive values", () => {
  assert.equal(normalizeConcurrency("bad", { fallback: 2, max: 5 }), 2);
  assert.equal(normalizeConcurrency(0, { fallback: 2, max: 5 }), 1);
  assert.equal(normalizeConcurrency(10, { fallback: 2, max: 5 }), 5);
});

test("mapLimit preserves order and caps active workers", async () => {
  let active = 0;
  let peak = 0;
  const release = [];
  const tasks = [1, 2, 3, 4, 5];
  const mapped = mapLimit(tasks, 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => release.push(resolve));
    active -= 1;
    return value * 10;
  });

  while (release.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 2);
  for (const resolve of release.splice(0)) resolve();
  while (release.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, 2);
  for (const resolve of release.splice(0)) resolve();
  while (release.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const resolve of release.splice(0)) resolve();

  const results = await mapped;
  assert.deepEqual(results.map((item) => item.value), [10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
});
