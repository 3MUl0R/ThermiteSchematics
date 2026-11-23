import type { ElkLabel } from "elkjs/lib/elk-api.js";
import { routeSegments } from "../layout/ink-geometry.js";
import { required } from "../presentation/util.js";
type Point = { x: number; y: number };
type CaptionObstacles = {
  segments: readonly { a: Point; b: Point }[];
  dots: ReadonlyMap<string, Point>;
};

const HORIZONTAL_DOT_INSET = 1.1;

function horizontalSubSpanPositions(
  label: Readonly<ElkLabel>,
  routes: readonly (readonly Point[])[],
  obstacles?: CaptionObstacles,
) {
  const width = required(label.width, "Missing circuit label width"),
    height = required(label.height, "Missing circuit label height");
  return routes
    .flatMap(routeSegments)
    .filter(
      (s) => Math.abs(s.a.y - s.b.y) < 1e-7 && Math.abs(s.a.x - s.b.x) >= width,
    )
    .sort((s, t) => Math.abs(t.a.x - t.b.x) - Math.abs(s.a.x - s.b.x))
    .flatMap(({ a, b }) => {
      const lo = Math.min(a.x, b.x),
        hi = Math.max(a.x, b.x),
        y = a.y - height / 2;
      const cuts = [lo, hi];
      if (obstacles) {
        const bandTop = y - 0.5,
          bandBottom = y + height + 0.5;
        for (const s of obstacles.segments) {
          if (
            Math.abs(s.a.x - s.b.x) < 1e-7 &&
            s.a.x > lo + 1e-7 &&
            s.a.x < hi - 1e-7 &&
            Math.max(s.a.y, s.b.y) > bandTop &&
            Math.min(s.a.y, s.b.y) < bandBottom
          )
            cuts.push(s.a.x);
        }
        for (const dot of obstacles.dots.values()) {
          if (
            Math.abs(dot.y - a.y) <= 0.01 &&
            dot.x > lo + 1e-7 &&
            dot.x < hi - 1e-7
          )
            cuts.push(dot.x);
        }
      }
      cuts.sort((u, v) => u - v);
      const out: { x: number; y: number }[] = [];
      for (let i = 1; i < cuts.length; i++) {
        const c0 = cuts[i - 1],
          c1 = cuts[i];
        if (c0 === undefined || c1 === undefined || c1 - c0 < width - 1e-7)
          continue;
        const mid = (c0 + c1 - width) / 2;
        const xs = [
          mid,
          ...(c0 + HORIZONTAL_DOT_INSET <= c1 - width + 1e-7
            ? [c0 + HORIZONTAL_DOT_INSET]
            : []),
          ...(c1 - width - HORIZONTAL_DOT_INSET >= c0 - 1e-7
            ? [c1 - width - HORIZONTAL_DOT_INSET]
            : []),
        ];
        for (const x of new Set(xs)) out.push({ x, y });
      }
      return out;
    });
}

/** Try centered horizontal sub-span positions (clear of crossings and junction
 * dots) and whole-block positions on owned vertical runs after the shared
 * horizontal recovery. The existing free-space and per-line printed-ink
 * predicates admit them; bounds, routes, text and plate dimensions stay fixed. */
export function circuitCaptionPositions(
  label: Readonly<ElkLabel>,
  routes: readonly (readonly Point[])[],
  obstacles?: CaptionObstacles,
) {
  const width = required(label.width, "Missing circuit label width"),
    height = required(label.height, "Missing circuit label height");
  const vertical = routes
    .flatMap(routeSegments)
    .filter(
      (s) =>
        Math.abs(s.a.x - s.b.x) < 1e-7 && Math.abs(s.a.y - s.b.y) >= height,
    )
    .sort((s, t) => Math.abs(t.a.y - t.b.y) - Math.abs(s.a.y - s.b.y))
    .flatMap(({ a, b }) => {
      const top = Math.min(a.y, b.y),
        bottom = Math.max(a.y, b.y),
        y = Math.max(
          top,
          Math.min(
            bottom - height,
            required(label.y, "Unplaced circuit label"),
          ),
        );
      return [
        ...new Set([y, (top + bottom - height) / 2, top, bottom - height]),
      ].flatMap((y) =>
        [a.x - width - 0.275, a.x + 0.275].map((x) => ({
          x,
          y,
        })),
      );
    });
  return [...horizontalSubSpanPositions(label, routes, obstacles), ...vertical];
}
