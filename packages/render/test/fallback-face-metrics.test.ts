import { beforeAll, describe, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import {
  measureText,
  printableTextInkMetrics,
  printableTextLeftOverhang,
  printableTextMetrics,
  printableTextRightExtent,
  printableTextWidth,
} from "../src/text-metrics.js";
import {
  FIELD_TEXT_LEFT_SAFETY_MM,
  fieldTextLeft,
  fieldTextLeftShift,
  fieldTextRightExtent,
} from "../src/packet/svg.js";
import { labelMetrics } from "../src/packet/label-text.js";
import { cableRowPlan } from "../src/packet/cable-row-plan.js";
import {
  captionConstraint,
  continuedCaptionY,
  textInk,
} from "../src/packet/rooted-caption.js";
import { continuationInkFailure } from "../src/packet/continuation-fit.js";
import {
  continuationHeaderWidth,
  continuationLabel,
} from "../src/packet/continuation-label.js";
import { bounds, normalizePaperPage } from "../src/packet/page.js";
import { useCompactFrame } from "../src/packet/frame-profile.js";
import { compactFramePlan } from "../src/packet/frame-plan.js";
import {
  rootedNoticeLines,
  rootedSheetNoticeWidth,
  rootedSheetNoticeX,
} from "../src/off-view/notice.js";
import {
  channelRowSlots,
  circuitTextLines,
} from "../src/symbols/circuit-text.js";
import { renderSchematicPacket } from "../src/sheets.js";
import type { NormalizedSchematicView } from "../src/types.js";
import type { Draft, Link, PaperPage } from "../src/packet/types.js";

function makeLetterPortrait(compact = false): PaperPage {
  const normalized = normalizePaperPage({
    size: "letter",
    orientation: "portrait",
    marginMm: 10,
  });
  if (!normalized.ok) throw Error(normalized.error.message);
  if (compact) useCompactFrame(normalized.value);
  return normalized.value;
}

const letterPortrait: PaperPage = makeLetterPortrait();

const sampleTitle = {
  projectName: "Fallback Probe",
  revision: "A",
  toolVersion: "test",
  lines: [],
};

function rootedCableView(designation: string): NormalizedSchematicView {
  return {
    format: "schematic-view/0.1",
    root: { deviceUid: "dev-1", designation },
    family: "control",
    flow: "top-to-bottom",
  };
}

function makeTopLink(x: number, y: number): Link {
  const link: Link = {
    id: "C001",
    to: 2,
    toZone: "A1",
    conductor: "W1",
    netId: "N1",
    x,
    y,
    side: "top",
  };
  link.label = continuationLabel(link, 18, continuationHeaderWidth(1), false);
  return link;
}

describe("fallback-face left start reserve (#555)", () => {
  it("reserves 0.5 em left bearing for leading fallback clusters without shifting bundled starts", () => {
    for (const size of [2.5, 2.7, 3, 3.5, 4]) {
      expect(printableTextLeftOverhang("🌐 test", size)).toBeCloseTo(
        0.5 * size,
        6,
      );
      expect(fieldTextLeftShift("🌐 test", size)).toBe(
        Math.ceil((0.5 * size + FIELD_TEXT_LEFT_SAFETY_MM) * 1000) / 1000,
      );
      expect(fieldTextRightExtent("🌐 test", size)).toBeGreaterThanOrEqual(
        fieldTextLeftShift("🌐 test", size) +
          measureText("🌐 test", size).width,
      );
    }

    // Narrow bundled prefix whose advance < 0.5 em also gets protected.
    expect(printableTextLeftOverhang("i🌐 test", 2.5)).toBeGreaterThan(0.5);
    // Normal bundled prefixes keep zero shift.
    expect(printableTextLeftOverhang("A 🌐 test", 2.5)).toBe(0);
    expect(fieldTextLeftShift("A 🌐 test", 2.5)).toBe(0);
    expect(printableTextLeftOverhang("Field 🌐", 3, true)).toBe(0);
    expect(fieldTextLeft(28, "CABLE CBL1", 4, true)).toBe(28);
  });

  it("keeps bundled-only strings identical across metrics and ink helpers", () => {
    const samples = [
      "CABLE CBL1",
      "JB1.X1.1",
      "MAIN-PANEL",
      "A  B e\u0301 Ω",
      "𝒿B1 — order unspecified; declaration listing",
    ];
    for (const sample of samples) {
      for (const bold of [false, true]) {
        const raw = printableTextMetrics(sample, 2.7, bold);
        expect(printableTextInkMetrics(sample, 2.7, bold)).toStrictEqual(raw);
        expect(printableTextWidth(sample, 2.7, bold)).toBe(
          Math.max(raw.advance, raw.right) - Math.min(0, raw.left),
        );
      }
      const lit = printableTextMetrics(sample, 2.5, false, true);
      expect(labelMetrics(sample, 2.5).width).toBe(
        Math.max(lit.advance, lit.right) - Math.min(0, lit.left),
      );
      expect(printableTextRightExtent(sample, 2.5, false)).toBe(
        printableTextMetrics(sample, 2.5, false).right,
      );
    }
  });
});

describe("fallback-face fit and collision paths (#556)", () => {
  it("budgets cable End B heading, End B endpoint row, and centered core rows with fallback widths", () => {
    const endBLoc = "Field " + "🌐".repeat(19);
    const bundledEndB = printableTextMetrics(endBLoc, 3, true);
    expect(Math.max(bundledEndB.advance, bundledEndB.right)).toBeLessThan(
      47.965,
    );
    expect(printableTextWidth(endBLoc, 3, true)).toBeCloseTo(
      measureText(endBLoc, 3).width,
      3,
    );
    expect(printableTextWidth(endBLoc, 3, true)).toBeGreaterThan(47.965);

    const narrowBounds = {
      left: 28,
      right: 171.9,
      jacketL: 78.365,
      jacketR: 121.535,
    };
    const core = {
      id: "1+",
      color: "BN " + "🌐".repeat(12),
      size: "18AWG",
      usage: "in-use" as const,
      status: "connected" as const,
      endpoints: [
        {
          terminal: { deviceUid: "a", terminalKey: "X1.1" },
          display: "TB1WWWW🌐🌐🌐",
          location: "PANEL",
        },
        {
          terminal: { deviceUid: "b", terminalKey: "X1.1" },
          display: "B🌐🌐🌐🌐🌐🌐🌐🌐.X1.1",
          location: "FIELD",
        },
      ] as const,
      netId: "N1",
    };
    const plan = cableRowPlan(core, "CBL1", narrowBounds);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // End B row wraps under fallback budget (43.862 mm > 42.365 mm available).
    expect(plan.value.z.length).toBeGreaterThan(1);
    expect(plan.value.z.join("")).toBe("B🌐🌐🌐🌐🌐🌐🌐🌐.X1.1");
    for (const row of plan.value.z)
      expect(labelMetrics(row, 2.7).width).toBeLessThanOrEqual(
        narrowBounds.right - narrowBounds.jacketR - 8 + 0.001,
      );
    // Centered core row wraps under fallback budget inside jacket width.
    expect(plan.value.centerRows.length).toBeGreaterThan(1);
    for (const row of plan.value.centerRows)
      expect(labelMetrics(row, 2.6).width).toBeLessThanOrEqual(
        narrowBounds.jacketR - narrowBounds.jacketL - 6 + 0.001,
      );
  });

  it("reserves full fallback width in rooted notice continuation collision checks", () => {
    const view = rootedCableView("CBL1" + "🌐".repeat(20));
    const b = bounds(sampleTitle, letterPortrait, view);
    const noticeX = rootedSheetNoticeX(letterPortrait, b.x);
    const lines = rootedNoticeLines(
      view,
      rootedSheetNoticeWidth(letterPortrait, noticeX),
      2.7,
    );
    const emojiIndex = lines.findIndex((l) => l.text.includes("🌐"));
    expect(emojiIndex).toBeGreaterThanOrEqual(0);
    const emojiLine = lines[emojiIndex]!;
    const startX = fieldTextLeft(noticeX, emojiLine.text, 2.7, emojiLine.bold);
    const baselineY = letterPortrait.marginMm + 19 + 4 * emojiIndex;
    const bundled = printableTextMetrics(emojiLine.text, 2.7, emojiLine.bold);
    const fallbackBox = textInk(
      emojiLine.text,
      startX,
      baselineY,
      2.7,
      emojiLine.bold,
    );
    expect(fallbackBox.w).toBeGreaterThan(bundled.right - bundled.left + 20);
    expect(fallbackBox.y + fallbackBox.h).toBeGreaterThanOrEqual(
      baselineY + measureText(emojiLine.text, 2.7).descent - 0.001,
    );

    const probeX = startX + bundled.right + 12;
    expect(probeX).toBeLessThan(fallbackBox.x + fallbackBox.w);
    const collidingDraft: Draft = {
      view,
      title: sampleTitle,
      content: "",
      links: [makeTopLink(probeX, baselineY + 8)],
      references: [],
      note: "",
      drawingBounds: b,
    };
    expect(continuationInkFailure(collidingDraft, letterPortrait)).toMatch(
      /cannot keep clear ink/u,
    );
    const clearDraft: Draft = {
      ...collidingDraft,
      links: [makeTopLink(probeX, b.y)],
    };
    expect(continuationInkFailure(clearDraft, letterPortrait)).toBeUndefined();
  });

  it("reserves fallback notice descent in continuedCaptionY, captionConstraint, and compactFramePlan", () => {
    const view = rootedCableView("CBL1" + "🌐".repeat(20));
    const b = bounds(sampleTitle, letterPortrait, view);
    const noticeX = rootedSheetNoticeX(letterPortrait, b.x);
    const lines = rootedNoticeLines(
      view,
      rootedSheetNoticeWidth(letterPortrait, noticeX),
      2.7,
    );
    const noticeBottom = Math.max(
      ...lines.map((l, i) => {
        const ink = textInk(
          l.text,
          fieldTextLeft(noticeX, l.text, 2.7, l.bold),
          letterPortrait.marginMm + 19 + 4 * i,
          2.7,
          l.bold,
        );
        return ink.y + ink.h;
      }),
    );
    const captionY = continuedCaptionY(b.y, letterPortrait, view);
    const capSample = textInk("CONTINUED LOCATION: A", 0, 0, 2.5);
    expect(captionY + capSample.y).toBeGreaterThanOrEqual(
      noticeBottom + 1.5 - 0.001,
    );
    expect(
      captionConstraint(
        "CONTINUED LOCATION: A",
        b,
        letterPortrait,
        view,
        [],
        noticeBottom,
      ),
    ).toMatch(/overlaps or lacks 1\.5 mm clearance/u);

    const compactPage = makeLetterPortrait(true);
    const plan = compactFramePlan(sampleTitle, compactPage, view);
    expect(plan.drawing.y).toBeGreaterThanOrEqual(noticeBottom + 1 - 0.001);
  });

  it("wraps circuitTextLines default callback and channelRowSlots with fallback budget", () => {
    const sample = "Review 🌐🌐🌐🌐🌐";
    const bundled = printableTextMetrics(sample, 2.5);
    expect(Math.max(bundled.advance, bundled.right)).toBeCloseTo(16.405, 2);
    expect(printableTextWidth(sample, 2.5)).toBeCloseTo(31.372, 2);
    expect(circuitTextLines(sample, 25)).toEqual(["Review", "🌐🌐🌐🌐🌐"]);
    expect(circuitTextLines("Review control", 25)).toEqual(["Review control"]);
    expect(channelRowSlots([sample], true, "channel", 4)).toBeGreaterThan(
      channelRowSlots(["Review control"], true, "channel", 4),
    );
  });
});

describe("bundled-only fixture invariance", () => {
  let ir: ElectricalIr;
  beforeAll(async () => {
    const compiled = await compileProject("examples/motor-starter");
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    ir = compiled.ir;
  });

  it("produces deterministic, unshifted SVG on bundled-only motor-starter views", async () => {
    const request = {
      format: "schematic-packet-request/0.1" as const,
      index: false,
      page: {
        size: "letter" as const,
        orientation: "portrait" as const,
        marginMm: 10,
      },
      views: [
        {
          format: "schematic-view-request/0.2" as const,
          root: { by: "designation" as const, value: "CBL1" },
          intent: { kind: "conductors" as const },
          flow: "left-to-right" as const,
        },
      ],
    };
    const a = await renderSchematicPacket(ir, request);
    const b = await renderSchematicPacket(ir, request);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.sheets[0]!.svg).toBe(b.value.sheets[0]!.svg);
    expect(a.value.sheets[0]!.svg).toContain('x="28"');
    expect(a.value.sheets[0]!.svg).toMatch(
      /<text\b[^>]*\bx="28"[^>]*>CABLE CBL1<\/text>/u,
    );
  });
});
