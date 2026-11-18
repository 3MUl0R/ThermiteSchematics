import { afterAll, beforeAll, expect, it } from "vitest";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { end, nativeIr, wire } from "./tranche3-fixtures.mjs";
import { wireLabelSupportAudit } from "./wire-label-support.mjs";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage(drawingContextOptions);
  await page.emulateMedia({ media: "print" });
});
afterAll(async () => {
  await browser?.close();
});
const ir = nativeIr([
  wire("A", end("X"), end("D")),
  wire("B", end("Y"), end("D")),
]);
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="150mm" height="100mm" viewBox="0 0 150 100">${body}</svg>`;
function route(id, d) {
  const endpoints = ir.wires
    .find((w) => w.uid === id)
    .endpoints.map((e) => e.terminal);
  return `<path data-wire-uid="${id}" data-endpoints='${JSON.stringify(endpoints)}' d="${d}" fill="none" stroke="#344054" stroke-width=".35"/>`;
}
function label(id, x, y, fill = "white", extra = "", text = id) {
  return `<g data-wire-label="${id}" ${extra}><rect x="${x}" y="${y}" width="28" height="8" fill="${fill}"/><text x="${x + 1}" y="${y + 5}" font-size="2.7">${text}</text></g>`;
}
async function audit(body, facts = ir) {
  return wireLabelSupportAudit(await openSheet(page, svg(body)), facts)
    .findings;
}
const straight = route("A", "M 10 30 L 110 30");
const second = route("B", "M 10 50 L 110 50");
const masks = (findings) =>
  findings.filter((f) => f.kind === "wire-label-plate-masks-conductor");

it.each([
  ["terminal approach", straight, 10, 26, "approach"],
  ["elbow", route("A", "M 10 10 L 10 30 L 110 30"), 10, 26, "elbow-or-branch"],
  [
    "corner-touch",
    route("A", "M 38 10 L 38 35") + second,
    10,
    46,
    "foreign-conductor",
  ],
  ["exchanged label", straight + second, 30, 46, "foreign-conductor"],
  [
    "junction",
    straight +
      '<circle data-circuit-junction="true" cx="40" cy="30" r=".65" fill="black"/>',
    30,
    26,
    "junction",
  ],
])("DQ-16 rejects a plate at the %s", async (_name, routes, x, y, reason) => {
  expect(masks(await audit(routes + label("A", x, y)))).toEqual([
    expect.objectContaining({ reason }),
  ]);
});

it("DQ-16 accepts native inline plates and separate same-text conductors", async () => {
  expect(await audit(straight + label("A", 30, 26))).toEqual([]);
  const same = structuredClone(ir);
  for (const w of same.wires) w.designation = "SAME";
  expect(
    await audit(
      straight +
        second +
        label("A", 30, 26, "white", "", "SAME") +
        label("B", 30, 46, "white", "", "SAME"),
      same,
    ),
  ).toEqual([]);
});

it("DQ-16 treats a collinear SVG subdivision as continuous straight ink", async () => {
  expect(
    await audit(route("A", "M 10 30 L 42 30 L 110 30") + label("A", 30, 26)),
  ).toEqual([]);
});

it("DQ-16 checks native text and endpoints before accepting an inline plate", async () => {
  const lie = label("A", 30, 26, "white", 'data-native-owner="A"', "B");
  expect(masks(await audit(straight + lie))).toHaveLength(1);
  const wrong = straight.replace('"terminalKey":"T"', '"terminalKey":"wrong"');
  expect(masks(await audit(wrong + label("A", 30, 26)))).toHaveLength(1);
});

it("DQ-16 sees actual paint order, fill and viewport", async () => {
  expect(masks(await audit(label("A", 10, 26) + straight))).toEqual([]);
  expect(masks(await audit(straight + label("A", 10, 26, "none")))).toEqual([]);
  expect(
    masks(
      await audit(
        straight + label("A", 10, 26).replace("<rect", '<rect opacity="0"'),
      ),
    ),
  ).toEqual([]);
});
