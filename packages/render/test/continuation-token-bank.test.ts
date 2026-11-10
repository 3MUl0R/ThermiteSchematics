import { expect, it, vi } from "vitest";
import * as plans from "../src/packet/rooted-plans.js";
import { continuationBanks } from "../src/packet/continuation-bank.js";
import type { PreparedSchematicDrawing } from "../src/renderer.js";

it("retains the measured longest-token bank and at most four deduplicated forms", () => {
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
    expect(banks).toHaveLength(4);
    expect(
      banks.some((b) => !b.single && Math.abs(b.width - 17.16) < 0.001),
    ).toBe(true);
    expect(new Set(banks.map((b) => JSON.stringify(b))).size).toBe(
      banks.length,
    );
    expect(banks.every((b) => b.headerWidth >= 16.314)).toBe(true);
  } finally {
    seed.mockRestore();
  }
});
