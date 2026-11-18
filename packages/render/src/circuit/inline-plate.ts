import type { CircuitLabelState } from "./layout-routes.js";
import {
  rectInkBox,
  segmentTouchesBox,
  pointInsideBox,
} from "../layout/ink-geometry.js";

/** #399: the whole opaque plate needs one straight owned approach through
 * opposite sides. Glyph support alone cannot reveal a bend hidden by its margin.
 * Beside/leader plates that touch no owner ink retain their existing admission. */
export function circuitCaptionPlateFits(
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
) {
  const box = rectInkBox(label);
  if ([...state.dots.values()].some((point) => pointInsideBox(point, box)))
    return false;
  const hidden = state.segments.filter(
    (s) => s.index === label.index && segmentTouchesBox(s.a, s.b, box),
  );
  if (!hidden.length) return true;
  return hidden.some(({ a, b }) => {
    if (Math.abs(a.y - b.y) < 1e-7)
      return (
        Math.min(a.x, b.x) < box.left - 1e-7 &&
        Math.max(a.x, b.x) > box.right + 1e-7 &&
        hidden.every(
          (s) => Math.abs(s.a.y - a.y) < 1e-7 && Math.abs(s.b.y - a.y) < 1e-7,
        )
      );
    return (
      Math.abs(a.x - b.x) < 1e-7 &&
      Math.min(a.y, b.y) < box.top - 1e-7 &&
      Math.max(a.y, b.y) > box.bottom + 1e-7 &&
      hidden.every(
        (s) => Math.abs(s.a.x - a.x) < 1e-7 && Math.abs(s.b.x - a.x) < 1e-7,
      )
    );
  });
}
