import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { deviceTags } from "./checks.mjs";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
});
const name = "MMMMMMMMMMMMMM";
const ir = {
  devices: [{ uid: "a", designation: name, typeId: "t" }],
  deviceTypes: [{ id: "t" }],
};
const body = `<g data-device-uid="a"><rect x="5" y="5" width="185" height="45" fill="white" stroke="black"/><text x="10" y="30" font-family="Thermite Sans" font-size="10" data-tag-owner-uid="a" data-tag-kind="body" data-tag-block="a" data-tag-field="designation">${name}</text>COVER</g>`;
const svg = (cover = "") =>
  embedPrintableFont(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="60mm" viewBox="0 0 200 60">${body.replace("COVER", cover)}</svg>`,
  );
it.each([
  { height: 0.4, covered: 38 / 77, pass: true },
  { height: 0.5, covered: 39 / 77, pass: false },
])(
  "262.4 partial glyph coverage $covered preserves the strict majority boundary",
  async ({ height, covered, pass }) => {
    const clear = await openSheet(page, svg());
    expect(deviceTags(clear, ir, [{ deviceUid: "a" }], true)).toEqual([]);
    const b = clear.texts.find((t) => t.tagOwnerUid === "a").bbox;
    // A continuous stepped white overpaint changes one of 77 actual glyph samples.
    // No glyph/paint flags are forged, and the complete native tag stays intact.
    const cover = `<rect x="${b.x + b.w * 0.46}" y="8" width="190" height="35" fill="white"/><rect x="${b.x + b.w * 0.44}" y="${b.y}" width="${b.w * 0.02}" height="${b.h * height}" fill="white"/>`;
    const g = await openSheet(page, svg(cover)),
      row = g.texts.find((t) => t.tagOwnerUid === "a");
    expect(row.tagOcclusion).toBeCloseTo(covered, 10);
    expect(Math.abs(row.tagOcclusion - 0.5)).toBeLessThan(0.01);
    expect(row.tagPainted).toBe(pass);
    expect(deviceTags(g, ir, [{ deviceUid: "a" }], true).length === 0).toBe(
      pass,
    );
  },
);
