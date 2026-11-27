import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compileProject,
  lockProject,
  type ElectricalIr,
} from "@thermite/compiler";
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
import { withFontMetricCache } from "../src/symbols/font-metric-cache.js";
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
import { printableLabelGeometry } from "../src/symbols/printable-label.js";
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

  it("preserves exact dev left-anchored extents for bundled-only text with default ignorables", () => {
    expect(fieldTextRightExtent("a\uFE0F", 2.7, false, true)).toBeCloseTo(
      1.82223,
      6,
    );
    expect(fieldTextRightExtent("𝒿\uFE0F", 2.7, false, true)).toBeCloseTo(
      2.70827,
      6,
    );
    expect(fieldTextRightExtent("𝒿\uFE0F", 2.7, true, true)).toBeCloseTo(
      2.78927,
      6,
    );
    const endASelector = "a".repeat(20) + "\uFE0F.2";
    expect(hasPrintableFallback(endASelector, false, true)).toBe(false);
    expect(fieldTextRightExtent(endASelector, 2.7, false, true)).toBeCloseTo(
      40.1058,
      6,
    );
  });

  it("budgets every uncovered cluster at max(measureText cluster width, 1.5 em) without changing measureText", () => {
    // measureText keeps its table-known scalar width for U+26A1 (0.7022 em).
    expect(measureText("⚡", 3).width).toBeCloseTo(0.7022 * 3, 4);
    expect(printableTextInkMetrics("⚡", 3, true).advance).toBeCloseTo(4.5, 6);
    expect(
      printableTextInkMetrics("⚡".repeat(21), 3, true).advance,
    ).toBeCloseTo(21 * 4.5, 6);
    expect(fieldTextRightExtent("⚡".repeat(21), 3, true)).toBeGreaterThan(
      47.965,
    );
    expect(fieldTextEndExtent("⚡".repeat(21), 3, true)).toBeGreaterThan(
      47.965,
    );
    expect(fieldTextEndExtent("⚡".repeat(16), 3, true)).toBeGreaterThan(
      39.565,
    );
    expect(
      centeredTextExtent("❤️".repeat(12), 2.6, false, true),
    ).toBeGreaterThanOrEqual(12 * 1.5 * 2.6 + 2.6 - 1e-9);
  });

  it("keeps exact dev geometry for bundled tall glyphs under useFallbackInk", () => {
    expect(hasPrintableFallback("18AWG / ∫")).toBe(false);
    const label = { x: 10, y: 0, width: 30, height: 3.8 };
    for (const routeY of [-1, 0, 1, 2, 3, 4, 5]) {
      const routes = [
        [
          { x: 10, y: routeY },
          { x: 40, y: routeY },
        ],
      ];
      const devGeom = printableLabelGeometry(
        label,
        "18AWG / ∫",
        28.5,
        routes,
        2.5,
        false,
        undefined,
        false,
      );
      const fallbackGeom = printableLabelGeometry(
        label,
        "18AWG / ∫",
        28.5,
        routes,
        2.5,
        false,
        undefined,
        true,
      );
      expect(fallbackGeom, `routeY=${routeY}`).toStrictEqual(devGeom);
      if (routeY === 0) expect(fallbackGeom.baseline).toBeCloseTo(2.55, 6);
    }
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
  // SHA-256 hashes from origin/dev (8b755681) refreshed for authorised RL1/RL2 deltas (#642/#643):
  // additive data-text-role on all views plus RL2 rail-device-tag font-size 10 -> 10.8 on rooted.
  const PINNED_DEV_HASHES = {
    cable: ["13bfa703ae5f5187ab678675f479cae0e5b4a4f992b3fc8dcd6de18afe5bf906"],
    rooted: [
      "659b1ea45f630a72529edbc04882cf6bae56f9d54556fa84c26795efacb00b0c",
      "61ea34a0164dbd58b6dc65452af11c605cae0ee8dc2142faa554049e5825c1e9",
    ],
    circuit: [
      "3b5e832c11d2d887d2ddde1f223c5ba1d6af9bff46464a2fc3fa64a2153452ce",
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

  it("matches pinned dev sheet-1 SHA-256 for the End A selector-bearing bundled packet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thermite-fb-selector-"));
    try {
      await cp("examples/motor-starter", dir, { recursive: true });
      const des = "a".repeat(20) + "\uFE0F";
      const walk = async (root: string): Promise<string[]> => {
        const out: string[] = [];
        for (const entry of await readdir(root, { withFileTypes: true })) {
          const next = join(root, entry.name);
          if (entry.isDirectory()) out.push(...(await walk(next)));
          else if (entry.name.endsWith(".json")) out.push(next);
        }
        return out;
      };
      for (const file of await walk(dir)) {
        const raw = await readFile(file, "utf8");
        const next = raw.replaceAll('"TB1"', JSON.stringify(des));
        if (next !== raw) await writeFile(file, next);
      }
      const locked = await lockProject(dir);
      expect(locked.ok, JSON.stringify(locked)).toBe(true);
      const compiled = await compileProject(dir);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      const rendered = await renderSchematicPacket(compiled.ir, {
        ...PINNED_REQUESTS.cable,
        page: { ...PINNED_REQUESTS.cable.page, marginMm: 22 },
      });
      expect(
        rendered.ok,
        JSON.stringify(rendered.ok ? null : rendered.error),
      ).toBe(true);
      if (!rendered.ok) return;
      expect(rendered.value.sheets.length).toBe(2);
      // Refreshed for additive RL1 data-text-role attributes (#642; byte-identical after strip).
      expect(sha256(rendered.value.sheets[0]!.svg)).toBe(
        "82f1a857fd9cf007395b917106c503d9c92dd6daedee65b7ef8786710a8abda6",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns identical results on cached calls and resists caller mutation poisoning", async () => {
    const cases: readonly (readonly [string, number, boolean, boolean])[] = [
      ["cache-plain-01", 2.7, false, false],
      ["cache-plain-01", 2.7, true, false],
      ["cache-plain  01 ", 2.7, false, true],
      ["cache-plain  01 ", 2.7, false, false],
      ["cache-math-∫-01", 3, true, false],
      ["cache-ignorable-a\uFE0F-01", 2.5, false, false],
      ["cache-fallback-⚡-01", 3, true, false],
      ["10:cache-key-sep", 1, false, false],
      ["cache-key-sep", 10, false, false],
    ];
    for (const [value, size, bold, literal] of cases) {
      const fb1 = hasPrintableFallback(value, bold, literal);
      const lo1 = printableTextLeftOverhang(value, size, bold, literal);
      const ro1 = printableTextRightOverhang(value, size, bold, literal);
      const re1 = printableTextRightExtent(value, size, bold, literal);
      const w1 = printableTextWidth(value, size, bold, literal);
      const m1 = printableTextInkMetrics(value, size, bold, literal);
      const mt1 = measureText(value, size);
      const mSnap = { ...m1 };
      const mtSnap = { ...mt1, unknownGlyphs: [...mt1.unknownGlyphs] };

      // Attempt to poison returned objects before repeating every call.
      Reflect.set(m1, "advance", -999);
      Reflect.set(m1, "right", -999);
      mt1.width = -999;
      mt1.unknownGlyphs.push("POISON");

      expect(hasPrintableFallback(value, bold, literal)).toBe(fb1);
      expect(printableTextLeftOverhang(value, size, bold, literal)).toBe(lo1);
      expect(printableTextRightOverhang(value, size, bold, literal)).toBe(ro1);
      expect(printableTextRightExtent(value, size, bold, literal)).toBe(re1);
      expect(printableTextWidth(value, size, bold, literal)).toBe(w1);
      expect(printableTextInkMetrics(value, size, bold, literal)).toStrictEqual(
        mSnap,
      );
      expect(measureText(value, size)).toStrictEqual(mtSnap);
    }
    await withFontMetricCache(async () => {
      const first = printableTextInkMetrics("cache-scoped-⚡", 2.7, false);
      const snap = { ...first };
      expect(Object.isFrozen(first)).toBe(true);
      expect(Reflect.set(first, "advance", -999)).toBe(false);
      expect(printableTextInkMetrics("cache-scoped-⚡", 2.7, false)).toBe(
        first,
      );
      expect(
        printableTextInkMetrics("cache-scoped-⚡", 2.7, false),
      ).toStrictEqual(snap);
    });
  });
});
