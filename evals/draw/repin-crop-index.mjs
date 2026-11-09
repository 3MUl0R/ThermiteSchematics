// Build evidence with report-owned instance geometry. No sign-off or cause is written.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { strictJsonFile, within } from "./repin-io.mjs";
import { json, canonical, hash } from "./support.mjs";
import { pipelineCrops, cropPlans, instanceCropRow } from "./crop-index.mjs";
import { pinnedSource, assertSourceBytes } from "./source-hashes.mjs";
const { values: v } = parseArgs({
  options: {
    report: { type: "string" },
    "source-root": { type: "string" },
    baseline: { type: "string", multiple: true },
    decisions: { type: "string" },
    output: { type: "string" },
    index: { type: "string" },
    samples: { type: "string" },
  },
});
assert(
  v.report && v.index,
  "Use --report <summary.json> --index <index.json> [--decisions <unsigned.json> --output <prepared.json> --samples <directory>]",
);
const root = fileURLToPath(new URL("../../", import.meta.url)),
  reports = new Map(),
  roots = new Map();
for (const path of [v.report, ...(v.baseline ?? [])]) {
  const r = await strictJsonFile(resolve(path));
  reports.set(r.sha256, r.value);
  roots.set(r.sha256, dirname(resolve(path)));
}
const current = await strictJsonFile(resolve(v.report));
if (v["source-root"]) roots.set(current.sha256, resolve(v["source-root"]));
if (!v.decisions) {
  const rows = pipelineCrops(current.value, current.sha256);
  const out = await within(resolve(v.index), join(root, "evals/out"));
  await writeFile(
    out,
    json({
      format: "thermite-draw-pipeline-crops/1.0",
      reportSha256: current.sha256,
      crops: rows,
    }),
    { flag: "wx" },
  );
  process.stdout.write(
    `Indexed ${rows.length} pipeline crops, ${rows.filter((c) => !c.supported).length} unsupported PDF crops.\n`,
  );
} else {
  assert(
    v.output && v.samples,
    "Decision crops require --output and --samples",
  );
  const file = await strictJsonFile(resolve(v.decisions));
  assert(
    file.value.summarySha256 === current.sha256,
    "Draft/report hash mismatch",
  );
  assert(
    file.value.entries.every(
      (e) => e.reviewed === false && !e.signOff?.kind && !e.signOff?.by,
    ),
    "Build crops before sign-off",
  );
  const draft = structuredClone(file.value),
    plans = cropPlans(draft, reports),
    rows = [];
  await mkdir(join(root, "evals/out/draw-samples"), { recursive: true });
  const samples = resolve(v.samples);
  const samplesRoot = join(root, "evals/out/draw-samples");
  await within(samples, samplesRoot);
  await mkdir(samples);
  await within(samples, samplesRoot, { existing: true });
  const { stampInstanceDrawingCrop } =
    await import("../../scripts/stamp-drawing-crop.mjs");
  let browser, page;
  try {
    for (const plan of plans) {
      const medium = plan.t.scope.medium,
        sourceRoot = roots.get(plan.reportSha256),
        sourceRef = pinnedSource(reports.get(plan.reportSha256), plan.t),
        source = await readFile(
          await within(join(sourceRoot, sourceRef.path), sourceRoot, {
            existing: true,
          }),
        );
      assertSourceBytes(source, sourceRef);
      plan.sourceRef = sourceRef;
      let box = plan.sourceBbox,
        raw;
      if (plan.pipelineCrop)
        raw = await readFile(
          await within(join(sourceRoot, plan.pipelineCrop), sourceRoot, {
            existing: true,
          }),
        );
      else {
        const { launch, drawingContextOptions, cropBox } =
          await import("./browser.mjs");
        const { renderSourceCrop } = await import("./crop-source.mjs");
        if (!browser) {
          browser = await launch();
          const c = await browser.newContext(drawingContextOptions);
          page = await c.newPage();
          await page.emulateMedia({ media: "print" });
        }
        // The target is measured; a crop is derived from that instance, never from the row's first finding.
        const text = sourceRef.path.endsWith(".gz")
          ? (await import("node:zlib")).gunzipSync(source).toString()
          : source.toString();
        const { parseHTML } = await import("linkedom");
        const doc = parseHTML(text).document;
        const svg =
          medium === "html"
            ? doc.querySelector(`#sheet-${plan.t.physicalSheet}>svg`)
            : doc.querySelector("svg");
        const vb = svg.getAttribute("viewBox").split(/\s+/).map(Number);
        box = canonical(cropBox(plan.t.bbox, vb[2], vb[3]));
        raw = await renderSourceCrop(page, text, {
          scope: plan.t.scope,
          physicalSheet: plan.t.physicalSheet,
          sourceBbox: box,
        });
      }
      const bytes = await stampInstanceDrawingCrop(
        raw,
        plan.headerLines,
        { bbox: plan.t.bbox },
        box,
      );
      const path = relative(root, join(samples, plan.name))
        .split("\\")
        .join("/");
      await writeFile(join(root, path), bytes, { flag: "wx" });
      Object.assign(plan.crop, { path, sha256: hash(bytes) });
      rows.push(instanceCropRow(plan, path, bytes, box, source));
    }
  } finally {
    await browser?.close();
  }
  await writeFile(
    await within(resolve(v.index), join(root, "evals/out")),
    json({ format: "thermite-draw-crop-index/2.0", crops: rows }),
    { flag: "wx" },
  );
  await writeFile(
    await within(resolve(v.output), join(root, "evals/out")),
    json(draft),
    { flag: "wx" },
  );
  process.stdout.write(
    `Prepared ${rows.length} crops and an unreviewed draft.\n`,
  );
}
