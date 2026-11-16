import { describe, expect, test } from "vitest";
import { baselineRevision, validateBaseline } from "../check-perf.mjs";
import { comparison, measurePair, median } from "./measure.mjs";

function worker(side, calls, overrides = {}) {
  return {
    sample: async ({ name, operation }) => {
      calls.push(`${side}/${name}/${operation}`);
      return {
        ms: 100,
        sha256: `${side}/${name}/${operation}`,
        inputSha256: name,
        views: name === "machine-demo" ? 12 : 4,
        ...overrides,
      };
    },
  };
}
describe("per-PR performance guard", () => {
  test("accepts +20%, fails any larger compile or packet regression", async () => {
    expect(comparison(100, 120).pass).toBe(true);
    expect(comparison(100, 120.001).pass).toBe(false);
    for (const bad of [0, -1, NaN, Infinity])
      expect(() => comparison(100, bad)).toThrow();
    const calls = [];
    const result = await measurePair(
      worker("base", calls),
      worker("head", calls, { ms: 121 }),
      3,
    );
    expect(result.pass).toBe(false);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((r) => !r.pass && r.ratio === 1.21)).toBe(true);
  });
  test("excludes warmup and alternates engines without overlapping work", async () => {
    const calls = [];
    const base = worker("base", calls);
    const head = worker("head", calls);
    const sample = head.sample;
    let i = 0;
    head.sample = async (request) => ({
      ...(await sample(request)),
      ms: i++ % 4 === 0 ? 10000 : 100,
    });
    const result = await measurePair(base, head, 3);
    expect(result.pass).toBe(true);
    expect(result.rows.every((r) => r.headMedianMs === 100)).toBe(true);
    expect(calls.slice(0, 8).map((s) => s.split("/")[0])).toEqual([
      "base",
      "head",
      "head",
      "base",
      "base",
      "head",
      "head",
      "base",
    ]);
    expect(result.rows[0].observations.head[0].warmup).toBe(true);
    expect(result.rows[0].observations.head[1].warmup).toBe(false);
    expect(result.rows[0].observations.head[1].loadBefore).toHaveLength(3);
    expect(median([9, 1, 3])).toBe(3);
    expect(median([9, 1, 3, 5])).toBe(4);
  });
  test("rejects changed inputs, wrong view counts and nondeterministic output", async () => {
    for (const overrides of [{ inputSha256: "changed" }, { views: 2 }])
      await expect(
        measurePair(worker("base", []), worker("head", [], overrides), 3),
      ).rejects.toThrow();
    const head = worker("head", []);
    const sample = head.sample;
    let n = 0;
    head.sample = async (request) => ({
      ...(await sample(request)),
      sha256: `${n++}`,
    });
    await expect(measurePair(worker("base", []), head, 3)).rejects.toThrow(
      "nondeterministic",
    );
    await expect(
      measurePair(worker("base", []), worker("head", []), 0),
    ).rejects.toThrow();
  });
  test("requires pinned revision, machine class, and all four baseline medians", async () => {
    const baseline = {
      format: "thermite-perf-baseline/1",
      revision: baselineRevision,
      machine: { cpu: "test" },
      measurement: await measurePair(worker("base", []), worker("head", []), 3),
    };
    expect(() => validateBaseline(baseline, baseline.machine)).not.toThrow();
    expect(() => validateBaseline(baseline, { cpu: "other" })).toThrow();
    expect(() =>
      validateBaseline({ ...baseline, revision: "other" }, baseline.machine),
    ).toThrow();
    baseline.measurement.rows.pop();
    expect(() => validateBaseline(baseline, baseline.machine)).toThrow();
  });
});
