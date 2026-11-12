import { expect, it, vi } from "vitest";
import * as plans from "../src/packet/rooted-plans.js";
import { labelMetrics } from "../src/packet/label-text.js";
import { continuationBanks } from "../src/packet/continuation-bank.js";
import type { PreparedSchematicDrawing } from "../src/renderer.js";

it("reserves the full identity and keeps one uniform form in each bank", () => {
  const uid = "15400000-0000-4000-8000-000000000202";
  const prepared = {
    graph: {
      edges: [
        {
          id: "j",
          kind: "conductor",
          elementIds: [{ kind: "jumper", uid }],
          conductor: { kind: "jumper", uid },
        },
      ],
    },
    layout: {
      edges: [
        {
          id: "j",
          points: [
            { x: 0, y: 50 },
            { x: 200, y: 50 },
          ],
        },
      ],
    },
  } as unknown as PreparedSchematicDrawing;
  const seed = vi
    .spyOn(plans, "rootedGrids")
    .mockReturnValue([{ xs: [0, 100, 200], ys: [0, 100] }]);
  try {
    const banks = continuationBanks(
      prepared,
      { x: 28, y: 47, w: 376, h: 180 },
      0.25,
    );
    expect(banks).toHaveLength(2);
    expect(banks.every((b) => b.width >= labelMetrics(uid).width)).toBe(true);
    expect(new Set(banks.map((b) => JSON.stringify(b))).size).toBe(
      banks.length,
    );
    expect(banks.every((b) => b.headerWidth >= 16.314)).toBe(true);
  } finally {
    seed.mockRestore();
  }
});
