import {
  hasPrintableFallback,
  printableTextInkMetrics,
  printableTextMetrics,
} from "./text-metrics.js";

export interface WrappedLineSpec {
  readonly text: string;
  readonly size: number;
  readonly bold?: boolean;
  readonly literal?: boolean;
}

export interface PlacedWrappedLine<T extends WrappedLineSpec> {
  readonly line: T;
  readonly y: number;
  readonly fallback: boolean;
}

/**
 * Shared fallback-aware baseline placement for wrapped text blocks.
 * Bundled-only blocks preserve exact legacy pitch arithmetic (`startY + i * legacyPitch`).
 * Whenever a line or its predecessor contains fallback clusters, baseline spacing
 * reserves at least previous descent + current ascent + legacy cap-height gap.
 */
export function placeWrappedLines<T extends WrappedLineSpec>(
  lines: readonly T[],
  startY: number,
  legacyPitch: number,
): PlacedWrappedLine<T>[] {
  const flags = lines.map((line) =>
    hasPrintableFallback(line.text, line.bold ?? false, line.literal ?? false),
  );
  if (!flags.some(Boolean))
    return lines.map((line, i) => ({
      line,
      y: startY + i * legacyPitch,
      fallback: false,
    }));
  const placed: PlacedWrappedLine<T>[] = [];
  for (let i = 0; i < lines.length; i++) {
    const curr = lines[i];
    const currFallback = flags[i] ?? false;
    if (!curr) continue;
    const prevEntry = placed[i - 1];
    if (!prevEntry) {
      placed.push({ line: curr, y: startY, fallback: currFallback });
      continue;
    }
    if (!prevEntry.fallback && !currFallback) {
      placed.push({
        line: curr,
        y: prevEntry.y + legacyPitch,
        fallback: false,
      });
      continue;
    }
    const prev = prevEntry.line;
    const prevM = printableTextInkMetrics(
      prev.text,
      prev.size,
      prev.bold ?? false,
      prev.literal ?? false,
    );
    const currM = printableTextInkMetrics(
      curr.text,
      curr.size,
      curr.bold ?? false,
      curr.literal ?? false,
    );
    const bundledCap = printableTextMetrics(
      "H",
      curr.size,
      curr.bold ?? false,
    ).top;
    const legacyGap = Math.max(0, legacyPitch - bundledCap);
    const pitch = Math.max(legacyPitch, -prevM.bottom + currM.top + legacyGap);
    placed.push({
      line: curr,
      y: prevEntry.y + pitch,
      fallback: currFallback,
    });
  }
  return placed;
}
