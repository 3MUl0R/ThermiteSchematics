import { beforeAll, afterAll, it, expect } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { fixture } from "./m3-fixture.mjs";
import { wireLocatorAudit } from "./wire-locators.mjs";
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
const svg = (body) =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 300 200" font-family="Thermite Sans, sans-serif">${body}</svg>`,
  );
const text = (x, y, value) =>
  `<text x="${x}" y="${y}" font-size="2.5">${value}</text>`;
function drawing(pin = false, hidden = false) {
  const grid =
    Array.from({ length: 6 }, (_, i) =>
      text(30 + i * 30, 12, String(i + 1)),
    ).join("") + [..."ABCD"].map((t, i) => text(10, 42 + i * 40, t)).join("");
  return svg(
    grid +
      `<g data-device-uid="a"${hidden ? ' display="none"' : ""}>${pin ? text(29, 50, "1: Native terminal") : '<circle data-terminal-key="1" cx="30" cy="50" r="1" fill="white" stroke="black"/>'}</g><g data-device-uid="b"><circle data-terminal-key="1" cx="90" cy="90" r="1" fill="white" stroke="black"/></g>`,
  );
}
function schedule(stacked, printed) {
  const labels = [
    "Conductor / label",
    "End A / first endpoint",
    "End B / second endpoint",
    "Color / size",
    "Assignment",
    "From sheet.zone",
    "To sheet.zone",
  ];
  function row(header) {
    const values = header
        ? labels
        : ["W1", "A.1", "B.1", "Blue", "Connected", printed, "01.B3"],
      y = header ? 20 : 50;
    const boxes = values.map((_, i) => ({
      x: 20 + (stacked && i >= 5 ? i - 4 : i) * 35,
      y: y + (stacked && i >= 5 ? 10 : 0),
      w: 35,
      h: stacked && (i === 1 || i === 2 || i >= 5) ? 10 : 20,
    }));
    return `<g ${header ? "" : 'data-report-row="w"'}>${boxes.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="white" stroke="#9ba6b4"/>`).join("")}${values.map((v, i) => `<g data-report-column="${i + 1}">${text(boxes[i].x + 2, boxes[i].y + 5, v)}</g>`).join("")}</g>`;
  }
  return svg(`<g data-document-id="doc">${row(true)}${row(false)}</g>`);
}
function native() {
  const ir = fixture().ir;
  ir.devices = [
    { uid: "a", designation: "A", typeId: "t" },
    { uid: "b", designation: "B", typeId: "t" },
  ];
  ir.deviceTypes[0].terminals = [{ key: "1", description: "Native terminal" }];
  ir.wires = [
    {
      uid: "w",
      designation: "W1",
      endpoints: [
        { terminal: { deviceUid: "a", terminalKey: "1" } },
        { terminal: { deviceUid: "b", terminalKey: "1" } },
      ],
    },
  ];
  return ir;
}
const packet = {
  sheets: [
    { number: 1, view: { kind: "wiring", format: "documentation-view/0.1" } },
    { number: 2, view: { kind: "wires", format: "documentation-view/0.1" } },
  ],
};
it.each([false, true])(
  "compares actual ordinary/stacked printed values with native measured appearances (%s)",
  async (stacked) => {
    const g = await openSheet(page, drawing());
    for (const [printed, count] of [
      ["01.A1", 0],
      ["not drawn", 1],
      ["02.A1", 1],
      ["01.D6", 1],
    ]) {
      const report = await openSheet(page, schedule(stacked, printed));
      expect(
        wireLocatorAudit(packet, [g, report], native()).findings,
      ).toHaveLength(count);
    }
  },
);
it("measures a terminal painted only as native pin-list text and ignores hidden ink", async () => {
  const report = await openSheet(page, schedule(false, "01.A1"));
  expect(
    wireLocatorAudit(
      packet,
      [await openSheet(page, drawing(true)), report],
      native(),
    ).findings,
  ).toEqual([]);
  expect(
    wireLocatorAudit(
      packet,
      [await openSheet(page, drawing(true, true)), report],
      native(),
    ).findings[0].kind,
  ).toBe("wire-locator-without-appearance");
  expect(
    wireLocatorAudit(
      packet,
      [await openSheet(page, drawing(false, true)), report],
      native(),
    ).findings[0].kind,
  ).toBe("wire-locator-without-appearance");
});

it.each([false, true])(
  "clipped native marker or pin text supplies no appearance (%s)",
  async (pin) => {
    const source = drawing(pin).replace(
      '<g data-device-uid="a">',
      '<defs><clipPath id="cut"><rect x="0" y="0" width="1" height="1"/></clipPath></defs><g data-device-uid="a" clip-path="url(#cut)">',
    );
    expect(source).toContain('clip-path="url(#cut)"');
    const report = await openSheet(page, schedule(false, "01.A1"));
    expect(
      wireLocatorAudit(
        packet,
        [await openSheet(page, source), report],
        native(),
      ).findings[0].kind,
    ).toBe("wire-locator-without-appearance");
  },
);

it("connects measured locator failures to the DQ-19 sheet verdict", async () => {
  const { evaluateSheet } = await import("./evaluate.mjs");
  const ir = native();
  Object.assign(ir, { functions: [], nets: [] });
  const p = structuredClone(packet);
  for (const s of p.sheets)
    Object.assign(s, { references: [], continuations: [] });
  const source = await openSheet(page, drawing()),
    report = await openSheet(page, schedule(false, "not drawn"));
  const table = {
    kind: "wires",
    documentId: "doc",
    columns: [
      "Conductor / label",
      "End A / first endpoint",
      "End B / second endpoint",
      "Color / size",
      "Assignment",
      "From sheet.zone",
      "To sheet.zone",
    ],
    rows: [
      {
        key: "w",
        cells: ["W1", "A.1", "B.1", "Blue", "Connected", "01.A1", "01.B3"],
      },
    ],
  };
  const results = evaluateSheet(
    { id: "native-locator", flow: "left-to-right" },
    p.sheets[1],
    p,
    report,
    ir,
    [],
    [],
    [],
    [table],
    [source, report],
    { views: [] },
  );
  expect(
    results
      .filter((r) => r.dq === "DQ-19")
      .flatMap((r) => r.evidence.findings)
      .some((f) => f.kind === "wire-locator-undrawn-claim"),
  ).toBe(true);
});
