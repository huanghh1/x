import assert from "node:assert/strict";
import test from "node:test";
import { resolveBestAlertLevel, resolveSignalProfile, SIGNAL_PRIORITY } from "./signalPriority.js";

test("signal priority follows the complete funding, OI, heat, multi-cycle order", () => {
  const cases = [
    [{ fundingOneHour: true, oiSpike: true, hotRank: true, multiCycleCount: 3, alertLevel: "LEVEL1" }, 0],
    [{ fundingOneHour: true, oiSpike: true, hotRank: true, alertLevel: "LEVEL1" }, 2],
    [{ fundingOneHour: true, oiSpike: true, multiCycleCount: 3, alertLevel: "LEVEL1" }, 4],
    [{ fundingOneHour: true, oiSpike: true, alertLevel: "LEVEL1" }, 6],
    [{ hotRank: true, multiCycleCount: 3, alertLevel: "LEVEL1" }, 24],
    [{ alertLevel: "LEVEL1" }, "LEVEL1"],
    [{ alertLevel: "LEVEL2" }, "LEVEL2"]
  ];
  const priorities = cases.map(([input, expected]) => {
    const result = resolveSignalProfile(input);
    if (typeof expected === "string") assert.equal(result.key, expected);
    else assert.equal(result.priority, expected);
    return result.priority;
  });
  assert.deepEqual(priorities, [0, 2, 4, 6, 24, SIGNAL_PRIORITY.LEVEL1, SIGNAL_PRIORITY.LEVEL2]);
});

test("an OI spike can participate in page combinations", () => {
  const profile = resolveSignalProfile({
    oiSpike: true,
    oiMatched: true,
    hotRank: true,
    alertLevel: "LEVEL1"
  });

  assert.equal(profile.label, "OI + 热度 · 一级警报");
  assert.deepEqual(profile.sources, ["OI", "热度"]);
});

test("source combinations are invalid without an MA alert", () => {
  assert.equal(resolveSignalProfile({ fundingOneHour: true, oiSpike: true, hotRank: true, multiCycleCount: 4 }).key, "NONE");
  assert.equal(resolveSignalProfile({ multiCycleCount: 4, alertLevel: "LEVEL2" }).label, "多周期 · 二级警报");
});

test("the composite profile uses the highest MA level across intervals", () => {
  const bestAlertLevel = resolveBestAlertLevel([
    { alertLevel: "LEVEL2" },
    { signal: { alertLevel: "LEVEL1" } },
    "LEVEL2"
  ]);
  assert.equal(bestAlertLevel, "LEVEL1");
  assert.equal(
    resolveSignalProfile({ hotRank: true, multiCycleCount: 3, alertLevel: bestAlertLevel }).label,
    "热度 + 多周期 · 一级警报"
  );
});
