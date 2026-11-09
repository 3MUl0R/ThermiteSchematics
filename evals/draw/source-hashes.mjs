// Report-owned hashes of delivered artifacts; no renderer estimates or browser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./support.mjs";
export const SOURCE_HASH_FORMAT = "thermite-draw-sources/1.0";
export async function captureSources(directory, caseId, sheets, htmlFile) {
  const html = await readFile(join(directory, htmlFile));
  return Promise.all(
    sheets.map(async (sheet) => {
      const svgFile = `sheet-${String(sheet).padStart(3, "0")}.svg`;
      return {
        case: caseId,
        sheet,
        svg: {
          path: `${caseId}/${svgFile}`,
          sha256: hash(await readFile(join(directory, svgFile))),
        },
        html: { path: `${caseId}/${htmlFile}`, sha256: hash(html) },
      };
    }),
  );
}
export function pinnedSource(report, t, context) {
  const pins = report.sourceHashes;
  assert(
    pins?.format === SOURCE_HASH_FORMAT && Array.isArray(pins.sheets),
    context
      ? `Run a fresh C1: ${context.role} ${JSON.stringify(context.path)} (SHA-256 ${context.sha256}) has no pinned source hashes; regenerate this ${context.role} at its original source revision. A fresh target cannot supply baseline pins.`
      : "Run a fresh C1: report has no pinned source hashes; older reports cannot verify crop sources",
  );
  const sheets = pins.sheets.filter(
      (s) => s.case === t.scope.case && s.sheet === t.physicalSheet,
    ),
    ref = sheets[0]?.[t.scope.medium];
  assert(
    sheets.length === 1 && /^[a-f0-9]{64}$/.test(ref?.sha256 ?? ""),
    `Missing or ambiguous pinned source for case=${t.scope.case} view=${t.scope.sheet} page=${t.physicalSheet} marker=${t.markerId}`,
  );
  const expected =
    t.scope.medium === "html"
      ? [`${t.scope.case}/packet.html.gz`, `${t.scope.case}/packet.html`]
      : [
          `${t.scope.case}/sheet-${String(t.physicalSheet).padStart(3, "0")}.svg`,
        ];
  assert(
    expected.includes(ref.path),
    "Pinned source path differs from report case and physical sheet",
  );
  return ref;
}
export function assertSourceBytes(bytes, ref) {
  assert(
    hash(bytes) === ref.sha256,
    "Source render hash differs from C1 report",
  );
}
