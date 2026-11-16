import { measureText, wrapText } from "../text-metrics.js";

/** A slash qualifier may stay with its preceding word at unchanged row count.
 * If the grouped atoms cannot fit, retain the native caption and geometry. */
export function wrapCaptionQualifier(value: string, width: number) {
  const original = wrapText(value, width, 2.7);
  if (!/\S+\s+\/\s+\S+/u.test(value)) return original;
  const lines: string[] = [];
  let line = "";
  for (const atom of value.normalize("NFC").match(/\S+(?:\s+\/\s+\S+)?/gu) ??
    []) {
    if (measureText(atom, 2.7).width > width) return original;
    const next = line ? `${line} ${atom}` : atom;
    if (measureText(next, 2.7).width > width) {
      lines.push(line);
      line = atom;
    } else line = next;
  }
  lines.push(line);
  return lines.length <= original.length ? lines : original;
}
