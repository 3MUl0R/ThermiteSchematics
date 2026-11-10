import { text } from "./svg.js";

export function cableRowLabels(
  a: readonly string[],
  z: readonly string[],
  centerRows: readonly string[],
  usage: string,
  position: { left: number; right: number; y: number; midY: number },
): string[] {
  const { left, right, y, midY } = position;
  const result: string[] = [];
  a.forEach((row, index) =>
    result.push(text(left, y + index * 4 + 4, row, 2.7)),
  );
  z.forEach((row, index) =>
    result.push(text(right, y + index * 4 + 4, row, 2.7, "end")),
  );
  centerRows.forEach((row, index) =>
    result.push(
      text((left + right) / 2, y + index * 4 + 3, row, 2.6, "middle"),
    ),
  );
  result.push(
    text(
      (left + right) / 2,
      midY + 4,
      usage === "unspecified"
        ? "ASSIGNED / USAGE UNSPECIFIED"
        : usage.toUpperCase(),
      2.2,
      "middle",
    ),
  );
  return result;
}
