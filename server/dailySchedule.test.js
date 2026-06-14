import assert from "node:assert/strict";
import test from "node:test";
import { nextDailyRunAt } from "./dailySchedule.js";

test("nextDailyRunAt schedules the same day before the configured hour", () => {
  const now = new Date(2026, 5, 14, 10, 20);
  const next = nextDailyRunAt(12, now);
  assert.deepEqual(
    [next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()],
    [now.getFullYear(), now.getMonth(), now.getDate(), 12, 0]
  );
});

test("nextDailyRunAt schedules the next day after the configured hour", () => {
  const now = new Date(2026, 5, 14, 10, 20);
  const next = nextDailyRunAt(0, now);
  assert.equal(next.getTime() - now.getTime(), 13 * 60 * 60 * 1000 + 40 * 60 * 1000);
  assert.equal(next.getHours(), 0);
});
