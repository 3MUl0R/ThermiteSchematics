import { measureText, wrapText } from "../text-metrics.js";
import { wrap } from "./svg.js";

/** Notes and pagination use the same measured words at the printed 2.5 mm em.
 * Retain the native layout when an indivisible word or line count cannot fit. */
export function reportNoteLayout(value: string, width: number) {
  const original = wrap(value, Math.floor(width / 1.6));
  if (
    (value.match(/\S+/gu) ?? []).some(
      (word) => measureText(word, 2.5).width > width,
    )
  )
    return { lines: original, fallback: "indivisible word" };
  const lines = wrapText(value, width, 2.5);
  return lines.length <= original.length
    ? { lines, fallback: undefined }
    : { lines: original, fallback: "native note capacity" };
}

export const reportNoteLines = (value: string, width: number) =>
  reportNoteLayout(value, width).lines;
