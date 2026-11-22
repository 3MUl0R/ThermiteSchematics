import { measureText, printableTextMetrics } from "../text-metrics.js";
import { required } from "../presentation/util.js";
import type { StripApproaches } from "./terminal-strip-approaches.js";

export interface StripSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface StripRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface BridgeGeometry {
  bridge: StripApproaches["bridges"][number];
  x: number;
  yLo: number;
  yHi: number;
  segments: StripSegment[];
}
export interface BridgeTagPlacement {
  tx: number;
  baseline: number;
  anchor: "start" | "end" | "middle";
}

function pointToSegmentDistance(
  px: number,
  py: number,
  s: StripSegment,
): number {
  const dx = s.x2 - s.x1,
    dy = s.y2 - s.y1,
    l = dx * dx + dy * dy;
  const t = l
    ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / l))
    : 0;
  return Math.hypot(px - s.x1 - t * dx, py - s.y1 - t * dy);
}

function boxToSegmentDistance(b: StripRect, s: StripSegment): number {
  const bx2 = b.x + b.w,
    by2 = b.y + b.h;
  if (s.x1 === s.x2)
    return Math.hypot(
      Math.max(b.x - s.x1, 0, s.x1 - bx2),
      Math.max(b.y - Math.max(s.y1, s.y2), 0, Math.min(s.y1, s.y2) - by2),
    );
  if (s.y1 === s.y2)
    return Math.hypot(
      Math.max(b.x - Math.max(s.x1, s.x2), 0, Math.min(s.x1, s.x2) - bx2),
      Math.max(b.y - s.y1, 0, s.y1 - by2),
    );
  return Math.min(
    pointToSegmentDistance(b.x, b.y, s),
    pointToSegmentDistance(bx2, b.y, s),
    pointToSegmentDistance(b.x, by2, s),
    pointToSegmentDistance(bx2, by2, s),
  );
}

function boxToBoxDistance(a: StripRect, b: StripRect): number {
  return Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );
}

function scoreTagCandidate(
  item: BridgeGeometry,
  tx: number,
  baseline: number,
  anchor: "start" | "end" | "middle",
  sidePenalty: number,
  size: { w: number; h: number; ascent: number },
  obstacles: {
    stubs: readonly StripSegment[];
    foreign: readonly StripSegment[];
    terminals: readonly StripRect[];
    placed: readonly StripRect[];
  },
) {
  const boxX =
    anchor === "end"
      ? tx - size.w
      : anchor === "middle"
        ? tx - size.w / 2
        : tx;
  const box: StripRect = {
    x: boxX,
    y: baseline - size.ascent,
    w: size.w,
    h: size.h,
  };
  const ownDist = Math.max(
    0,
    Math.min(...item.segments.map((s) => boxToSegmentDistance(box, s))) - 0.25,
  );
  const stubDist = obstacles.stubs.length
    ? Math.max(
        0,
        Math.min(...obstacles.stubs.map((s) => boxToSegmentDistance(box, s))) -
          0.2,
      )
    : Infinity;
  const foreignDist = obstacles.foreign.length
    ? Math.max(
        0,
        Math.min(
          ...obstacles.foreign.map((s) => boxToSegmentDistance(box, s)),
        ) - 0.25,
      )
    : Infinity;
  const terminalDist = obstacles.terminals.length
    ? Math.max(
        0,
        Math.min(...obstacles.terminals.map((r) => boxToBoxDistance(box, r))) -
          0.175,
      )
    : Infinity;
  const placedDist = obstacles.placed.length
    ? Math.min(...obstacles.placed.map((r) => boxToBoxDistance(box, r)))
    : Infinity;
  const clearDist = Math.min(stubDist, foreignDist, terminalDist, placedDist);
  const owned =
    clearDist >= 0.5 &&
    ownDist <= 1.5 &&
    stubDist > ownDist + 0.2 &&
    foreignDist > ownDist + 0.2;
  const midY = (item.yLo + item.yHi) / 2;
  const score =
    (owned ? 1000 : 0) +
    Math.min(clearDist, 2.5) * 10 -
    Math.abs(baseline - size.ascent / 2 - midY) * 0.05 -
    sidePenalty;
  return { tx, baseline, anchor, box, score };
}

export function placeStripBridgeTags(
  geometries: readonly BridgeGeometry[],
  step: number,
  stubs: readonly StripSegment[],
  terminals: readonly StripRect[],
) {
  const placed: StripRect[] = [];
  const placements = new Map<string, BridgeTagPlacement>();
  const order = [...geometries].sort(
    (a, b) => a.yHi - a.yLo - (b.yHi - b.yLo) || a.bridge.number - b.bridge.number,
  );
  for (const item of order) {
    const tag = `B${item.bridge.number}`;
    const metrics = printableTextMetrics(tag, 2.5);
    const w = Math.max(measureText(tag, 2.5).width, metrics.advance);
    const ascent = Math.max(metrics.top, 1.85);
    const descent = Math.max(-metrics.bottom, 0.15);
    const h = ascent + descent;
    const midY = (item.yLo + item.yHi) / 2;
    const offset = Math.min(
      0.85,
      Math.max(0.55, (step - 0.5 - w) * 0.35 + 0.25),
    );
    const foreign = geometries
      .filter((g) => g.bridge.uid !== item.bridge.uid)
      .flatMap((g) => g.segments);
    const obstacles = { stubs, foreign, terminals, placed };
    const size = { w, h, ascent };
    const yStart = item.yLo + 0.25 + h / 2 + 0.45;
    const yEnd = item.yHi - 0.25 - h / 2 - 0.45;
    const ys = [midY];
    for (let cy = yStart; cy <= yEnd + 1e-6; cy += 0.25) ys.push(cy);
    const candidates = ys.flatMap((cy) => {
      const baseline = cy + (ascent - descent) / 2;
      return [
        scoreTagCandidate(item, item.x - offset, baseline, "end", 0, size, obstacles),
        scoreTagCandidate(item, item.x + offset, baseline, "start", 0.5, size, obstacles),
      ];
    });
    candidates.push(
      scoreTagCandidate(item, item.x - offset, item.yLo - 0.85 - descent, "end", 5, size, obstacles),
      scoreTagCandidate(item, item.x - offset, item.yHi + 0.85 + ascent, "end", 5, size, obstacles),
    );
    candidates.sort((a, b) => b.score - a.score);
    const chosen = required(candidates[0], "Missing bridge tag candidate");
    placed.push(chosen.box);
    placements.set(item.bridge.uid, {
      tx: chosen.tx,
      baseline: chosen.baseline,
      anchor: chosen.anchor,
    });
  }
  return placements;
}
