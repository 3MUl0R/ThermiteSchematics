import { beforeAll, afterAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
let browser, context, page;
beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});
const labels = [
  "Conductor / label",
  "End A / first endpoint",
  "End B / second endpoint",
  "Color / size",
  "Assignment",
  "From sheet.zone",
  "To sheet.zone",
];
function fixture(change = "") {
  function fields(header) {
    const top = header ? 20 : 40,
      height = header ? 20 : 18;
    const values = header
      ? [...labels]
      : ["W1", "A.1", "B.2", "Blue", "Connected", "01.A1", "02.B2"];
    if (header && change === "header") values[5] = "To sheet.zone";
    const boxes = values.map((_, i) => ({
      x: 20 + (i >= 5 ? i - 4 : i) * 50,
      y: top + (i >= 5 ? height / 2 : 0),
      w: 50,
      h: i === 1 || i === 2 || i >= 5 ? height / 2 : height,
    }));
    const rectangles = boxes
      .map((b, i) =>
        !header && change === "missing" && i === 5
          ? ""
          : `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${header ? "#e9eef4" : "white"}" stroke="#9ba6b4"/>`,
      )
      .reverse()
      .join("");
    const text = values
      .map((v, i) => {
        const b = boxes[i],
          wrong = !header && change === "wrong" && i === 5;
        return `<g data-report-column="${7 - i}" data-column-name="untrusted"><text x="${b.x + 2}" y="${(wrong ? top : b.y) + 5}" font-size="2.5" style="${header && change === "transparent" && i === 5 ? "opacity:0" : ""}">${v}</text></g>`;
      })
      .join("");
    const extra =
      !header && change === "outside"
        ? '<g data-report-column="6"><text x="72" y="68" font-size="2.5">03.C3</text></g>'
        : "";
    return `<g ${header ? "" : 'data-report-row="native-row"'}>${rectangles}${text}${extra}</g>`;
  }
  return embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="100mm" viewBox="0 0 300 100" font-family="Thermite Sans, sans-serif"><g data-document-id="document">${fields(true)}${fields(false)}</g></svg>`,
  );
}
it("measures stacked fields from painted partitions and header ink despite shuffled rectangles and false column flags", async () => {
  const g = await openSheet(page, fixture());
  expect(g.reportCells).toHaveLength(7);
  expect(g.reportCells.map((c) => c.columnIndex)).toEqual([
    0, 1, 2, 3, 4, 5, 6,
  ]);
  for (const [text, column] of [
    ["A.1", 1],
    ["B.2", 2],
    ["01.A1", 5],
    ["02.B2", 6],
  ])
    expect(g.texts.find((t) => t.row && t.text === text).columnIndex).toBe(
      column,
    );
  expect(g.reportCells[1].bbox.y + g.reportCells[1].bbox.h).toBeCloseTo(
    g.reportCells[5].bbox.y,
  );
});
it.each(["missing", "header", "wrong", "outside", "transparent"])(
  "rejects stacked %s geometry or ink",
  async (change) => {
    await expect(openSheet(page, fixture(change))).rejects.toThrow(
      /Stacked report/,
    );
  },
);
it("ordinary tables still require one painted rectangle per column", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><g data-report-row="r"><rect x="10" y="20" width="30" height="10" fill="white" stroke="#9ba6b4"/><g data-report-column="1"><text x="12" y="25" font-size="2.5">A</text></g><g data-report-column="2"><text x="42" y="25" font-size="2.5">B</text></g></g></svg>';
  await expect(openSheet(page, svg)).rejects.toThrow(
    /no independently measurable SVG cell rectangle/,
  );
});

it("independently measures all stacked fields in the issued narrow conveyor packet", async () => {
  const { compileProject } = await import("@thermite/compiler");
  const { renderSchematicPacket } =
    await import("../../packages/render/dist/sheets.js");
  const { conveyorRequest } =
    await import("../../packages/render/test/packet-navigation-review-fixture.js");
  const c = await compileProject("examples/conveyor-line");
  if (!c.ok) throw Error(JSON.stringify(c));
  const rendered = await renderSchematicPacket(
    c.ir,
    {
      ...conveyorRequest(),
      layout: "standard",
      page: { size: "letter", orientation: "portrait" },
    },
    c.presentation,
  );
  if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
  expect(rendered.value.sheets).toHaveLength(19);
  const wires = rendered.value.sheets.filter((s) => s.view.kind === "wires");
  expect(wires).toHaveLength(4);
  for (const sheet of wires) {
    const g = await openSheet(page, embedPrintableFont(sheet.svg));
    for (const t of g.texts.filter((t) => t.row)) {
      expect(t.bbox.x).toBeGreaterThanOrEqual(t.cell.x - 0.02);
      expect(t.bbox.y).toBeGreaterThanOrEqual(t.cell.y - 0.02);
      expect(t.bbox.x + t.bbox.w).toBeLessThanOrEqual(
        t.cell.x + t.cell.w + 0.02,
      );
      expect(t.bbox.y + t.bbox.h).toBeLessThanOrEqual(
        t.cell.y + t.cell.h + 0.02,
      );
    }
    const rows = new Set(g.reportCells.map((c) => c.row));
    expect(g.reportCells).toHaveLength(rows.size * 7);
    expect(
      g.reportCells
        .filter((c) => c.columnIndex === 5)
        .every(
          (c) =>
            c.bbox.y >
            g.reportCells.find((p) => p.row === c.row && p.columnIndex === 1)
              .bbox.y,
        ),
    ).toBe(true);
  }
});
