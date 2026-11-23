import { describe, expect, it, vi } from "vitest";
import {
  extractShardArg,
  listTestFiles,
  parseShard,
  partitionShard,
  shardWeight,
  sortDuration,
} from "./test-shards.mjs";

describe("test shard partitioning", () => {
  it("parses valid shard specifications and rejects invalid ones", () => {
    expect(parseShard("1/2")).toEqual({ index: 1, count: 2 });
    expect(parseShard("3/3")).toEqual({ index: 3, count: 3 });
    for (const bad of ["", "0/2", "3/2", "1/0", "-1/2", "1", "a/b", "1/2/3"]) {
      expect(() => parseShard(bad), bad).toThrow(/Invalid --shard/);
    }
    expect(extractShardArg(["--list-files", "--shard=1/2", "foo"])).toEqual({
      shard: "1/2",
      filters: ["foo"],
    });
    expect(extractShardArg(["--list-files", "--shard", "2/3"])).toEqual({
      shard: "2/3",
      filters: [],
    });
  });

  it("partitions items deterministically without drops or duplicates", () => {
    const items = [
      { id: "a", w: 400, g: "main" },
      { id: "b", w: 300, g: "main" },
      { id: "c", w: 200, g: "main" },
      { id: "d", w: 100, g: "main" },
      { id: "e", w: 50, g: "main" },
      { id: "f", w: 80, g: "limited" },
      { id: "g", w: 70, g: "limited" },
      { id: "h", w: 10, g: "limited" },
    ];
    for (const count of [1, 2, 3, 4]) {
      const shards = Array.from({ length: count }, (_, idx) =>
        partitionShard(items, idx + 1, count, {
          key: (x) => x.id,
          weight: (x) => x.w,
          group: (x) => x.g,
        }),
      );
      const flat = shards.flat().map((x) => x.id);
      expect(flat).toHaveLength(items.length);
      expect(new Set(flat)).toEqual(new Set(items.map((x) => x.id)));
      const reversed = partitionShard([...items].reverse(), 1, count, {
        key: (x) => x.id,
        weight: (x) => x.w,
        group: (x) => x.g,
      });
      expect(reversed.map((x) => x.id)).toEqual(shards[0].map((x) => x.id));
    }
  });

  it("balances weights across shards and reflects platform-specific durations", () => {
    expect(
      shardWeight("evals/agent/conveyor-exports.test.mjs", "darwin"),
    ).toBeGreaterThan(1000);
    expect(shardWeight("evals/agent/conveyor-exports.test.mjs", "win32")).toBe(
      0,
    );
    expect(sortDuration("nonexistent/unmeasured.test.ts")).toBe(0);
    expect(shardWeight("nonexistent/unmeasured.test.ts")).toBeGreaterThan(0);

    const synthetic = [
      { id: "t1", w: 100 },
      { id: "t2", w: 90 },
      { id: "t3", w: 80 },
      { id: "t4", w: 70 },
    ];
    const s1 = partitionShard(synthetic, 1, 2, {
      key: (x) => x.id,
      weight: (x) => x.w,
    });
    const s2 = partitionShard(synthetic, 2, 2, {
      key: (x) => x.id,
      weight: (x) => x.w,
    });
    const sum = (xs) => xs.reduce((total, x) => total + x.w, 0);
    expect(sum(s1)).toBe(170);
    expect(sum(s2)).toBe(170);
  });

  it("covers the complete repository test suite with disjoint shards", async () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("VITEST_MAX_WORKERS", undefined);
    try {
      for (const workers of ["2", "3"]) {
        vi.stubEnv("THERMITE_CI_MAX_WORKERS", workers);
        const full = await listTestFiles(["--list-files"]);
        expect(full.length).toBeGreaterThan(700);
        for (const count of [2, 3]) {
          const parts = await Promise.all(
            Array.from({ length: count }, (_, idx) =>
              listTestFiles(["--list-files", `--shard=${idx + 1}/${count}`]),
            ),
          );
          const union = parts.flat();
          expect(union).toHaveLength(full.length);
          expect([...new Set(union)].sort()).toEqual(full);
          for (const part of parts) expect(part.length).toBeGreaterThan(0);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
