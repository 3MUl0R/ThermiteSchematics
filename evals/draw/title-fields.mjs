import { finding, painted } from "./review-geometry.mjs";
export function titleFields(g) {
  const panel = g.titleBlock;
  const title = g.texts
    .filter(
      (t) =>
        painted(t) &&
        panel &&
        t.bbox.x >= panel.x - 0.001 &&
        t.bbox.y >= panel.y - 0.001 &&
        t.bbox.x + t.bbox.w <= panel.x + panel.w + 0.001 &&
        t.bbox.y + t.bbox.h <= panel.y + panel.h + 0.001,
    )
    .map((t) => t.text)
    .join("\n");
  const fields = {
    drawingNumber: /\b(?:drawing\s*(?:no\.?|number)|dwg\s*no\.?)\s*:/i,
    drawn: /\bdrawn(?: by)?\s*:/i,
    checked: /\bchecked(?: by)?\s*:/i,
    approved: /\bapproved(?: by)?\s*:/i,
    customerOrSite: /\b(?:customer|site|company)\s*:/i,
    revision: /\bREV\s+(?!UNSPECIFIED\b)\S+/,
    revisionHistory: /\b(?:revision\s+(?:history|table)|rev\s+date)\b/i,
  };
  const missing = Object.keys(fields).filter((k) => !fields[k].test(title));
  return missing.length
    ? [finding("incomplete-title-block", {}, { missing })]
    : [];
}
