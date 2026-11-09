// Pure report/entry binding. Geometry and labels come from hash-bound instances.
import { assertCropContainsInstance } from "./crop-geometry.mjs";
import assert from "node:assert/strict";
import { instanceInventory } from "./repin-core.mjs";
import { canonical, json } from "./support.mjs";
import { pinnedSource } from "./source-hashes.mjs";
import { drawingReferences } from "./repin-drawing-bindings.mjs";
const same = (a, b, message) => assert(json(a) === json(b), message);
const ascii = (s) =>
  String(s).replace(
    /[^\x20-\x7e]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
export const cropHeader = (t) => [
  `${t.markerId} | ${t.scope.medium.toUpperCase()} | 300 dpi`,
  `${t.scope.case} | ${ascii(t.scope.sheet)} | physical page ${t.physicalSheet}`,
  `Report instance ${t.token}`,
  `Text ${ascii(t.facts.text)}`,
];
export function sourcePath(t) {
  assert(
    t.scope.medium !== "pdf",
    "PDF crop source verification is not implemented; SVG/HTML evidence cannot stand in for a PDF crop",
  );
  return t.scope.medium === "html"
    ? `${t.scope.case}/packet.html.gz`
    : `${t.scope.case}/sheet-${String(t.physicalSheet).padStart(3, "0")}.svg`;
}
export function reportInstances(reports) {
  return new Map(
    [...reports].map(([sha, r]) => [sha, instanceInventory(r, sha)]),
  );
}
export function renameCropPairs(entry) {
  const pairs = entry.pairs ?? [],
    changed = pairs.filter((p) => p.text && p.text.from !== p.text.to);
  return changed.length ? changed : pairs;
}
export function entryTokens(file, entry, crop) {
  if (entry !== crop)
    return entry.action === "rename"
      ? renameCropPairs(entry).map((p) => p.to)
      : (entry.instances ?? []);
  const d = (file.notMove ?? []).find((d) => d.crops?.includes(crop));
  assert(d, "Crop has no decision reference");
  return [d.crops.indexOf(crop) === 0 ? d.from : d.to];
}
function checkTarget(file, entry, crop, t) {
  const ref = entry.to;
  if (ref) {
    assert(
      ref.scope.medium !== "pdf",
      "PDF crop source verification is not implemented; a PDF-scope entry cannot use SVG/HTML evidence",
    );
    same(
      ref,
      { markerId: t.markerId, scope: t.scope },
      "Crop entry marker/scope differs from report instance",
    );
  }
  assert(
    entryTokens(file, entry, crop).includes(t.token),
    "Crop token is not one of the entry's instances eligible for this crop; text-changing renames must cite a changed-text pair",
  );
}
export function checkIndexedEntries(file, index, reports) {
  assert(
    reports.has(file.summarySha256),
    "Bind requires the exact --report named by summarySha256",
  );
  const inventories = reportInstances(reports),
    rows = new Map(index.crops.map((c) => [c.path, c]));
  const errors = [];
  for (const { entry, crop } of drawingReferences(file)) {
    try {
      const c = rows.get(crop.path);
      assert(c, "Cited crop is missing from index");
      const t = inventories.get(c.reportSha256)?.byToken.get(c.token);
      assert(
        t,
        "Crop token/report hash is not in the supplied report or baseline",
      );
      checkTarget(file, entry, crop, t);
      same(
        c.scope,
        t.scope,
        "Crop case/medium/view differs from report instance",
      );
      same(c.markerId, t.markerId, "Crop marker differs from report instance");
      same(
        c.instanceBbox,
        t.bbox,
        "Crop instance box differs from report instance",
      );
      assert(
        c.row === t.row && c.physicalSheet === t.physicalSheet,
        "Crop row/physical sheet differs from report instance",
      );
      assert(c.text === t.facts.text, "Crop text differs from report instance");
      sourcePath(t); // PDF has no source-verification path.
      const ref = pinnedSource(reports.get(c.reportSha256), t),
        expected = ref.path,
        r = c.sourceRender;
      assert(
        r?.medium === t.scope.medium && r[t.scope.medium] === expected,
        "Source path must match the report case and physical sheet",
      );
      assert(
        r[t.scope.medium + "Sha256"] === ref.sha256,
        "Source render hash differs from C1 report",
      );
      assertCropContainsInstance({ bbox: c.instanceBbox }, c.sourceBbox);
      if (c.headerPixels === 86)
        same(
          c.headerLines,
          cropHeader(t),
          "Crop header differs from report instance",
        );
    } catch (e) {
      errors.push(crop.path + ": " + e.message);
    }
  }
  assert(!errors.length, "Crop/report refusals:\n" + errors.join("\n"));
}
export function checkReportedSources(file, reports) {
  const inventories = reportInstances(reports);
  for (const { entry, crop } of drawingReferences(file)) {
    const v = entry.sourceVerification;
    const t = inventories.get(v?.reportSha256)?.byToken.get(v?.token);
    assert(t, "Source attestation token/report is not in the bound report");
    checkTarget(file, entry, crop, t);
    same(v.scope, t.scope, "Source attestation scope differs from report");
    assert(
      v.markerId === t.markerId && v.row === t.row,
      "Source attestation identity differs from report",
    );
    assert(
      v.medium === t.scope.medium && v.sheet === t.physicalSheet,
      "Source attestation medium/physical sheet differs from report",
    );
    same(
      v.instanceBbox,
      canonical(t.bbox),
      "Source attestation instance box differs from report",
    );
    assert(
      v.text === t.facts.text &&
        v.sourcePath === pinnedSource(reports.get(v.reportSha256), t).path,
      "Source attestation text/path differs from report",
    );
    assert(
      v.sourceSha256 === pinnedSource(reports.get(v.reportSha256), t).sha256,
      "Source attestation hash differs from C1 report",
    );
  }
}

export function verificationFact(row, sourceSha256) {
  return {
    format: "thermite-draw-source-crop/1.0",
    sourceSha256,
    medium: row.scope.medium,
    sheet: row.physicalSheet,
    dpi: 300,
    sourceBbox: canonical(row.sourceBbox),
    instanceBbox: canonical(row.instanceBbox),
    reportSha256: row.reportSha256,
    token: row.token,
    markerId: row.markerId,
    scope: row.scope,
    text: row.text,
    row: row.row,
    sourcePath: row.sourceRender[row.scope.medium],
  };
}
