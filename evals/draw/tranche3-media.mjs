import { groupBy, extent, painted, finding } from "./review-geometry.mjs";

const runBox = (p) => p.paintedBox ?? p.bbox;

export function pdfRunInBox(p, box) {
  const b = runBox(p);
  if (!b || !box) return false;
  const x = b.x + b.w / 2,
    y = b.y + b.h / 2;
  return (
    x >= box.x - 0.17 &&
    x <= box.x + box.w + 0.17 &&
    y >= box.y - 0.17 &&
    y <= box.y + box.h + 0.17
  );
}

export function svgOracleGroupBox(g, ts) {
  const t = ts[0],
    cell = g.reportCells?.find(
      (c) =>
        c.documentId === t.documentId &&
        c.row === t.row &&
        c.columnIndex === t.columnIndex &&
        c.reportRowScope === t.reportRowScope,
    );
  if (cell?.bbox) return cell.bbox;
  const points = ts.flatMap((item) =>
    [item.bbox, item.emBbox]
      .filter(Boolean)
      .flatMap((b) => [b, { x: b.x + b.w, y: b.y + b.h }]),
  );
  return points.length ? extent(points) : null;
}

// PDF owners are reconstructed spatially from measured cell or text regions.
// Matching text is deliberately not a condition: changing NC to NO must remain
// visible. Use painted PDF glyph bounds (when available) and SVG em+ink bounds
// so small-font Canvas measureText quantization cannot drop a real PDF run.
export function pdfOracleTexts(g, select) {
  const texts = [],
    missing = [],
    matched = new Set();
  for (const ts of groupBy(
    g.texts.filter((t) => painted(t) && select(t)),
    (t) =>
      t.row != null
        ? JSON.stringify([t.documentId, t.row, t.columnIndex])
        : t.element,
  ).values()) {
    const t = ts[0],
      box = svgOracleGroupBox(g, ts);
    const runs = (g.pdfTexts ?? [])
      .filter((p) => pdfRunInBox(p, box))
      .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    for (const r of runs) matched.add(r);
    if (!runs.length && ts.some((item) => item.text.trim()))
      missing.push(
        finding("oracle-pdf-field-unavailable", t, { medium: "pdf" }),
      );
    texts.push({
      ...t,
      text: runs.map((p) => p.text).join(" "),
      medium: "pdf",
    });
  }
  return { texts, missing, matched };
}
