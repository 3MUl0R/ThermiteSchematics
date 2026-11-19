import { expect, it } from "vitest";
import type { CompiledProjectPresentation } from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";
import { stackSections } from "../src/packet/fold-stack.js";
import { useCompactFrame } from "../src/packet/frame-profile.js";
import { frame, normalizePaperPage } from "../src/packet/page.js";
import type { Draft } from "../src/packet/types.js";
import { printableTextMetrics } from "../src/symbols/printable-font.js";
import {
  control,
  foldedControlFixture,
  parseSvg,
} from "./off-view-fixtures.js";

const foldNote = "Folded circuit sections; follow paired conductor references.";
const stamp = "Thermite 0.3.0-alpha.2";

function footerInk(svg: string, value: string) {
  const doc = parseSvg(svg).documentElement;
  const border = [...doc.children].find(
    (element) =>
      element.localName === "rect" &&
      element.getAttribute("stroke-width") === "0.4",
  );
  const label = [...doc.children].find(
    (element) => element.localName === "text" && element.textContent === value,
  );
  if (!border || !label) throw Error(`Missing frame or footer text: ${value}`);
  const left = Number(border.getAttribute("x"));
  const right = left + Number(border.getAttribute("width"));
  const bottom =
    Number(border.getAttribute("y")) + Number(border.getAttribute("height"));
  const x = Number(label.getAttribute("x"));
  const y = Number(label.getAttribute("y"));
  const size = Number(label.getAttribute("font-size"));
  const ink = printableTextMetrics(value, size);
  const start =
    label.getAttribute("text-anchor") === "end" ? x - ink.advance : x;
  expect(size).toBeGreaterThanOrEqual(2.5);
  expect(start + ink.left).toBeGreaterThan(left);
  expect(start + ink.right).toBeLessThan(right);
  expect(y - ink.bottom, value).toBeLessThan(bottom);
  return {
    left: start + ink.left,
    right: start + ink.right,
    top: y - ink.top,
    bottom: y - ink.bottom,
    frameBottom: bottom,
  };
}

function assertCompactFooter(svg: string, note: string) {
  const fold = footerInk(svg, note);
  const history = footerInk(svg, "Revision history: UNSPECIFIED");
  const generator = footerInk(svg, stamp);
  for (const line of [fold, history, generator])
    expect(line.top).toBeGreaterThan(line.frameBottom - 6);
  expect(fold.bottom).toBeLessThan(Math.min(history.top, generator.top));
  expect(history.right).toBeLessThan(generator.left);
  for (const cell of parseSvg(svg).querySelectorAll(
    'rect[stroke-width="0.25"]',
  )) {
    const edge =
      Number(cell.getAttribute("y")) + Number(cell.getAttribute("height"));
    expect(edge).toBeLessThanOrEqual(fold.frameBottom - 6 + 0.001);
  }
}

const presentation: CompiledProjectPresentation = {
  format: "project-presentation/0.3",
  revision: "UNSPECIFIED",
  backgroundColor: "#ffffff",
  titleBlockLines: [],
};

it.each(["standard", "compact"] as const)(
  "prints the folded Tabloid landscape 10 mm footer inside the compact frame (%s layout)",
  async (layout) => {
    const fixture = await foldedControlFixture();
    try {
      const result = await renderSchematicPacket(
        fixture.ir,
        {
          format: "schematic-packet-request/0.1",
          page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
          layout,
          views: [control()],
        },
        presentation,
      );
      if (!result.ok) throw Error(result.error.message);
      expect(result.value.sheets.length).toBeGreaterThan(1);
      for (const sheet of result.value.sheets)
        assertCompactFooter(sheet.svg, foldNote);
    } finally {
      await fixture.dispose();
    }
  },
);

const sizes = ["letter", "tabloid", "a4", "a3"] as const;
const orientations = ["landscape", "portrait"] as const;
const papers = sizes.flatMap((size) =>
  orientations.flatMap((orientation) =>
    [5, 10, 25].map((marginMm) => ({ size, orientation, marginMm })),
  ),
);

it.each(papers)(
  "keeps folded footer ink in the frame on $size $orientation, margin $marginMm mm",
  (paper) => {
    const page = normalizePaperPage(paper);
    if (!page.ok) throw Error(page.error.message);
    const title = {
      ...presentation,
      projectName: "Fold test",
      toolVersion: "test",
      lines: [],
    };
    const unfolded: Draft = {
      title,
      view: {
        format: "documentation-view/0.1",
        kind: "bom",
        title: "Fold test",
      },
      content: "",
      links: [],
      note: "",
    };
    const draft = stackSections([unfolded, unfolded], [10, 10], [[0, 1]], {
      x: 40,
      y: 40,
      w: 100,
      h: 50,
    })[0]!;
    const legacy = frame(draft, page.value, 1, 1);
    expect(legacy).toContain("Folded circuit sections;");
    footerInk(legacy, stamp);
    useCompactFrame(page.value);
    assertCompactFooter(frame(draft, page.value, 1, 1), foldNote);
  },
);
