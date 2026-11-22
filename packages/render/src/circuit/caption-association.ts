import { captionAssociation } from "../layout/beside-caption.js";
import { rectInkBox } from "../layout/ink-geometry.js";
import { horizontalLabelSupport } from "../layout/wire-label-support.js";
// Circuit labels already have an opaque inline plate. Keep a native horizontal
// inline plate only when it sits cleanly on its owner's horizontal run; never
// interrupt a vertical run or create new plates to mask overlap.
export function existingCircuitCaption(
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
    horizontalLabelSupport(ink, own, 0, foreign) && association.foreign > 0
  );
}
