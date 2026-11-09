// Browser work is explicit at bind time; unit tests use decoded synthetic rasters.
import { verificationFact } from "./crop-report.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";
import { within } from "./repin-io.mjs";
import { hash, json, canonical } from "./support.mjs";
import { assertCropContainsInstance } from "./crop-geometry.mjs";
import { compareSourcePixels } from "./crop-source-pixels.mjs";

export async function readCropSource(sourceRoot, row) {
  const r = row.sourceRender,
    medium = r?.medium;
  assert(
    ["svg", "html"].includes(medium) && medium === row.scope?.medium,
    "Source render must name the cited SVG/HTML medium",
  );
  const path = r[medium],
    sha = r[medium + "Sha256"];
  assert(
    typeof path === "string" &&
      !isAbsolute(path) &&
      !path.split(/[\\/]/).includes(".."),
    "Source render path must be relative without traversal",
  );
  const target = await within(resolve(sourceRoot, path), sourceRoot, {
    existing: true,
  });
  const bytes = await readFile(target);
  assert(hash(bytes) === sha, "Source render hash differs from index");
  return {
    text: (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"),
    sha,
  };
}
export async function renderSourceCrop(page, text, row) {
  const { openSheet, screenshotCrop } = await import("./browser.mjs");
  const html = row.scope.medium === "html";
  if (html) {
    await page.setContent(text);
    await page.evaluate(() => document.fonts.ready);
  } else await openSheet(page, text);
  const selector = html ? `#sheet-${row.physicalSheet}>svg` : "body>svg";
  const size = await page.evaluate((sel) => {
    const v = document.querySelector(sel)?.viewBox.baseVal;
    return v && { w: v.width, h: v.height };
  }, selector);
  const b = canonical(row.sourceBbox);
  assert(
    size &&
      b.x >= 0 &&
      b.y >= 0 &&
      b.x + b.w <= size.w + 0.001 &&
      b.y + b.h <= size.h + 0.001,
    "Source crop is outside the physical sheet",
  );
  return screenshotCrop(page, b, undefined, selector);
}
export async function verifyCropSources(sourceRoot, index, crops) {
  const refusals = [];
  const proofs = new Map(),
    rasters = new Map();
  if (!index.crops.length) return proofs;
  assert(
    sourceRoot,
    "Supply --source-root <checkpoint> to verify crop pixels with Chromium; no source checks are skipped",
  );
  const { launch } = await import("./browser.mjs");
  const browser = await launch(); // Missing Chromium is an explicit infrastructure refusal.
  try {
    const { drawingContextOptions } = await import("./browser.mjs");
    const context = await browser.newContext(drawingContextOptions);
    const page = await context.newPage();
    await page.emulateMedia({ media: "print" });
    for (const row of index.crops) {
      try {
        assertCropContainsInstance({ bbox: row.instanceBbox }, row.sourceBbox);
        assert(
          Number.isSafeInteger(row.physicalSheet) && row.physicalSheet > 0,
          "Source crop requires a positive physicalSheet",
        );
        const source = await readCropSource(
          sourceRoot instanceof Map
            ? sourceRoot.get(row.reportSha256)
            : sourceRoot,
          row,
        );
        const key = json([
          source.sha,
          row.scope.medium,
          row.physicalSheet,
          row.sourceBbox,
        ]);
        if (!rasters.has(key))
          rasters.set(key, await renderSourceCrop(page, source.text, row));
        const raster = rasters.get(key);
        compareSourcePixels(crops.get(row.path), raster, row.headerPixels ?? 0);
        proofs.set(row.path, verificationFact(row, source.sha));
      } catch (error) {
        refusals.push({ crop: row.path, reason: error.message });
      }
    }
  } finally {
    await browser.close();
  }
  assert(
    !refusals.length,
    "Source verification refused " +
      refusals.length +
      " crop(s):\n" +
      refusals.map((r) => r.crop + ": " + r.reason).join("\n"),
  );
  return proofs;
}
