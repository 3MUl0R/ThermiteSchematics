import { painted } from "./review-geometry.mjs";
import { referenceClauses } from "./navigation-reference-clauses.mjs";
export const escapeReference = (s) =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hasReferenceName = (text, name) =>
  new RegExp(
    "(?<![\\p{L}\\p{N}_])" + escapeReference(name) + "(?![\\p{L}\\p{N}_])",
    "u",
  ).test(text);
export const referenceTokens = (text) =>
  [
    ...text.matchAll(
      /(?<![\p{L}\p{N}_.])(?:P(\d+)\s*\/\s*)?S?(\d+)[. :]([A-Z]+\d+)\b/gu,
    ),
  ].map((m) => ({
    part: m[1] && Number(m[1]),
    sheet: Number(m[2]),
    zone: m[3],
  }));
// Group only measured ink; IDs locate containers, never certify ownership.
export function referenceInk(g, designations = []) {
  const groups = new Map();
  for (const t of g.texts.filter(
    (t) => painted(t) && !t.sheetText && !t.row && t.bbox,
  )) {
    const physicalScope = t.navigationAnnotationScope ?? t.navigationContainer;
    const id =
      physicalScope != null
        ? JSON.stringify([physicalScope, t.navigationAnnotation ?? null])
        : (t.navigationAnnotation ?? t.element);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(t);
  }
  return [...groups.values()].flatMap((rawRows) => {
    const rows = rawRows
      .slice()
      .sort(
        (a, b) =>
          (a.anchor?.y ?? a.bbox.y) - (b.anchor?.y ?? b.bbox.y) ||
          a.bbox.x - b.bbox.x,
      );
    const bbox = {
      x: Math.min(...rows.map((t) => t.bbox.x)),
      y: Math.min(...rows.map((t) => t.bbox.y)),
    };
    bbox.w = Math.max(...rows.map((t) => t.bbox.x + t.bbox.w)) - bbox.x;
    bbox.h = Math.max(...rows.map((t) => t.bbox.y + t.bbox.h)) - bbox.y;
    // A printed tag header belongs to this measured annotation only. Row
    // boundaries separate element/pointer clauses; they never pool targets.
    return referenceClauses(rows, referenceTokens, designations).map(
      (clause) => ({
        ...clause,
        bbox,
        rows,
      }),
    );
  });
}
