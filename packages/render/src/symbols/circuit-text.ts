import {
  hasPrintableFallback,
  printableTextInkMetrics,
  printableTextWidth,
  textClusters,
} from "../text-metrics.js";

export const TERMINAL_TEXT_SIZE = 2.5;
export const CIRCUIT_CAPTION_PITCH = 3.1;
export const CIRCUIT_CAPTION_SLOT_HEIGHT = 3.8;
const CIRCUIT_CAPTION_SLOT_RATIO =
  CIRCUIT_CAPTION_SLOT_HEIGHT / TERMINAL_TEXT_SIZE;

export interface CircuitCaptionSlot {
  readonly yOffset: number;
  readonly height: number;
  readonly fallback: boolean;
}

/** Shared fallback-aware vertical slot placement for circuit wire captions.
 * Bundled-only blocks keep exact 3.1 mm pitch and 3.8 mm slot height. */
export function circuitCaptionSlots(
  lines: readonly string[],
  size = TERMINAL_TEXT_SIZE,
): CircuitCaptionSlot[] {
  if (!lines.some((line) => hasPrintableFallback(line)))
    return lines.map((_, i) => ({
      yOffset: i * CIRCUIT_CAPTION_PITCH,
      height: CIRCUIT_CAPTION_SLOT_HEIGHT,
      fallback: false,
    }));
  const slots: CircuitCaptionSlot[] = [];
  for (const line of lines) {
    const fallback = hasPrintableFallback(line);
    const m = fallback ? printableTextInkMetrics(line, size) : undefined;
    const height = m
      ? Math.max(
          CIRCUIT_CAPTION_SLOT_HEIGHT,
          Math.ceil((m.top - m.bottom) * CIRCUIT_CAPTION_SLOT_RATIO * 1000) /
            1000,
        )
      : CIRCUIT_CAPTION_SLOT_HEIGHT;
    const prev = slots.at(-1);
    const yOffset = !prev
      ? 0
      : !prev.fallback && !fallback
        ? prev.yOffset + CIRCUIT_CAPTION_PITCH
        : prev.yOffset + prev.height;
    slots.push({ yOffset, height, fallback });
  }
  return slots;
}

export function circuitCaptionHeight(
  lines: readonly string[],
  size = TERMINAL_TEXT_SIZE,
): number {
  if (!lines.length) return CIRCUIT_CAPTION_SLOT_HEIGHT;
  if (!lines.some((line) => hasPrintableFallback(line)))
    return (
      CIRCUIT_CAPTION_SLOT_HEIGHT + (lines.length - 1) * CIRCUIT_CAPTION_PITCH
    );
  const last = circuitCaptionSlots(lines, size).at(-1);
  return last ? last.yOffset + last.height : CIRCUIT_CAPTION_SLOT_HEIGHT;
}

export const measure = (value: string, size = TERMINAL_TEXT_SIZE) =>
  printableTextWidth(value, size);

export function circuitTextLines(
  value: string,
  width: number,
  size = TERMINAL_TEXT_SIZE,
  lineWidth: (value: string, size: number) => number = measure,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/u)) {
    if (line && lineWidth(`${line} ${word}`, size) > width) {
      lines.push(line);
      line = "";
    }
    if (lineWidth(word, size) > width) {
      for (const c of textClusters(word)) {
        if (line && lineWidth(line + c, size) > width) {
          lines.push(line);
          line = "";
        }
        line += c;
      }
    } else line += (line ? " " : "") + word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Preserve the measured channel-row reservation in either reading direction. */
export function channelRowSlots(
  lines: readonly string[] | undefined,
  vertical: boolean,
  mark: string,
  pitch: number,
): number {
  if (!lines) return 1;
  return Math.ceil(
    (vertical
      ? Math.max(...lines.map((line) => measure(line, TERMINAL_TEXT_SIZE))) +
        (mark === "sensor-3wire" ? 16 : 4)
      : circuitCaptionHeight(lines, TERMINAL_TEXT_SIZE) +
        0.1 +
        (["level-sensor", "sensor-3wire"].includes(mark) ? 9 : 0)) / pitch,
  );
}
