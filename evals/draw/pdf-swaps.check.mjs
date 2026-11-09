// Real CLI PDF producer, pdf.js renderer, exported instance boxes; no Apple PDFKit raster.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packetPdf } from "../../packages/cli/dist/alpha-pdf.js";
import { pdfCalibration } from "./pdf-calibration.mjs";
import { pinnedSource } from "./source-hashes.mjs";
import { capturePdfCrop, pdfCaptureEnvironment } from "./pdf-source.mjs";
import { launch, openSheet, drawingContextOptions } from "./browser.mjs";
import {
  compareSourcePixels,
  sourcePixelStats,
  pixelRefusal,
} from "./crop-source-pixels.mjs";
import { hash } from "./support.mjs";
const { values: v } = parseArgs({
  options: { report: { type: "string" }, output: { type: "string" } },
});
assert(
  v.report && v.output,
  "Use --report <summary.json> --output <pdf-swaps.json>",
);
const c = await pdfCalibration(v.report),
  sorted = c.samples.toSorted(
    (a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h,
  ),
  results = [],
  baseline = [];
const pairs = [
  ["1", "7"],
  ["3", "8"],
  ["5", "6"],
  ["0", "8"],
  ["6", "8"],
  ["1", "l"],
  ["I", "l"],
  ["O", "0"],
  [",", "."],
  [":", ";"],
  ["-", "–"],
  ["C", "G"],
  ["E", "F"],
  ["P", "R"],
  ["V", "Y"],
];
const common = sorted.find((t) => {
  const a = c.associated.get(t.row);
  return (
    a.fontFace === "NotoSans-Regular" &&
    Math.abs(a.fontMm - 2.2) < 0.001 &&
    a.text === "ASSIGNED / USAGE UNSPECIFIED"
  );
});
assert(common, "Missing common 2.2 mm Regular mid-string control");
const targets = [
  { size: "smallest", t: sorted[0], at: 0, pairs },
  { size: "largest", t: sorted.at(-1), at: 0, pairs },
  {
    size: "smallest-middle",
    t: sorted[0],
    at: 1,
    pairs: [...pairs, ["O", "Q"]],
  },
  { size: "common-middle", t: common, at: 9, pairs: [...pairs, ["O", "Q"]] },
];
const browser = await launch();
try {
  const context = await browser.newContext(drawingContextOptions),
    page = await context.newPage();
  await page.emulateMedia({ media: "print" });
  for (const { size, t, at, pairs } of targets) {
    const ref = pinnedSource(c.report, t),
      directory = join(c.root, t.scope.case),
      packet = JSON.parse(await readFile(join(directory, "packet.json")));
    for (const s of packet.sheets)
      s.svg = await readFile(
        join(directory, `sheet-${String(s.number).padStart(3, "0")}.svg`),
        "utf8",
      );
    const sheet = packet.sheets.find((s) => s.number === t.physicalSheet),
      originalSvg = sheet.svg;
    await openSheet(page, originalSvg);
    const node = await page.evaluate(
      ({ text, box }) => {
        const svg = document.querySelector("body>svg"),
          r = svg.getBoundingClientRect(),
          sx = svg.viewBox.baseVal.width / r.width;
        return [...svg.querySelectorAll("text")]
          .map((n, i) => {
            const b = n.getBoundingClientRect(),
              x = (b.x - r.x) * sx,
              y = (b.y - r.y) * sx,
              w = b.width * sx,
              h = b.height * sx;
            return {
              i,
              text: n.textContent.trim().replace(/\s+/g, " "),
              x,
              y,
              w,
              h,
            };
          })
          .filter(
            (n) =>
              n.text === text.replace(/\s+/g, " ") &&
              n.x < box.x + box.w &&
              n.x + n.w > box.x &&
              n.y < box.y + box.h &&
              n.y + n.h > box.y,
          )
          .sort(
            (a, b) =>
              Math.hypot(
                a.x + a.w / 2 - box.x - box.w / 2,
                a.y + a.h / 2 - box.y - box.h / 2,
              ) -
              Math.hypot(
                b.x + b.w / 2 - box.x - box.w / 2,
                b.y + b.h / 2 - box.y - box.h / 2,
              ),
          )[0];
      },
      { text: t.facts.text, box: t.bbox },
    );
    assert(node, "No SVG text matching the actual PDF page/box association");
    const row = {
      scope: t.scope,
      physicalSheet: t.physicalSheet,
      instanceBbox: t.bbox,
      sourceBbox: t.bbox,
      sourceRender: {
        medium: "pdf",
        pdf: ref.path,
        pdfSha256: ref.sha256,
        backend: ref.backend,
        pdfjsVersion: ref.pdfjsVersion,
        page: ref.page,
      },
    };
    const delivered = await capturePdfCrop(
        await readFile(join(c.root, ref.path)),
        row,
      ),
      reproduced = await packetPdf(packet, "PDF calibration");
    const same = await capturePdfCrop(reproduced, {
      ...row,
      sourceRender: { ...row.sourceRender, pdfSha256: hash(reproduced) },
    });
    baseline.push({
      size,
      row: t.row,
      stats: compareSourcePixels(delivered, same),
      pdf: ref,
      association: c.associated.get(t.row),
    });
    async function variant(char) {
      await openSheet(page, originalSvg);
      sheet.svg = await page.evaluate(
        ({ i, char, at }) => {
          const svg = document.querySelector("body>svg"),
            t = svg.querySelectorAll("text")[i],
            text = t.textContent,
            position = text.search(/\S/) + at;
          if (position < 0 || position >= text.trimEnd().length)
            throw Error("Character control position is outside the text");
          t.textContent =
            text.slice(0, position) + char + text.slice(position + 1);
          return svg.outerHTML;
        },
        { i: node.i, char, at },
      );
      return packetPdf(packet, "PDF character calibration");
    }
    for (const [a, b] of pairs) {
      const A = await variant(a),
        B = await variant(b),
        wrong = await capturePdfCrop(A, {
          ...row,
          sourceRender: { ...row.sourceRender, pdfSha256: hash(A) },
        }),
        comparisons = [];
      // Calibration trials, not a bind attempt chain: measure all three fresh
      // loads even after an accepted comparison, so clipping remains visible.
      for (let reference = 1; reference <= 3; reference++) {
        const png = await capturePdfCrop(B, {
            ...row,
            sourceRender: { ...row.sourceRender, pdfSha256: hash(B) },
          }),
          stats = sourcePixelStats(wrong, png),
          reason = pixelRefusal(stats);
        comparisons.push({
          reference,
          referenceSha256: hash(png),
          stats,
          verdict: reason ? "refused" : "pass",
          reason,
        });
      }
      const refused = comparisons.every((a) => a.verdict === "refused"),
        knownGap =
          !refused && a === "O" && b === "Q"
            ? "Exported em box clips the distinguishing Q tail; inspect the pinned page."
            : null;
      results.push({
        size,
        position: at,
        row: t.row,
        physicalSheet: t.physicalSheet,
        box: t.bbox,
        classification: t.classification,
        font: c.associated.get(t.row),
        swap: `${a}→${b}`,
        frozenSha256: hash(wrong),
        wrongPdfSha256: hash(A),
        referencePdfSha256: hash(B),
        refused,
        knownGap,
        comparisons,
      });
    }
    process.stdout.write(`${size}: ${pairs.length} frozen controls\n`);
  }
} finally {
  await browser.close();
}
const data = {
  format: "thermite-draw-pdf-swaps/2.0",
  applyTarget: false,
  originalReportSha256: c.originalSha256,
  calibrationReportSha256: c.calibrationSha256,
  capture: pdfCaptureEnvironment(),
  controls: results.length,
  comparisons: results.reduce((n, r) => n + r.comparisons.length, 0),
  accepted: results.filter((r) => !r.refused).length,
  acceptedComparisons: results
    .flatMap((r) => r.comparisons)
    .filter((a) => a.verdict === "pass").length,
  knownGaps: results.filter((r) => r.knownGap).length,
  minMaximum: Math.min(
    ...results.flatMap((r) => r.comparisons.map((a) => a.stats.maximum)),
  ),
  baseline,
  results,
};
await writeFile(resolve(v.output), JSON.stringify(data, null, 2) + "\n", {
  flag: "wx",
});
console.log(
  JSON.stringify({ ...data, baseline: undefined, results: undefined }),
);
assert(
  data.controls === 62 &&
    data.comparisons === 186 &&
    results.every((r) => r.refused || r.knownGap),
  "PDF swap calibration must record all trials; only the known O/Q clipping gap may pass",
);
