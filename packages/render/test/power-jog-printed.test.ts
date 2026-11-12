import { afterEach, expect, it, vi } from "vitest";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import * as retry from "../src/packet/rooted-jog-repair.js";

afterEach(() => vi.restoreAllMocks());
it("leaves the recovered jog-free A3 compact TB packet identical with or without the retry", async () => {
  const c = await compileProject("examples/motor-starter");
  if (!c.ok) throw Error("Compile failed");
  const request = {
    format: "schematic-packet-request/0.1" as const,
    layout: "compact" as const,
    page: { size: "a3" as const, orientation: "landscape" as const },
    views: (["M1", "K1"] as const).map((value) => ({
      format: "schematic-view-request/0.1" as const,
      family: value === "M1" ? ("power" as const) : ("control" as const),
      flow: "top-to-bottom" as const,
      root: { by: "designation" as const, value },
    })),
  };
  const actual = await renderSchematicPacket(c.ir, request, c.presentation);
  if (!actual.ok) throw Error(actual.error.message);
  vi.spyOn(retry, "repairSearchJogs").mockResolvedValue(undefined);
  const ordinary = await renderSchematicPacket(c.ir, request, c.presentation);
  expect(actual).toEqual(ordinary);
  expect(actual.value.sheets).toHaveLength(2);
}, 30000);

it.each([
  ["motor-starter", "M1", false],
  ["machine-demo", "M2", true],
] as const)(
  "counts every %s recovery and retry in the existing placement budget",
  async (project, value, compact) => {
    const c = await compileProject("examples/" + project);
    if (!c.ok) throw Error("Compile failed");
    const prepared = await import("../src/off-view/prepared.js");
    const search = await import("../src/packet/rooted-search.js");
    const layouts = vi.spyOn(prepared, "repositionDrawing");
    const run = await search.searchRootedCandidates(
      c.ir,
      {
        format: "schematic-view-request/0.1",
        family: "power",
        flow: "top-to-bottom",
        root: { by: "designation", value },
      },
      c.presentation,
      {
        size: "tabloid",
        orientation: "landscape",
        widthMm: 431.8,
        heightMm: 279.4,
        marginMm: 10,
      },
      compact,
    );
    expect(layouts).toHaveBeenCalledTimes(run.attempts);
    expect(run.attempts).toBeLessThanOrEqual(search.MAX_PLACEMENT_LAYOUTS);
    expect(run.jogRetryReserved).toBeUndefined();
  },
  30000,
);
