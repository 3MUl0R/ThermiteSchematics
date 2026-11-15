import type { IrFunction } from "@thermite/compiler";
import { printableCaption } from "./printable-policy.js";
import { printableTextMetrics } from "./printable-font.js";
import { circuitTextLines, measure } from "./circuit-text.js";
import { relationCaptionForms } from "./circuit-relation-form.js";

/** Choose the printed form before reserving its width. A summary never retains
 * the full mirror's discarded width; the body and pin minimum still applies. */
export function relationCaptionPlan(
  captions: readonly {
    kind: "relation";
    destination: string;
    functions: IrFunction[];
  }[],
  bodyWidth: number,
) {
  const full = captions.map((c) => printableCaption(c));
  const available =
    Math.max(
      bodyWidth,
      Math.min(100, Math.max(0, ...full.map((s) => measure(s, 2.5) + 4))),
    ) - 4;
  const lines = relationCaptionForms(captions, bodyWidth).flatMap((value) =>
    circuitTextLines(value, available, 2.5),
  );
  return {
    lines,
    width: Math.max(
      bodyWidth,
      ...lines.map(
        (s) =>
          Math.max(measure(s, 2.5), printableTextMetrics(s, 2.5).advance) + 4,
      ),
    ),
  };
}
