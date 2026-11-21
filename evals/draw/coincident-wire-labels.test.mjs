import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { coincidentWireLabels } from "./coincident-wire-labels.mjs";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
});

const route = (id, d) =>
  `<g data-circuit-conductor="${id}" data-net-id="same-net"><path d="${d}" stroke="black" fill="none"/></g>`;
const group = (id, body) => `<g data-circuit-group="${id}">${body}</g>`;
const caption =
  '<g data-wire-label="A" data-circuit-caption-fallback="fully-coincident"><text x="15" y="20">FIXED2</text></g>';
async function measure(own, foreign, outside = "") {
  const body = group("g1", caption + route("A", own) + foreign) + outside;
  const geometry = await openSheet(
    page,
    `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">${body}</svg>`,
  );
  return coincidentWireLabels(geometry);
}

it("flags a caption when reversed and stitched foreign runs cover its entire route", async () => {
  expect(
    await measure(
      "M 10 25 H 50 V 40",
      route("B", "M 35 25 H 10") + route("C", "M 35 25 H 50 V 40"),
    ),
  ).toEqual([
    expect.objectContaining({
      kind: "fully-coincident-wire-label",
      wire: "A",
      text: "FIXED2",
    }),
  ]);
});

it("clears a route with an uncovered tail, a gap, or visibly separated ink", async () => {
  for (const variant of [
    route("B", "M 10 25 H 50 V 39.99"),
    route("B", "M 10 25 H 30") + route("C", "M 30.01 25 H 50 V 40"),
    route("B", "M 10 26.25 H 50 V 40"),
    route("A", "M 10 25 H 50 V 40"),
  ]) {
    expect(await measure("M 10 25 H 50 V 40", variant)).toEqual([]);
  }
});

it("does not borrow coverage from other circuit groups", async () => {
  expect(
    await measure(
      "M 10 25 H 50",
      route("B", "M 30 25 V 40"),
      group("g2", route("C", "M 10 25 H 50")),
    ),
  ).toEqual([]);
});
