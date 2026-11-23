import { afterEach, expect, it, vi } from "vitest";
import type { ElectricalIr } from "@thermite/compiler";
import { sideSections } from "../src/packet/fold-side.js";
import { composeRootedWinner } from "../src/packet/rooted-compose.js";
import { compositionFits } from "../src/packet/composition-fit.js";
import { postTrimCaptionConstraint } from "../src/packet/rooted-caption.js";
import * as emitter from "../src/svg/emitter.js";
import { sideLocation } from "./helpers/side-location.js";
import { sidePage } from "./helpers/side-candidate.js";
const ir = {} as ElectricalIr;
afterEach(() => vi.restoreAllMocks());
it("checks a caption that only becomes too long after horizontal trimming", () => {
  const { candidate: c, inner } = sideLocation(6);
  expect(c.drafts.every((d) => !d.continuedCaption)).toBe(true);
  expect(compositionFits(c, c, sidePage)).toBe(true);
  const trimmed = sideSections(c, inner)!;
  expect(trimmed[0]!.continuedCaption).toContain("LOCATION-5");
  expect(postTrimCaptionConstraint(trimmed, sidePage)).toMatch(/header width/u);
  vi.spyOn(emitter, "emitSchematicSvg").mockReturnValue({
    ok: true,
    value: `<svg>${inner}</svg>`,
  });
  expect(composeRootedWinner(ir, c, c, sidePage)).toBe(c);
});
it("omits only the original heading wholly outside all final horizontal viewports", () => {
  const { candidate: c, inner } = sideLocation(1, 0, 200, 100);
  expect(c.drafts[0]!.content).toContain('class="label-location"');
  vi.spyOn(emitter, "emitSchematicSvg").mockReturnValue({
    ok: true,
    value: `<svg>${inner}</svg>`,
  });
  const selected = composeRootedWinner(ir, c, c, sidePage);
  expect(selected).not.toBe(c);
  expect(selected.drafts[0]!.content).toContain("CONTINUED LOCATION: FIELD");
  expect(selected.drafts[0]!.content).not.toContain('class="label-location"');
  expect(c.drafts[0]!.content).toContain('class="label-location"');
});
it("expands a partly intersected X heading and retains the original text", () => {
  const { candidate: c, inner } = sideLocation(1, 90, 300);
  vi.spyOn(emitter, "emitSchematicSvg").mockReturnValue({
    ok: true,
    value: `<svg>${inner}</svg>`,
  });
  const selected = composeRootedWinner(ir, c, c, sidePage);
  expect(selected).not.toBe(c);
  expect(selected.drafts[0]!.rootedSections![0]!.viewport.x).toBeLessThan(90);
  expect(selected.drafts[0]!.content).toContain('class="label-location"');
});
it("never partly reveals an outside heading when side-fold continuation link padding widens a strip (#570 review)", () => {
  // Heading spans x=20..85, wholly outside tight envelope x=95.25..144.75,
  // while raw link padding would move left to ~84.11 (cutting through FIELD).
  const { candidate: c, inner } = sideLocation(1, 20, 300, 40);
  const tight = sideSections(c, inner, false)!;
  expect(tight[0]!.rootedSections![0]!.viewport.x).toBeGreaterThan(85 + 0.002);
  expect(tight[0]!.continuedCaption).toContain("FIELD");

  const padded = sideSections(c, inner, true)!;
  const view = padded[0]!.rootedSections![0]!.viewport;
  // Whole-heading rule: FIELD [20, 85] must be either wholly inside or wholly outside.
  const whollyInside = view.x <= 20 && view.x + view.w >= 85;
  const whollyOutside = view.x > 85 + 0.002 || view.x + view.w < 20 - 0.002;
  expect(whollyInside || whollyOutside).toBe(true);
});
