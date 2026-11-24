import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import {
  hasPrintableFallback,
  isDefaultIgnorableCodePoint,
  measureText,
  printableTextInkMetrics,
  printableTextLeftOverhang,
  printableTextMetrics,
  printableTextRightExtent,
  printableTextRightOverhang,
  printableTextWidth,
} from "../src/text-metrics.js";
import { placeWrappedLines } from "../src/line-placement.js";
import {
  centeredTextExtent,
  FIELD_TEXT_LEFT_SAFETY_MM,
  fieldTextEndExtent,
  fieldTextLeft,
  fieldTextLeftShift,
  fieldTextRight,
  fieldTextRightExtent,
  fieldTextRightShift,
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
import { rootedSheetNoticeLayout } from "../src/off-view/notice.js";
import {
  channelRowSlots,
  circuitCaptionHeight,
  circuitCaptionSlots,
  circuitTextLines,
} from "../src/symbols/circuit-text.js";
import { renderSchematicPacket } from "../src/sheets.js";
import type { NormalizedSchematicView } from "../src/types.js";
import type { Draft, Link, PaperPage } from "../src/packet/types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

describe("fallback-face cluster, ignorable, and edge metrics (#555, #556)", () => {
  it("treats default-ignorable code points as non-fallback and preserves exact bundled metrics", () => {
    for (const ignorable of [
      "\uFE0F",
      "\uFE0E",
      "\u200D",
      "\u200C",
      "\u200B",
      "\u00AD",
    ]) {
      expect(isDefaultIgnorableCodePoint(ignorable)).toBe(true);
      expect(hasPrintableFallback(`a${ignorable}`)).toBe(false);
    }
    expect(isDefaultIgnorableCodePoint("a")).toBe(false);
    expect(isDefaultIgnorableCodePoint("🌐")).toBe(false);

    const vs24 = "a".repeat(24) + "\uFE0F";
    const plain24 = "a".repeat(24);
    expect(hasPrintableFallback(vs24, true)).toBe(false);
    expect(printableTextInkMetrics(vs24, 3, true)).toStrictEqual(
      printableTextMetrics(plain24, 3, true),
    );
    expect(printableTextWidth(vs24, 3, true)).toBe(
      printableTextWidth(plain24, 3, true),
    );
    expect(printableTextWidth(vs24, 3, true)).toBeCloseTo(43.488, 6);
    expect(fieldTextRightShift(vs24, 3, true)).toBe(0);

    expect(printableTextInkMetrics("a\uFE0F", 2.7)).toStrictEqual(
      printableTextMetrics("a", 2.7),
    );
    // Bold math + ignorable selector must still stay non-fallback.
    expect(hasPrintableFallback("𝒿 a\uFE0F", true)).toBe(false);
    expect(printableTextInkMetrics("𝒿 a\uFE0F", 2.7, true)).toStrictEqual(
      printableTextMetrics("𝒿 a", 2.7, true),
    );
  });

  it("reserves 0.5 em at cluster start for leading and partially covered clusters (#555)", () => {
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
    // Partial coverage in leading cluster ("A" covered + U+20DD uncovered) reserves at cluster start.
    expect(hasPrintableFallback("A\u20DD")).toBe(true);
    expect(printableTextLeftOverhang("A\u20DD", 2.7)).toBeCloseTo(1.35, 6);
    expect(fieldTextLeftShift("A\u20DD", 2.7)).toBe(1.53);

    // Narrow bundled prefix whose advance < 0.5 em is protected; normal prefixes keep 0 shift.
    expect(printableTextLeftOverhang("i🌐 test", 2.5)).toBeGreaterThan(0.5);
    expect(printableTextLeftOverhang("A 🌐 test", 2.5)).toBe(0);
    expect(fieldTextLeftShift("A 🌐 test", 2.5)).toBe(0);
    expect(printableTextLeftOverhang("Field 🌐", 3, true)).toBe(0);
    expect(fieldTextLeft(28, "CABLE CBL1", 4, true)).toBe(28);
  });

  it("applies the 1.2/0.4 em vertical floor and 0.5 em right bearing reserve to all fallback clusters", () => {
    // Table-known but bundled-uncovered glyphs (⚡, ❤️) still get the 1.2/0.4 em vertical floor.
    for (const sample of ["Field ⚡", "❤️", "Field 🌐", "A\u20DD"]) {
      for (const size of [2.5, 2.7, 3]) {
        const ink = printableTextInkMetrics(sample, size, size === 3);
        expect(ink.top, `${sample}@${size} top`).toBeGreaterThanOrEqual(
          1.2 * size - 1e-9,
        );
        expect(ink.bottom, `${sample}@${size} bottom`).toBeLessThanOrEqual(
          -0.4 * size + 1e-9,
        );
        expect(
          printableTextRightOverhang(sample, size, size === 3),
        ).toBeCloseTo(0.5 * size, 6);
        expect(fieldTextRightShift(sample, size, size === 3)).toBe(
          Math.ceil((0.5 * size + FIELD_TEXT_LEFT_SAFETY_MM) * 1000) / 1000,
        );
        expect(fieldTextRight(187.9, sample, size, size === 3)).toBeCloseTo(
          187.9 - fieldTextRightShift(sample, size, size === 3),
          6,
        );
        expect(fieldTextEndExtent(sample, size, size === 3)).toBeCloseTo(
          fieldTextRightShift(sample, size, size === 3) +
            printableTextWidth(sample, size, size === 3),
          6,
        );
        expect(centeredTextExtent(sample, size)).toBeGreaterThanOrEqual(
          printableTextInkMetrics(sample, size).advance + size - 1e-9,
        );
      }
    }
    expect(printableTextRightOverhang("Field Panel", 3, true)).toBe(0);
    expect(fieldTextRightShift("Field Panel", 3, true)).toBe(0);
    expect(fieldTextRight(187.9, "Field Panel", 3, true)).toBe(187.9);
    expect(centeredTextExtent("1- / white / 18AWG", 2.6, false, true)).toBe(
      labelMetrics("1- / white / 18AWG", 2.6).width,
    );
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

describe("fallback-face fit, line placement, and collision paths (#556)", () => {
  it("budgets cable End B heading, End B row, and centered core rows with anchored extents and fallback pitch", () => {
    const endBLoc = "Field " + "🌐".repeat(19);
    const bundledEndB = printableTextMetrics(endBLoc, 3, true);
    expect(Math.max(bundledEndB.advance, bundledEndB.right)).toBeLessThan(
      47.965,
    );
    expect(fieldTextEndExtent(endBLoc, 3, true)).toBeGreaterThan(47.965);
    expect(fieldTextEndExtent("Field 🌐", 3, true)).toBeLessThan(47.965);
    expect(fieldTextEndExtent("Field ⚡", 3, true)).toBeLessThan(47.965);

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
          display: "TB1.2",
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
    expect(plan.value.z.length).toBeGreaterThan(1);
    expect(plan.value.z.join("")).toBe("B🌐🌐🌐🌐🌐🌐🌐🌐.X1.1");
    for (const row of plan.value.z)
      expect(fieldTextEndExtent(row, 2.7, false, true)).toBeLessThanOrEqual(
        narrowBounds.right - narrowBounds.jacketR - 8 + 0.001,
      );
    expect(plan.value.centerRows.length).toBeGreaterThan(1);
    for (const row of plan.value.centerRows)
      expect(centeredTextExtent(row, 2.6, false, true)).toBeLessThanOrEqual(
        narrowBounds.jacketR - narrowBounds.jacketL - 6 + 0.001,
      );
    // Consecutive fallback core rows expand pitch beyond legacy 4 mm.
    expect(
      plan.value.centerBaselines[1]! - plan.value.centerBaselines[0]!,
    ).toBeGreaterThan(5.6);
  });

  it("shares fallback-aware line placement across rooted notice continuation checks", () => {
    const bundledLines = placeWrappedLines(
      [
        { text: "Line one", size: 2.7, bold: true },
        { text: "Line two", size: 2.7, bold: false },
      ],
      29,
      4,
    );
    expect(bundledLines.map((l) => l.y)).toEqual([29, 33]);

    const view40 = rootedCableView("CBL1" + "🌐".repeat(40));
    const b40 = bounds(sampleTitle, letterPortrait, view40);
    const notice40 = rootedSheetNoticeLayout(view40, letterPortrait, b40.x);
    const emojiIndices = notice40.lines
      .map((l, i) => (l.fallback ? i : -1))
      .filter((i) => i >= 0);
    expect(emojiIndices.length).toBeGreaterThanOrEqual(2);
    expect(
      notice40.lines[emojiIndices[1]!]!.y - notice40.lines[emojiIndices[0]!]!.y,
    ).toBeGreaterThan(5.6);

    const firstEmoji = notice40.lines[emojiIndices[0]!]!;
    const startX = fieldTextLeft(
      notice40.x,
      firstEmoji.text,
      2.7,
      firstEmoji.bold,
    );
    const bundled = printableTextMetrics(firstEmoji.text, 2.7, firstEmoji.bold);
    const fallbackBox = textInk(
      firstEmoji.text,
      startX,
      firstEmoji.y,
      2.7,
      firstEmoji.bold,
    );
    expect(fallbackBox.w).toBeGreaterThan(bundled.right - bundled.left + 20);

    const probeX = startX + bundled.right + 12;
    const collidingDraft: Draft = {
      view: view40,
      title: sampleTitle,
      content: "",
      links: [makeTopLink(probeX, firstEmoji.y + 8)],
      references: [],
      note: "",
      drawingBounds: b40,
    };
    expect(continuationInkFailure(collidingDraft, letterPortrait)).toMatch(
      /cannot keep clear ink/u,
    );
    const clearDraft: Draft = {
      ...collidingDraft,
      links: [makeTopLink(probeX, b40.y)],
    };
    expect(continuationInkFailure(clearDraft, letterPortrait)).toBeUndefined();
  });

  it("reserves fallback notice height and descent in continuedCaptionY, captionConstraint, and compactFramePlan", () => {
    const view40 = rootedCableView("CBL1" + "🌐".repeat(40));
    const b40 = bounds(sampleTitle, letterPortrait, view40);
    const notice40 = rootedSheetNoticeLayout(view40, letterPortrait, b40.x);
    const noticeBottom = Math.max(
      ...notice40.lines.map((l) => {
        const ink = textInk(
          l.text,
          fieldTextLeft(notice40.x, l.text, 2.7, l.bold),
          l.y,
          2.7,
          l.bold,
        );
        return ink.y + ink.h;
      }),
    );
    const captionY = continuedCaptionY(b40.y, letterPortrait, view40);
    const capSample = textInk("CONTINUED LOCATION: A", 0, 0, 2.5);
    expect(captionY + capSample.y).toBeGreaterThanOrEqual(
      noticeBottom + 1.5 - 0.001,
    );
    expect(
      captionConstraint(
        "CONTINUED LOCATION: A",
        b40,
        letterPortrait,
        view40,
        [],
        noticeBottom,
      ),
    ).toMatch(/overlaps or lacks 1\.5 mm clearance/u);

    const compactPage = makeLetterPortrait(true);
    const plan = compactFramePlan(sampleTitle, compactPage, view40);
    expect(plan.drawing.y).toBeGreaterThanOrEqual(noticeBottom + 1 - 0.001);
  });

  it("wraps circuitTextLines and expands circuit caption slots only for fallback lines", () => {
    const sample = "Review 🌐🌐🌐🌐🌐";
    expect(circuitTextLines(sample, 25)).toEqual(["Review", "🌐🌐🌐🌐🌐"]);
    expect(circuitTextLines("Review control", 25)).toEqual(["Review control"]);

    const bundledSlots = circuitCaptionSlots(["W-FLD-001", "18AWG / white"]);
    expect(bundledSlots.map((s) => [s.yOffset, s.height])).toEqual([
      [0, 3.8],
      [3.1, 3.8],
    ]);
    expect(circuitCaptionHeight(["W-FLD-001", "18AWG / white"])).toBeCloseTo(
      6.9,
      6,
    );

    const fallbackSlots = circuitCaptionSlots([
      "W-FLD-001",
      "18AWG / Review",
      "🌐🌐🌐🌐🌐🌐🌐🌐🌐",
    ]);
    expect(fallbackSlots[2]!.height).toBeGreaterThan(5.5);
    expect(fallbackSlots[2]!.yOffset).toBeGreaterThanOrEqual(
      fallbackSlots[1]!.yOffset + fallbackSlots[1]!.height,
    );
    expect(channelRowSlots([sample], true, "channel", 4)).toBeGreaterThan(
      channelRowSlots(["Review control"], true, "channel", 4),
    );
    expect(channelRowSlots([sample], false, "channel", 4)).toBeGreaterThan(
      channelRowSlots(["Review control"], false, "channel", 4),
    );
  });
});

describe("bundled-only fixture invariance against pinned dev 8b755681 hashes", () => {
  // SHA-256 hashes captured verbatim on origin/dev (8b755681) before FALLBACKFACE.
  const PINNED_DEV_HASHES = {
    cable: ["a62d56fb001eca4f5632e3c0097f85d24a929b963e9d9a3ee56213a8a2764ca4"],
    rooted: [
      "48f8ad67d8f6852b2b735b177dfec76690053baab1115a8f7a073985c314df0d",
      "b8e10f9859c561d435f77895b818f215ad06b3873e47f64e51ccbba4dfb135d9",
    ],
    circuit: [
      "a52c69258e4f20351bffe806330b7b968a5e665be30972ff82f3ff31721a6a25",
    ],
  } as const;

  const PINNED_REQUESTS = {
    cable: {
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
    },
    rooted: {
      format: "schematic-packet-request/0.1" as const,
      index: false,
      page: {
        size: "letter" as const,
        orientation: "portrait" as const,
        marginMm: 10,
      },
      views: [
        {
          format: "schematic-view-request/0.1" as const,
          root: { by: "designation" as const, value: "K1" },
          family: "control" as const,
          flow: "left-to-right" as const,
        },
      ],
    },
    circuit: {
      format: "schematic-packet-request/0.1" as const,
      index: false,
      page: {
        size: "tabloid" as const,
        orientation: "landscape" as const,
        marginMm: 10,
      },
      views: [
        {
          format: "circuit-view-request/0.1" as const,
          title: "Circuit bundled control",
          flow: "left-to-right" as const,
          groups: [
            {
              id: "g1",
              label: "Field permissive",
              functions: [
                {
                  device: { by: "designation" as const, value: "JB1" },
                  key: "terminal1",
                },
                {
                  device: { by: "designation" as const, value: "LS1" },
                  key: "contact13",
                },
                {
                  device: { by: "designation" as const, value: "JB1" },
                  key: "terminal2",
                },
              ],
              conductors: ["W-FLD-001", "W-FLD-002"],
            },
          ],
        },
      ],
    },
  };

  let ir: ElectricalIr;
  beforeAll(async () => {
    const compiled = await compileProject("examples/motor-starter");
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    ir = compiled.ir;
  });

  it("matches pinned dev hashes byte-for-byte on bundled-only cable, rooted, and circuit views", async () => {
    for (const key of ["cable", "rooted", "circuit"] as const) {
      const rendered = await renderSchematicPacket(ir, PINNED_REQUESTS[key]);
      expect(
        rendered.ok,
        JSON.stringify(rendered.ok ? null : rendered.error),
      ).toBe(true);
      if (!rendered.ok) continue;
      expect(
        rendered.value.sheets.map((s) => sha256(s.svg)),
        key,
      ).toEqual(PINNED_DEV_HASHES[key]);
    }
  });
});
