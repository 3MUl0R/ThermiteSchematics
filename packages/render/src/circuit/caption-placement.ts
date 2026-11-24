import type { CircuitLabelState } from "./layout-routes.js";
import {
  circuitCaptionGeometry,
  circuitCaptionSlot,
} from "./caption-geometry.js";
import { circuitCaptionContext } from "./caption-context.js";
import { existingCircuitCaption } from "./caption-association.js";
import { besideCaption } from "../layout/beside-caption.js";
import { ownedLabelLeader } from "../layout/wire-label-support.js";
import { required } from "../presentation/util.js";
import { circuitCaptionPlateFits } from "./inline-plate.js";
type Label = CircuitLabelState["labels"][number];
function multilineBlockLeader(
  label: Label,
  own: readonly (readonly { x: number; y: number }[])[],
  context: ReturnType<typeof circuitCaptionContext>,
  state: CircuitLabelState,
) {
  if (!label.text.includes("\n")) return undefined;
  const inks = label.text
    .split("\n")
    .map((l, j) => circuitCaptionGeometry(l, j, label, state).ink);
  const blockInk = {
    left: Math.min(...inks.map((b) => b.left)),
    right: Math.max(...inks.map((b) => b.right)),
    top: Math.min(...inks.map((b) => b.top)),
    bottom: Math.max(...inks.map((b) => b.bottom)),
  };
  return ownedLabelLeader(
    blockInk,
    {
      left: label.x,
      right: label.x + label.width,
      top: label.y,
      bottom: label.y + label.height,
    },
    own,
    context,
    2,
    0.25,
  );
}

/** The same final glyph and leader admission is used during whole-block search
 * and emission. No candidate changes native paths, plate size or font metrics. */
export function circuitCaptionPlacement(
  line: string,
  i: number,
  label: Label,
  state: CircuitLabelState,
) {
  if (!circuitCaptionPlateFits(label, state)) return undefined;
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
    stroke = owner.jumper ? 0.55 : 0.32,
    context = circuitCaptionContext(state, label, others, foreignStrokes),
    slot = circuitCaptionSlot(label, i),
    reservation = {
      left: label.x,
      right: label.x + label.width,
      top: label.y + slot.yOffset,
      bottom: label.y + slot.yOffset + slot.height,
    };
  let placement = existingCircuitCaption(
    original.ink,
    own,
    others.map((s) => [s.a, s.b]),
    foreignStrokes,
    stroke,
  )
    ? { ink: original.ink, needsLeader: false }
    : besideCaption(original.ink, reservation, own, context, 1, stroke, 0.5);
  let points = placement?.needsLeader
    ? ownedLabelLeader(placement.ink, reservation, own, context, 2, 0.25)
    : undefined;
  if (!placement || (placement.needsLeader && !points)) {
    const blockPoints = multilineBlockLeader(label, own, context, state);
    if (!blockPoints) return undefined;
    placement = { ink: original.ink, needsLeader: true };
    points = blockPoints;
  }
  return {
    ...original,
    x: original.x + placement.ink.left - original.ink.left,
    baseline: original.baseline + placement.ink.top - original.ink.top,
    ink: placement.ink,
    points,
  };
}
