// Prepare pixel facts before an independent reviewer signs; never writes approvals.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { strictJsonFile, within, readReviewedCrop } from "./repin-io.mjs";
import {
  bindDrawingDraft,
  drawingReferences,
} from "./repin-drawing-bindings.mjs";
import { verifyCropSources } from "./crop-source.mjs";
import { checkIndexedEntries } from "./crop-report.mjs";
import { verifyStampHeaders } from "./crop-stamp-check.mjs";
import { json } from "./support.mjs";
const { values } = parseArgs({
  options: {
    decisions: { type: "string" },
    report: { type: "string" },
    baseline: { type: "string", multiple: true },
    "crop-index": { type: "string" },
    output: { type: "string" },
    "source-root": { type: "string" },
  },
});
assert(
  values.decisions && values["crop-index"] && values.output,
  "Supply --decisions <unreviewed.json> --crop-index <index.json> --output <bound-draft.json>",
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const file = await strictJsonFile(resolve(values.decisions)),
  index = await strictJsonFile(resolve(values["crop-index"]));
const reports = new Map(),
  roots = new Map();
if (drawingReferences(file.value).length) {
  assert(values.report, "Cropped bindings require --report <summary.json>");
  for (const path of [values.report, ...(values.baseline ?? [])]) {
    const r = await strictJsonFile(resolve(path));
    reports.set(r.sha256, r.value);
    roots.set(r.sha256, dirname(resolve(path)));
  }
  if (values["source-root"])
    roots.set(file.value.summarySha256, resolve(values["source-root"]));
  checkIndexedEntries(file.value, index.value, reports);
}
const crops = new Map();
for (const c of index.value.crops)
  crops.set(c.path, await readReviewedCrop(root, c));
const bound = bindDrawingDraft(file.value, index.value, crops);
await verifyStampHeaders(index.value, crops);
const proofs = await verifyCropSources(roots, index.value, crops);
for (const { entry, crop } of drawingReferences(bound))
  entry.sourceVerification = proofs.get(crop.path);
await within(resolve(root, "evals/out"), root, { existing: true });
const output = await within(resolve(values.output), resolve(root, "evals/out"));
await writeFile(output, json(bound), { flag: "wx" });
process.stdout.write(
  `Bound drawing hashes and verified source pixels from ${crops.size} crops; all entries remain unreviewed.\n`,
);
