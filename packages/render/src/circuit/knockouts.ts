import { InlineLabelCollisionError } from "../layout/inline-label-error.js";
import type { LayoutHooks } from "./layout-input.js";
import type { PhysicalConductor, Point } from "./types.js";

const KNOCKOUT_WIDTH = 1.1;
const KNOCKOUT_HALF = KNOCKOUT_WIDTH / 2;
const PARALLEL_GAP_PAD = 0.01;
const AXIAL_TRIM_PAD = 0.02;
const CROSS_STRIP_PAD = 0.04;
// Minimum white crossing clearance at 300 dpi print resolution:
// 1 px = 25.4 / 300 = 0.08467 mm; >= 2.0 px (0.1693 mm, rounded up to 0.17 mm)
// guarantees at least one white separation pixel (lum >= 200 across all subpixel
// phases, verified by a 12-phase 300 dpi Chromium raster sweep) while permitting
// all valid 0.625 mm wire/wire (0.305 mm) and wire/jumper (0.190 mm) approaches.
export const MIN_CROSS_KNOCKOUT_GAP = 0.17;

export type KnockoutRoute = {
  index: number;
  points: Point[];
  nested?: boolean;
};

type OrthoSeg = {
  horiz: boolean;
  pos: number;
  lo: number;
  hi: number;
};

function strokeHalf(c: PhysicalConductor | undefined) {
  return (c?.jumper ? 0.55 : 0.32) / 2;
}

function orthoSegs(points: readonly Point[]): OrthoSeg[] {
  const out: OrthoSeg[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (!a || !b) continue;
    const horiz = Math.abs(a.y - b.y) <= 1e-7;
    const lo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    if (hi - lo <= 1e-7) continue;
    const pos = horiz ? a.y : a.x;
    const prev = out.at(-1);
    if (
      prev &&
      prev.horiz === horiz &&
      Math.abs(prev.pos - pos) <= 1e-7 &&
      lo <= prev.hi + 1e-7 &&
      hi >= prev.lo - 1e-7
    ) {
      prev.lo = Math.min(prev.lo, lo);
      prev.hi = Math.max(prev.hi, hi);
    } else {
      out.push({ horiz, pos, lo, hi });
    }
  }
  return out;
}

function subtractInterval(
  spans: [number, number][],
  cut0: number,
  cut1: number,
): [number, number][] {
  const next: [number, number][] = [];
  for (const [a, b] of spans) {
    if (cut1 <= a + 1e-7 || cut0 >= b - 1e-7) {
      next.push([a, b]);
      continue;
    }
    if (cut0 > a + 1e-7) next.push([a, cut0]);
    if (cut1 < b - 1e-7) next.push([cut1, b]);
  }
  return next;
}

function complementSpans(
  lo: number,
  hi: number,
  kept: readonly [number, number][],
): [number, number][] {
  const out: [number, number][] = [];
  let cursor = lo;
  for (const [a, b] of kept) {
    if (a > cursor + 1e-4) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (hi > cursor + 1e-4) out.push([cursor, hi]);
  return out;
}

function trimmedIntervals(
  seg: OrthoSeg,
  routeIndex: number,
  orderedRoutes: readonly KnockoutRoute[],
  cs: readonly PhysicalConductor[],
) {
  let kept: [number, number][] = [[seg.lo, seg.hi]];
  let trimmed = false;
  for (const other of orderedRoutes) {
    if (other.index === routeIndex) continue;
    const otherHalf = strokeHalf(cs[other.index]);
    const limit = KNOCKOUT_HALF + otherHalf + PARALLEL_GAP_PAD;
    for (const oSeg of orthoSegs(other.points)) {
      if (oSeg.horiz !== seg.horiz) continue;
      const perp = Math.abs(oSeg.pos - seg.pos);
      if (!(perp > 1e-7 && perp < limit)) continue;
      const cut0 = oSeg.lo - otherHalf - AXIAL_TRIM_PAD;
      const cut1 = oSeg.hi + otherHalf + AXIAL_TRIM_PAD;
      if (cut1 <= seg.lo + 1e-7 || cut0 >= seg.hi - 1e-7) continue;
      trimmed = true;
      kept = subtractInterval(kept, cut0, cut1);
    }
  }
  return { kept, trimmed };
}

function clampedCrossingBounds(
  seg: OrthoSeg,
  routeIndex: number,
  stripLo: number,
  stripHi: number,
  orderedRoutes: readonly KnockoutRoute[],
  cs: readonly PhysicalConductor[],
) {
  const rHalf = strokeHalf(cs[routeIndex]);
  let kLo = seg.pos - KNOCKOUT_HALF;
  let kHi = seg.pos + KNOCKOUT_HALF;
  for (const peer of orderedRoutes) {
    if (peer.index === routeIndex) continue;
    const peerHalf = strokeHalf(cs[peer.index]);
    for (const pSeg of orthoSegs(peer.points)) {
      if (pSeg.horiz !== seg.horiz) continue;
      if (pSeg.hi < stripLo - peerHalf || pSeg.lo > stripHi + peerHalf)
        continue;
      if (pSeg.pos < seg.pos - 1e-7) kLo = Math.max(kLo, pSeg.pos + peerHalf);
      else if (pSeg.pos > seg.pos + 1e-7)
        kHi = Math.min(kHi, pSeg.pos - peerHalf);
    }
  }
  if (
    kLo > seg.pos - rHalf - MIN_CROSS_KNOCKOUT_GAP + 1e-7 ||
    kHi < seg.pos + rHalf + MIN_CROSS_KNOCKOUT_GAP - 1e-7
  )
    throw new InlineLabelCollisionError(
      `Close-parallel crossing cannot satisfy both stroke protection and crossing knockout.`,
    );
  return { kLo, kHi };
}

function crossingRectsForSegment(
  seg: OrthoSeg,
  trimmedSpans: readonly [number, number][],
  route: KnockoutRoute,
  routePos: number,
  orderedRoutes: readonly KnockoutRoute[],
  cs: readonly PhysicalConductor[],
  dots: ReadonlyMap<string, Point>,
  n: LayoutHooks["n"],
) {
  const rects: string[] = [];
  const seenCross = new Set<string>();
  for (let i = 0; i < routePos; i++) {
    const cross = orderedRoutes[i];
    if (!cross || cross.index === route.index) continue;
    const crossHalf = strokeHalf(cs[cross.index]);
    for (const cSeg of orthoSegs(cross.points)) {
      if (cSeg.horiz === seg.horiz) continue;
      const cAxis = cSeg.pos;
      if (
        !(cAxis > seg.lo + 1e-4 && cAxis < seg.hi - 1e-4) ||
        !(cSeg.lo < seg.pos - 1e-4 && cSeg.hi > seg.pos + 1e-4) ||
        !trimmedSpans.some(
          ([t0, t1]) => cAxis >= t0 - crossHalf && cAxis <= t1 + crossHalf,
        )
      )
        continue;
      const pt = seg.horiz
        ? { x: cAxis, y: seg.pos }
        : { x: seg.pos, y: cAxis };
      const dotKey = `${n(pt.x)},${n(pt.y)}`;
      if (dots.has(dotKey) || seenCross.has(`${cross.index}:${dotKey}`))
        continue;
      seenCross.add(`${cross.index}:${dotKey}`);
      const stripLo = cAxis - crossHalf - CROSS_STRIP_PAD;
      const stripHi = cAxis + crossHalf + CROSS_STRIP_PAD;
      const { kLo, kHi } = clampedCrossingBounds(
        seg,
        route.index,
        stripLo,
        stripHi,
        orderedRoutes,
        cs,
      );
      const [rx, ry, rw, rh] = seg.horiz
        ? [stripLo, kLo, stripHi - stripLo, kHi - kLo]
        : [kLo, stripLo, kHi - kLo, stripHi - stripLo];
      rects.push(
        `<rect x="${n(rx)}" y="${n(ry)}" width="${n(rw)}" height="${n(rh)}" fill="white"/>`,
      );
    }
  }
  return rects;
}

export function circuitKnockoutSvg(
  route: KnockoutRoute,
  routePos: number,
  orderedRoutes: readonly KnockoutRoute[],
  cs: readonly PhysicalConductor[],
  dots: ReadonlyMap<string, Point>,
  fullPath: string,
  n: LayoutHooks["n"],
) {
  const segs = orthoSegs(route.points);
  const subpaths: string[] = [];
  const crossRects: string[] = [];
  let anyTrimmed = false;

  for (const seg of segs) {
    const { kept, trimmed } = trimmedIntervals(
      seg,
      route.index,
      orderedRoutes,
      cs,
    );
    if (trimmed) anyTrimmed = true;
    for (const [lo, hi] of kept) {
      if (hi - lo <= 1e-4) continue;
      subpaths.push(
        seg.horiz
          ? `M ${n(lo)} ${n(seg.pos)} L ${n(hi)} ${n(seg.pos)}`
          : `M ${n(seg.pos)} ${n(lo)} L ${n(seg.pos)} ${n(hi)}`,
      );
    }
    if (trimmed) {
      const removed = complementSpans(seg.lo, seg.hi, kept);
      crossRects.push(
        ...crossingRectsForSegment(
          seg,
          removed,
          route,
          routePos,
          orderedRoutes,
          cs,
          dots,
          n,
        ),
      );
    }
  }

  if (!anyTrimmed)
    return `<path d="${fullPath}" fill="none" stroke="white" stroke-width="${KNOCKOUT_WIDTH}"/>`;
  const trimmedPath = subpaths.length
    ? `<path d="${subpaths.join(" ")}" fill="none" stroke="white" stroke-width="${KNOCKOUT_WIDTH}"/>`
    : "";
  return `${trimmedPath}${crossRects.join("")}`;
}
