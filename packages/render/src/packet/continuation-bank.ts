import { rootedGrids } from "./rooted-plans.js";
import { rootedCrossings } from "./rooted-crossings.js";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type { DrawingBounds } from "./types.js";
import { reserveContinuationSources } from "./continuation-source.js";
import { continuationHeaderWidth } from "./continuation-label.js";
import { labelMetrics, labelRows } from "./label-text.js";
import { identityTokens } from "./label-wrap.js";

export interface ContinuationBank {
  width: number;
  headerWidth: number;
  single: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
}
// Physical caption envelopes and the existing gutters, all in sheet mm.
const SIDE_CAPTION_INSET = { left: 9.35, right: 4.35 };
const VERTICAL_CAPTION_INSET = 4.15;
const NATIVE_GUTTER = { left: 18, right: 18, top: 8.96, bottom: 14 };
/** Finite measured paper reservations; cuts consume these before acceptance. */
export function continuationBanks(
  p: PreparedSchematicDrawing,
  b: DrawingBounds,
  scale: number,
  offset = 0,
): ContinuationBank[] {
  const seeds = rootedGrids(p, b, scale);
  const sides = new Set(
    seeds.flatMap((g) =>
      p.layout.edges
        .flatMap((e) => rootedCrossings(e, g.xs, g.ys, b, scale))
        .flatMap((c) => [c.a.side, c.z.side]),
    ),
  );
  const xCuts = sides.has("left") || sides.has("right"),
    yCuts = sides.has("top") || sides.has("bottom");
  const maximumSerial = Math.max(
    1,
    offset +
      39 *
        p.layout.edges.reduce(
          (n, e) => n + Math.max(0, e.points.length - 1),
          0,
        ),
  );
  const headerWidth = continuationHeaderWidth(maximumSerial);
  const sources = reserveContinuationSources(p.graph);
  const maxBody = Math.max(headerWidth, ...sources.map((s) => s.width));
  const tokenWidth = sources.reduce(
    (width, source) =>
      identityTokens(source.conductor).reduce(
        (width, token) => Math.max(width, labelMetrics(token).width),
        width,
      ),
    headerWidth,
  );
  const plans: ContinuationBank[] = [];
  for (const [width, single] of [
    [maxBody, false],
    [headerWidth, false],
    [tokenWidth, false],
    [maxBody, true],
  ] as const) {
    const { maxW, maxH } = bankExtent(sources, width, headerWidth, single);
    const plan = {
      width,
      headerWidth,
      single,
      left: xCuts
        ? Math.max(0, maxW + SIDE_CAPTION_INSET.left - NATIVE_GUTTER.left)
        : 0,
      right: xCuts
        ? Math.max(0, maxW + SIDE_CAPTION_INSET.right - NATIVE_GUTTER.right)
        : 0,
      top: yCuts
        ? Math.max(0, maxH + VERTICAL_CAPTION_INSET - NATIVE_GUTTER.top)
        : 0,
      bottom: yCuts
        ? Math.max(0, maxH + VERTICAL_CAPTION_INSET - NATIVE_GUTTER.bottom)
        : 0,
    };
    if (!plans.some((p) => JSON.stringify(p) === JSON.stringify(plan)))
      plans.push(plan);
  }
  return plans;
}
export function bankBounds(b: DrawingBounds, bank: ContinuationBank) {
  return {
    x: b.x + bank.left,
    y: b.y + bank.top,
    w: b.w - bank.left - bank.right,
    h: b.h - bank.top - bank.bottom,
  };
}

function bankExtent(
  sources: ReturnType<typeof reserveContinuationSources>,
  width: number,
  headerWidth: number,
  single: boolean,
) {
  const header = labelMetrics("C0123456789 / .ABCD");
  let maxW = headerWidth,
    maxH = 0;
  for (const s of sources) {
    const values =
      single && !s.descriptor
        ? [` / ${s.conductor}`]
        : [
            ...(s.descriptor ? [s.descriptor, s.conductor] : [s.conductor]),
          ].flatMap((v) => labelRows(v, width));
    const ms = values.map((v) => labelMetrics(v));
    const h =
      single && !s.descriptor
        ? Math.max(header.top, ...ms.map((m) => m.top)) -
          Math.min(header.bottom, ...ms.map((m) => m.bottom))
        : Math.max(header.top, ...ms.map((m) => m.top)) +
          values.length * 3.5 -
          Math.min(header.bottom, ...ms.map((m) => m.bottom));
    maxH = Math.max(maxH, h);
    maxW = Math.max(
      maxW,
      single && !s.descriptor
        ? headerWidth + Math.max(...ms.map((m) => m.width))
        : Math.max(headerWidth, ...ms.map((m) => m.width)),
    );
  }
  return { maxW, maxH };
}
