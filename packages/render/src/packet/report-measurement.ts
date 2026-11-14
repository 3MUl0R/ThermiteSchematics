import { measureText } from "../text-metrics.js";

/** A measured layout constraint, rather than an unexpected programming error. */
export class ReportMeasurementError extends Error {}

export interface ReportCellMetrics {
  count: number;
  ascent: number;
  descent: number;
}

export function reportLineMetrics(
  lines: string[],
  size: number,
  cache?: Map<string, ReturnType<typeof measureText>>,
  measured?: () => void,
): ReportCellMetrics {
  const metrics = lines.map((value) => {
    const hit = cache?.get(value);
    if (hit) return hit;
    measured?.();
    const result = measureText(value, size);
    cache?.set(value, result);
    return result;
  });
  return {
    count: lines.length,
    ascent: Math.max(0, ...metrics.map((m) => m.ascent)),
    descent: Math.max(0, ...metrics.map((m) => m.descent)),
  };
}

/** Preserve the emission formula and its floating-point operation order. */
export function reportRowHeight(
  count: number,
  ascent: number,
  descent: number,
  heading = false,
  headerNote?: string,
) {
  const lineHeight = Math.max(3.6, ascent + descent + 0.6);
  const baseline = Math.max(4, ascent + 1);
  return (
    (heading && headerNote ? 4 : 0) +
    Math.max(
      count * 3.6 + (heading ? 5 : 4),
      baseline + (count - 1) * lineHeight + descent + 1,
    )
  );
}
