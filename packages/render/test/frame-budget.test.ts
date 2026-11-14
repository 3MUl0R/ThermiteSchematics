import { expect, it } from "vitest";
import {
  beginFramePlanning,
  compactPlanningReceipts,
  fieldLoss,
  frameField,
  frameBudgetFailure,
  frameBudgetOrder,
} from "../src/packet/frame-budget.js";
import { foldedBankProbes } from "../src/packet/frame-fold-groups.js";
import { legacyFramePlacement } from "../src/packet/frame-legacy-placement.js";
import { normalizePaperPage } from "../src/packet/page.js";
import { useCompactFrame } from "../src/packet/frame-profile.js";
import type { RootedCandidate } from "../src/packet/rooted-build.js";
import type { Draft, PaperPage } from "../src/packet/types.js";
function fixture() {
  const normalized = normalizePaperPage({
    size: "a4",
    orientation: "landscape",
  });
  if (!normalized.ok) throw Error("Invalid fixture page");
  const page = normalized.value;
  useCompactFrame(page);
  const view = {
    format: "schematic-view/0.1",
    root: { deviceUid: "fixture", designation: "X1" },
    family: "control",
    flow: "left-to-right",
  } as const;
  const draft: Draft = {
    title: {
      projectName: "Synthetic field",
      revision: "UNSPECIFIED",
      backgroundColor: "#ffffff",
      toolVersion: "test",
      lines: [],
    },
    view,
    content: "",
    links: [],
    note: "Synthetic field",
    drawingBounds: { x: 35, y: 35, w: 200, h: 120 },
    rootedShapes: [{ x: 50, y: 50, w: 10, h: 10 }],
  };
  const reference = {
    drafts: [draft, structuredClone(draft)],
    scale: 0.25,
    prepared: { view, graph: { view, nodes: [], edges: [] } },
    bank: {
      width: 20,
      headerWidth: 16,
      single: false,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    },
    grid: { xs: [0, 1, 2], ys: [0, 1] },
  } as unknown as RootedCandidate;
  beginFramePlanning(page, reference);
  return { page, reference };
}
function resized(reference: RootedCandidate, widths: number[]) {
  return {
    ...reference,
    drafts: reference.drafts.map((d, i) => ({
      ...d,
      drawingBounds: { x: 35, y: 35, w: widths[i] ?? 200, h: 120 },
    })),
  };
}
it("enforces each field independently without crediting another sheet's gain", () => {
  const { page, reference } = fixture();
  const legal = resized(reference, [196, 200]),
    illegal = resized(reference, [195.99, 250]);
  expect(frameBudgetFailure(legal, page)).toBeUndefined();
  expect(frameBudgetFailure(illegal, page)).toBe("drawing-field-loss");
  expect(frameBudgetOrder(legal, illegal, page)).toBeLessThan(0);
  expect(frameBudgetFailure({ ...reference, scale: 0.251 }, page)).toBe(
    "scale-change",
  );
  expect(
    frameBudgetFailure(
      { ...reference, drafts: reference.drafts.slice(0, 1) },
      page,
    ),
  ).toBe("page-count");
  expect(
    fieldLoss(
      frameField({ x: 0, y: 0, w: 100, h: 100 }),
      frameField({ x: 0, y: 0, w: 101, h: 100 }),
    ),
  ).toBe(0);
});
it("plans both cut sides for every part sharing a folded sheet", () => {
  const probes = [
    { links: [{ side: "left" }] },
    { links: [{ side: "right" }] },
  ] as unknown as Draft[];
  const result = foldedBankProbes(probes, [[0, 1]]);
  expect(result?.map((d) => d.links.map((l) => l.side))).toEqual([
    ["left", "right"],
    ["left", "right"],
  ]);
  expect(probes.map((d) => d.links.map((l) => l.side))).toEqual([
    ["left"],
    ["right"],
  ]);
});
it("retains legal legacy sheet geometry inside the compact frame with a receipt", () => {
  const { page, reference } = fixture(),
    before = structuredClone(reference.drafts);
  const result = legacyFramePlacement(reference, undefined, page);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.value.map((d) => ({
      ...d,
      drawingBounds: { ...d.drawingBounds, frameService: undefined },
    })),
  ).toEqual(
    before.map((d) => ({
      ...d,
      drawingBounds: { ...d.drawingBounds, frameService: undefined },
    })),
  );
  const [receipt] = compactPlanningReceipts(page);
  expect(receipt?.sheets.map((s) => [s.strategy, s.lossPercent])).toEqual([
    ["legacy-continuation-placement", 0],
    ["legacy-continuation-placement", 0],
  ]);
  expect(receipt?.fallback?.every((s) => !s.failure)).toBe(true);
});
it("refuses legacy placement that enters compact frame furniture and records its sheet", () => {
  const { page, reference } = fixture();
  reference.drafts[0]?.rootedShapes?.push({ x: 10, y: 50, w: 1, h: 1 });
  const result = legacyFramePlacement(reference, undefined, page);
  expect(result).toMatchObject({ ok: false, error: { code: "R006" } });
  const [receipt] = compactPlanningReceipts(page);
  expect(receipt?.termination).toBe("no-compatible-fallback");
  expect(receipt?.fallback?.[0]).toMatchObject({
    sheet: 1,
    lossPercent: 0,
    failure: expect.stringMatching(/frame furniture/),
  });
});

it("keeps a fitting sheet while falling back only its incompatible peer", () => {
  const { page, reference } = fixture(),
    modern = resized(reference, [196, 190]);
  const result = legacyFramePlacement(reference, modern, page);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.map((d) => d.drawingBounds?.w)).toEqual([196, 200]);
  const [receipt] = compactPlanningReceipts(page);
  expect(receipt?.sheets.map((s) => s.strategy)).toEqual([
    "folded-group",
    "legacy-continuation-placement",
  ]);
});
