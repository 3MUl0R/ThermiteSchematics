import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  launch,
  drawingContextOptions,
  openSheet,
} from "../../../evals/draw/browser.mjs";
import { embedPrintableFont } from "../../cli/dist/printable-font.js";

// Temporary evidence only: actual test/checker launch arguments stay unchanged.
const out = process.argv[2];
if (!out) throw Error("Provide an evidence directory");
await mkdir(out, { recursive: true });
const name = "MMMMMMMMMMMMMM";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(size, cover = "") {
  return embedPrintableFont(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="60mm" viewBox="0 0 200 60">' +
      '<g data-device-uid="a"><rect x="5" y="5" width="185" height="45" fill="white" stroke="black"/>' +
      '<text x="0" y="0" transform="translate(10 30) scale(' +
      10 / size +
      ')" font-family="Thermite Sans" font-size="' +
      size +
      '" data-tag-owner-uid="a" data-tag-kind="body" data-tag-block="a" data-tag-field="designation">' +
      name +
      "</text>" +
      cover +
      "</g></svg>",
  );
}
const variants = [
  ["default", []],
  ["no-hinting", ["--font-render-hinting=none"]],
  [
    "precise-bounds",
    ["--enable-blink-features=CanvasTextMetricsPreciseBounds"],
  ],
  [
    "precise-no-hinting",
    [
      "--enable-blink-features=CanvasTextMetricsPreciseBounds",
      "--font-render-hinting=none",
    ],
  ],
];
for (const [variant, args] of variants) {
  const browser = await launch(args);
  try {
    const context = await browser.newContext(drawingContextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const records = [];
    for (const size of [10, 100, 4, 3.5, 2.5]) {
      const svg = fixture(size);
      const clear = (await openSheet(page, svg)).texts.find(
        (t) => t.tagOwnerUid === "a",
      );
      const fonts = await page.evaluate(() => {
        const e = document.querySelector("text");
        const css = getComputedStyle(e);
        const canvas = document.createElement("canvas").getContext("2d");
        canvas.font = css.fontSize + " " + css.fontFamily;
        const m = canvas.measureText(e.textContent);
        return {
          font: canvas.font,
          faces: [...document.fonts].map((f) => ({
            family: f.family,
            status: f.status,
          })),
          metrics: Object.fromEntries(
            [
              "width",
              "actualBoundingBoxAscent",
              "actualBoundingBoxDescent",
              "actualBoundingBoxLeft",
              "actualBoundingBoxRight",
            ].map((k) => [k, m[k]]),
          ),
        };
      });
      const image = await page.screenshot();
      const record = {
        size,
        svgHash: hash(svg),
        imageHash: hash(image),
        clear,
        fonts,
        covers: [],
      };
      const b = clear.bbox;
      const fractions = size === 100 ? [0.46] : [0.44, 0.46];
      const steps = size === 100 ? [0.02] : [0.02, 0.04];
      const heights =
        size === 100 ? [0.4, 0.5] : [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
      for (const fraction of fractions)
        for (const stepWidth of steps)
          for (const height of heights) {
            const cover =
              '<rect x="' +
              (b.x + b.w * fraction) +
              '" y="8" width="190" height="35" fill="white"/><rect x="' +
              (b.x + b.w * (fraction - stepWidth)) +
              '" y="' +
              b.y +
              '" width="' +
              b.w * stepWidth +
              '" height="' +
              b.h * height +
              '" fill="white"/>';
            const row = (
              await openSheet(page, fixture(size, cover))
            ).texts.find((t) => t.tagOwnerUid === "a");
            record.covers.push({
              fraction,
              stepWidth,
              height,
              occlusion: row.tagOcclusion,
              painted: row.tagPainted,
            });
          }
      records.push(record);
    }
    await writeFile(
      join(out, variant + ".json"),
      JSON.stringify(
        {
          variant,
          args,
          platform: process.platform,
          arch: process.arch,
          browser: await browser.version(),
          records,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Retained browser evidence: " + variant);
  } finally {
    await browser.close();
  }
}
