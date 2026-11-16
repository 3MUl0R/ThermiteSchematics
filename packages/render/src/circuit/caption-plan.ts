import { circuitCaptionGeometry } from "./label-support.js";
import type { CircuitLabelState } from "./layout-routes.js";
import { besideCaption, captionAssociation } from "../layout/beside-caption.js";
import { rectInkBox, routeInkDistance } from "../layout/ink-geometry.js";
import {
  ownedLabelLeader,
  labelLeaderArrow,
} from "../layout/wire-label-support.js";
import { captionPlacementDiagnostic } from "../layout/caption-diagnostic.js";
import { CircuitRenderError } from "../render-error-context.js";
import { required } from "../presentation/util.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
type Label = CircuitLabelState["labels"][number];
export function plannedCircuitCaption(
  line: string,
  i: number,
  label: Label,
  state: CircuitLabelState,
) {
  const original = circuitCaptionGeometry(line, i, label, state),
    own = state.segments
      .filter((s) => s.index === label.index)
      .map((s) => [s.a, s.b]),
    others = state.segments.filter((s) => s.index !== label.index),
    owner = required(state.cs[label.index], "Missing circuit caption owner"),
    foreignStrokes = others.map((s) =>
      required(state.cs[s.index], "Missing circuit conductor").jumper
        ? 0.55
        : 0.32,
    ),
    stroke = owner.jumper ? 0.55 : 0.32;
  const context = circuitCaptionContext(state, label, others, foreignStrokes);
  const reservation = {
      left: label.x,
      right: label.x + label.width,
      top: label.y + i * 3.1,
      bottom: label.y + (i + 1) * 3.1 + 0.7,
    },
    placement = existingCircuitCaption(
      original.ink,
      own,
      others.map((s) => [s.a, s.b]),
      foreignStrokes,
      stroke,
    )
      ? { ink: original.ink, needsLeader: false }
      : besideCaption(original.ink, reservation, own, context, 1, stroke);
  const failure = () =>
    new CircuitRenderError(
      captionPlacementDiagnostic(
        line,
        owner.id,
        state.group.label ?? state.group.id,
        "control",
      ),
    );
  if (!placement) throw failure();
  const points = placement.needsLeader
    ? ownedLabelLeader(placement.ink, reservation, own, context, 2, 0.25)
    : undefined;
  if (placement.needsLeader && !points) throw failure();
  const path = (ps: readonly { x: number; y: number }[]) =>
    ps
      .map((p, j) => `${j ? "L" : "M"} ${state.n(p.x)} ${state.n(p.y)}`)
      .join(" ");
  const leader = points
    ? `<path class="wire-label-leader" data-label-leader-owner="${attr(owner.id)}" d="${path(points)}" fill="none" stroke="#475467" stroke-width=".15" stroke-dasharray=".5 .375"/><path class="wire-label-leader-arrow" d="${path(labelLeaderArrow(points, 0.75))}" fill="none" stroke="#475467" stroke-width=".15"/>`
    : "";
  return {
    ...original,
    x: original.x + placement.ink.left - original.ink.left,
    baseline: original.baseline + placement.ink.top - original.ink.top,
    ink: placement.ink,
    leader,
  };
}

// Circuit labels already have an opaque inline plate. Keep a native vertical
// plate only when its complete glyph height lies on the owner's straight run
// and no foreign conductor enters it; do not create new plates to mask overlap.
function existingCircuitCaption(
  ink: ReturnType<typeof rectInkBox>,
  own: readonly (readonly { x: number; y: number }[])[],
  foreign: readonly (readonly { x: number; y: number }[])[],
  strokes: readonly number[],
  stroke: number,
) {
  const association = captionAssociation(ink, own, foreign, stroke, 2, strokes);
  // Preserve the existing conductor-facing anchors of already clear circuit
  // captions inside the established 2 mm association reach. Repairs prefer
  // 0.75 mm; a legal old anchor is not moved merely to tighten its spacing.
  if (association.owner >= 0.5 && !association.needsLeader) return true;
  return (
    foreign.every(
      (r, i) => routeInkDistance(ink, [r], strokes[i] ?? 0.32) > 0,
    ) &&
    own.some((r) =>
      r.some((a, i) => {
        const b = r[i + 1];
        return (
          b &&
          Math.abs(a.x - b.x) < 1e-7 &&
          a.x > ink.left &&
          a.x < ink.right &&
          Math.min(a.y, b.y) <= ink.top &&
          Math.max(a.y, b.y) >= ink.bottom
        );
      }),
    )
  );
}

function circuitCaptionContext(
  state: CircuitLabelState,
  label: Label,
  others: CircuitLabelState["segments"],
  foreignStrokes: number[],
) {
  return {
    foreign: others.map((s) => [s.a, s.b]),
    foreignStrokes,
    obstacles: [
      ...(state.graph.children ?? []).map((n) =>
        rectInkBox({
          x: required(n.x, "Unplaced device"),
          y: required(n.y, "Unplaced device"),
          width: required(n.width, "Missing device width"),
          height: required(n.height, "Missing device height"),
        }),
      ),
      ...state.labels.filter((l) => l !== label).map(rectInkBox),
    ],
    bounds: {
      left: 0,
      top: 0,
      right: required(state.graph.width, "Missing circuit width"),
      bottom: required(state.graph.height, "Missing circuit height"),
    },
    strokeClearance: Math.max(
      0.25,
      ...foreignStrokes.map((s) => s / 2 + 0.075),
    ),
  };
}
