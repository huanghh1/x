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

test("all source-mask combinations are ranked and labelled deterministically", () => {
  const sourceLabels = [
    [8, "资金费"],
    [4, "OI"],
    [2, "热度"],
    [1, "多周期"]
  ];

  for (const alertLevel of ["LEVEL1", "LEVEL2"]) {
    for (let mask = 1; mask <= 15; mask += 1) {
      const profile = resolveSignalProfile({
        fundingOneHour: Boolean(mask & 8),
        oiSpike: Boolean(mask & 4),
        hotRank: Boolean(mask & 2),
        multiCycleCount: mask & 1 ? 3 : 0,
        alertLevel
      });
      const expectedSources = sourceLabels.filter(([bit]) => mask & bit).map(([, label]) => label);
      const expectedLevelLabel = alertLevel === "LEVEL1" ? "一级警报" : "二级警报";

      assert.equal(profile.key, `COMBO_${mask}_${alertLevel}`);
      assert.equal(profile.sourceMask, mask);
      assert.deepEqual(profile.sources, expectedSources);
      assert.equal(profile.label, `${expectedSources.join(" + ")} · ${expectedLevelLabel}`);
      assert.equal(profile.priority, (15 - mask) * 2 + (alertLevel === "LEVEL2" ? 1 : 0));
    }
  }
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
  assert.equal(resolveSignalProfile({ hotRank: true, multiCycleCount: 4 }).key, "NONE");
});

test("only OI can be displayed independently without MA alerts", () => {
  assert.equal(resolveSignalProfile({ fundingOneHour: true }).key, "NONE");
  assert.deepEqual(
    resolveSignalProfile({ oiSpike: true }),
    {
      key: "STANDALONE_4",
      label: "OI · 独立信号",
      priority: SIGNAL_PRIORITY.STANDALONE,
      multi: false,
      sourceMask: 4,
      sources: ["OI"],
      standalone: true
    }
  );
});

test("standalone OI is grouped with the OI signal priorities", () => {
  const standaloneOi = resolveSignalProfile({ oiSpike: true });
  const oiLevel1 = resolveSignalProfile({ oiSpike: true, alertLevel: "LEVEL1" });
  const oiLevel2 = resolveSignalProfile({ oiSpike: true, alertLevel: "LEVEL2" });
  const heatMultiLevel1 = resolveSignalProfile({ hotRank: true, multiCycleCount: 3, alertLevel: "LEVEL1" });

  assert.ok(standaloneOi.priority > oiLevel1.priority);
  assert.equal(standaloneOi.priority, oiLevel2.priority);
  assert.ok(standaloneOi.priority < heatMultiLevel1.priority);
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
