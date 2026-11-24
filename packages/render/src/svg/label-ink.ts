import { labelLeaderArrow } from "../layout/wire-label-support.js";
import { captionPlacementDiagnostic } from "../layout/caption-diagnostic.js";
import { rootedCaptionPlan } from "./rooted-caption-plan.js";
import type {
  LayoutLabel,
  NormalizedSchematicLayout,
  NormalizedSchematicView,
  RenderOutcome,
} from "../types.js";
import type { SvgWriter, SvgAttributes } from "./writer.js";
import { OUTER_SVG_PADDING } from "../symbols/catalog.js";
import { printableLabelGeometry } from "../symbols/printable-label.js";
import {
  boundedPrintableAdvance,
  printableFitAttributes,
  printableTextMetrics,
} from "../text-metrics.js";
import { TWO_LINE_NET_LABEL_PITCH } from "../presentation/net-label-wrap.js";
import { svgSemanticId } from "./escape.js";
const global = (value: number) => value + OUTER_SVG_PADDING;

function isConductorToRight(
  ink: Readonly<{ left: number; right: number; top: number; bottom: number }>,
  points: readonly { x: number; y: number }[],
): boolean {
  let bestDistance = Infinity;
  let rightSide = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (!a || !b || Math.abs(a.x - b.x) >= 1e-7) continue;
    const segTop = Math.min(a.y, b.y),
      segBottom = Math.max(a.y, b.y);
    const dy = Math.max(segTop - ink.bottom, ink.top - segBottom, 0);
    const dx = Math.max(ink.left - a.x, a.x - ink.right, 0);
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      rightSide = a.x >= ink.right - 0.01;
    }
  }
  return rightSide;
}

function emitTextLine(
  writer: SvgWriter,
  label: LayoutLabel,
  text: string,
  capacity: number,
  x: number,
  baseline: number,
  attributes: SvgAttributes,
): void {
  writer.element(
    1,
    "text",
    {
      class: `label-text label-${label.role}`,
      ...attributes,
      "clip-path": `url(#${svgSemanticId("clip", [label.id])})`,
      x: global(x),
      y: global(baseline),
      "font-family": "Thermite Sans, Thermite Math, sans-serif",
      "font-size": 10,
      "text-anchor": "start",
      "dominant-baseline": "alphabetic",
      ...printableFitAttributes(text, 10, capacity),
    },
    text,
  );
}

function emitTwoLineLabelTexts(
  writer: SvgWriter,
  label: LayoutLabel,
  lines: readonly [string, string],
  capacity: number,
  position: ReturnType<typeof printableLabelGeometry>,
  ownPoints: readonly { x: number; y: number }[],
  attributes: SvgAttributes,
): void {
  const [b0, b1] = position.baselines ?? [
    position.baseline,
    position.baseline + TWO_LINE_NET_LABEL_PITCH,
  ];
  const alignRight = isConductorToRight(position.ink, ownPoints);
  const pairs: readonly (readonly [string, number])[] = [
    [lines[0], b0],
    [lines[1], b1],
  ];
  for (const [line, baseline] of pairs) {
    const m = printableTextMetrics(line, 10);
    const advance = boundedPrintableAdvance(line, 10, capacity);
    const scale = m.advance ? advance / m.advance : 1;
    const lineX = alignRight
      ? position.ink.right - m.right * scale
      : position.ink.left - m.left * scale;
    emitTextLine(writer, label, line, capacity, lineX, baseline, attributes);
  }
}

export function emitLabelInk(
  writer: SvgWriter,
  label: LayoutLabel,
  printed: string,
  capacity: number,
  layout: Readonly<NormalizedSchematicLayout>,
  mmPerUnit: number,
  attributes: SvgAttributes,
  view: NormalizedSchematicView,
  lines?: readonly [string, string],
): RenderOutcome<void> {
  const ownPoints =
    label.ownerKind === "edge"
      ? (layout.edges.find((e) => e.id === label.ownerId)?.points ?? [])
      : [];
  const original = printableLabelGeometry(
      label,
      printed,
      capacity,
      label.ownerKind === "edge" ? [ownPoints] : undefined,
      10,
      true,
      lines,
    ),
    plan = rootedCaptionPlan(label, original, layout, mmPerUnit);
  if (!plan.ok)
    return {
      ok: false,
      error: captionPlacementDiagnostic(
        printed,
        label.ownerId,
        view.root.designation,
        view.family,
      ),
    };
  const position = plan.position;
  emitOwnedLabelLeader(writer, label, plan.leader);
  writer.element(1, "rect", {
    class: `label-background label-${label.role}`,
    x: global(position.ink.left),
    y: global(position.ink.top),
    width: position.ink.right - position.ink.left,
    height: position.ink.bottom - position.ink.top,
  });
  if (lines !== undefined) {
    emitTwoLineLabelTexts(
      writer,
      label,
      lines,
      capacity,
      position,
      ownPoints,
      attributes,
    );
  } else {
    emitTextLine(
      writer,
      label,
      printed,
      capacity,
      position.x,
      position.baseline,
      attributes,
    );
  }
  return { ok: true, value: undefined };
}
function emitOwnedLabelLeader(
  writer: SvgWriter,
  label: LayoutLabel,
  points: readonly { x: number; y: number }[] | undefined,
) {
  if (!points) return;
  const path = (ps: readonly { x: number; y: number }[]) =>
    ps
      .map((p, i) => `${i ? "L" : "M"} ${global(p.x)} ${global(p.y)}`)
      .join(" ");
  writer.element(1, "path", {
    class: "wire-label-leader",
    "data-label-leader-owner": label.ownerId,
    d: path(points),
    fill: "none",
    stroke: "#475467",
    "stroke-width": 0.5,
    "stroke-dasharray": "2 1.5",
  });
  writer.element(1, "path", {
    class: "wire-label-leader-arrow",
    d: path(labelLeaderArrow(points)),
    fill: "none",
    stroke: "#475467",
    "stroke-width": 0.5,
  });
}
