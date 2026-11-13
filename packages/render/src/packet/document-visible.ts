import { required } from "../presentation/util.js";
import type {
  DocumentHeaderDraft,
  DocumentRowDraft,
} from "./document-types.js";
import {
  navigationGeometry,
  type NavigationGeometry,
} from "./navigation-walk.js";
import { descendants } from "../device-legend/svg-tree.js";
import {
  inside,
  intersection,
  project,
  type Rect,
} from "../device-legend/geometry.js";
import { printableTextMetrics } from "../symbols/printable-font.js";
type Printed = Pick<
  DocumentRowDraft | DocumentHeaderDraft,
  "primitiveId" | "rectMm" | "printedCells" | "cells"
> & {
  nativeKey?: string;
};
export type DocumentGeometry = ReturnType<typeof navigationGeometry>;
export function printedDocumentLabel(
  header: DocumentHeaderDraft,
  label: string,
  geometry: DocumentGeometry,
  sheet: number,
): boolean {
  const node = geometry.find(
    (g) => g.node.attrs.id === `sheet-${sheet}-document-label`,
  )?.node;
  return (
    !!node &&
    node.text === header.labelText &&
    (node.text === label || node.text.endsWith(` — ${label}`)) &&
    printedText(node, geometry)
  );
}
function opaque(g: NavigationGeometry): boolean {
  const s = g.style ?? g.node.attrs;
  return (
    g.visible &&
    !["hidden", "collapse"].includes(s.visibility ?? "") &&
    Number(s.opacity ?? 1) === 1 &&
    Number(s["fill-opacity"] ?? 1) === 1 &&
    !["none", "white", "#fff", "#ffffff", "transparent"].includes(
      s.fill?.toLowerCase() ?? "",
    ) &&
    (!s.mask || s.mask === "none") &&
    (!s.filter || s.filter === "none")
  );
}
function covered(
  ink: Rect,
  g: NavigationGeometry,
  geometry: DocumentGeometry,
): boolean {
  return geometry.slice(geometry.indexOf(g) + 1).some((later) => {
    if (!later.visible || later.node.name !== "rect") return false;
    const s = later.style ?? later.node.attrs,
      a = later.node.attrs;
    if (
      s.fill === "none" ||
      s.fill === "transparent" ||
      Number(s.opacity ?? 1) === 0
    )
      return false;
    const box = intersection(
      project(
        {
          x: Number(a.x ?? 0),
          y: Number(a.y ?? 0),
          w: Number(a.width),
          h: Number(a.height),
        },
        later.matrix,
      ),
      later.clip,
    );
    return box ? !!intersection(ink, box) : false;
  });
}
function printedText(
  node: NavigationGeometry["node"],
  geometry: DocumentGeometry,
): boolean {
  const g = geometry.find((g) => g.node === node);
  if (!g || !opaque(g)) return false;
  const a = node.attrs,
    em = Number(g.style?.["font-size"] ?? a["font-size"]);
  if (
    em *
      Math.min(
        Math.hypot(g.matrix[0], g.matrix[1]),
        Math.hypot(g.matrix[2], g.matrix[3]),
      ) <
    2.499
  )
    return false;
  const m = printableTextMetrics(node.text, em, a["font-weight"] === "700");
  const ink = project(
    {
      x: Number(a.x) + m.left,
      y: Number(a.y) - m.top,
      w: m.right - m.left,
      h: m.top - m.bottom,
    },
    g.matrix,
  );
  return inside(ink, g.clip) && !covered(ink, g, geometry);
}
/** Generated table ink only; unsupported masking/transparency cannot confer coverage. */
export function printedDocumentRegion(
  row: Printed,
  columns: readonly string[],
  geometry: DocumentGeometry,
  sheet: number,
  identifiers?: readonly string[][],
): Rect | undefined {
  const g = geometry.find(
    (g) => g.node.attrs.id === `sheet-${sheet}-${row.primitiveId}`,
  );
  if (
    !g?.visible ||
    (row.nativeKey !== undefined &&
      g.node.attrs["data-report-row"] !== row.nativeKey)
  )
    return undefined;
  const rect = project(row.rectMm, g.matrix);
  if (!inside(rect, g.clip)) return undefined;
  const cells = g.node.children.filter((n) => n.attrs["data-report-column"]);
  if (
    cells.length !== columns.length ||
    cells.length !== row.printedCells.length
  )
    return undefined;
  for (const [i, column] of cells.entries()) {
    if (
      Number(column.attrs["data-report-column"]) !== i + 1 ||
      column.attrs["data-column-name"] !== columns[i]
    )
      return undefined;
    if (!printedCell(row, i, column, geometry, identifiers?.[i] ?? []))
      return undefined;
  }
  return rect;
}

function printedCell(
  row: Printed,
  index: number,
  column: NavigationGeometry["node"],
  geometry: DocumentGeometry,
  identifiers: readonly string[],
): boolean {
  const texts = descendants(column).filter((n) => n.name === "text");
  if (
    JSON.stringify(texts.map((n) => n.text)) !==
    JSON.stringify(
      required(row.printedCells[index], "Missing printed column").map((s) =>
        s.trim(),
      ),
    )
  )
    return false;
  const visible = texts.map((n) => n.text);
  // Header hyphenation is a measured layout choice. Body text adds no hyphens.
  const complete =
    row.nativeKey === undefined
      ? visible.map((s, i) =>
          i + 1 < visible.length && s.endsWith("-") ? s.slice(0, -1) : s,
        )
      : visible;
  const compact = (s: string) => s.normalize("NFC").replace(/\s/gu, "");
  if (
    compact(complete.join("")) !==
    compact(required(row.cells[index], "Missing native column"))
  )
    return false;
  if (
    identifiers.some(
      (id) => !texts.some((n) => n.text.normalize("NFC").includes(id)),
    )
  )
    return false;
  return texts.every((n) => printedText(n, geometry));
}
