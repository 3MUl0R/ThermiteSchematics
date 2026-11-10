import type { IrFunction } from "@thermite/compiler";
import { printableCaption } from "./printable-policy.js";
import { printableTextMetrics } from "./printable-font.js";
import { circuitTextLines, measure } from "./circuit-text.js";

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
      Math.min(100, Math.max(0, ...full.map((s) => measure(s, 2.3) + 4))),
    ) - 4;
  const lines = captions.flatMap((caption, i) => {
    const value = full[i];
    if (value === undefined) throw Error("Missing relation caption");
    const rows = circuitTextLines(value, available, 2.3);
    const fits =
      rows.length <= 4 &&
      value.split(/\s+/u).every((word) => measure(word, 2.3) <= available);
    return fits
      ? rows
      : circuitTextLines(
          printableCaption({ ...caption, kind: "relation-summary" }),
          available,
          2.3,
        );
  });
  return {
    lines,
    width: Math.max(
      bodyWidth,
      ...lines.map(
        (s) =>
          Math.max(measure(s, 2.3), printableTextMetrics(s, 2.3).advance) + 4,
      ),
    ),
  };
}
