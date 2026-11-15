import type { PreparedSchematicDrawing } from "../renderer.js";
import type { PaperPage } from "./types.js";
import { OUTER_SVG_PADDING as pad } from "../symbols/catalog.js";
import { rootedSpace, buildGridCandidates } from "./rooted-build.js";
import { continuationBanks, bankBounds } from "./continuation-bank.js";
import { continuationGridConstraint } from "./continuation-constraint.js";
import { protectedDrawingIntervals } from "./rooted-geometry.js";
import { safeAxisPlans } from "./safe-cuts.js";
import { gridLinks } from "./rooted-plans.js";

/** Conservative source envelope. Only location headings may be reissued by
 * rootedDraft/rootedLocationContent; all other boxes, marker circles, leaders
 * and route points stay whole. Four units leave >=1 mm at the minimum scale. */
export function foldCropExtent(p: PreparedSchematicDrawing) {
  const boxes = [
    ...p.layout.nodes.filter((n) => n.kind !== "location"),
    ...p.layout.labels.filter((l) => l.role !== "location"),
  ];
  const points = [
    ...boxes.flatMap((b) => [b.x - 0.75, b.x + b.width + 0.75]),
    ...p.layout.ports.flatMap((port) => [
      port.x - 2.75,
      port.x + port.width + 2.75,
    ]),
    ...p.layout.edges.flatMap((e) =>
      e.points.flatMap((v) => [v.x - 0.75, v.x + 0.75]),
    ),
    ...(p.layout.contextReferences ?? []).flatMap((r) =>
      r.leaders.flatMap((line) =>
        line.flatMap((v) => [v.x - 0.75, v.x + 0.75]),
      ),
    ),
  ];
  return {
    start: Math.max(0, Math.min(...points) + pad - 4),
    end: Math.min(p.layout.width + 2 * pad, Math.max(...points) + pad + 4),
  };
}

/** Two-strip plans for one guarded branch alternative, rather than a general
 * change to sparse-layout trimming. Native coordinates are never translated. */
export function croppedFoldCandidates(
  p: PreparedSchematicDrawing,
  page: PaperPage,
  offset: number,
) {
  const { b, scale } = rootedSpace(p, page, true),
    extent = foldCropExtent(p);
  const banks = continuationBanks(p, b, scale, offset);
  const constraint = continuationGridConstraint(
    p,
    banks.map((bank) => bankBounds(b, bank)),
    scale,
  );
  const protectedX = protectedDrawingIntervals(p.layout, pad).protectedX.map(
    // Exterior envelope edges are not conductor cuts. Clip reservations to
    // this complete-ink domain; every interior protected interval is retained.
    (i) => ({
      start: Math.max(0, i.start - extent.start),
      end: Math.min(extent.end - extent.start, i.end - extent.start),
    }),
  );
  const ys = [0, p.layout.height + 2 * pad];
  const grids = banks.flatMap((bank) => {
    const inner = bankBounds(b, bank);
    return safeAxisPlans(
      extent.end - extent.start,
      inner.w / scale,
      protectedX,
      (x) =>
        gridLinks(
          p,
          { xs: [extent.start, x + extent.start, extent.end], ys },
          inner,
          scale,
        ),
    )
      .filter((xs) => xs.length === 3)
      .map((xs) => ({
        bank,
        grid: { xs: xs.map((x) => x + extent.start), ys },
      }));
  });
  return buildGridCandidates(
    p,
    page,
    "dense",
    false,
    scale,
    b,
    grids,
    constraint,
  ).candidates;
}
