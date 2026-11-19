import { composedCircuitMark, type CircuitMark } from "./circuit-mark.js";

type InterfacePin = { x: number; y: number; side: string };
const n = (v: number) => String(Number(v.toFixed(3)));

/** Fit the conversion outline over the physical span of its own terminals.
 * The existing 6⅔ mm depth leaves 1 mm before the tip of each independent lead. */
export function conversionQualifierSpan(
  mark: CircuitMark,
  coordinate: number,
  positions: readonly number[],
): readonly [number, number] | undefined {
  if (mark !== "ac-input" && mark !== "dc-output") return undefined;
  return [
    Math.min(-10 / 3, Math.min(...positions) - coordinate - 1.5),
    Math.max(10 / 3, Math.max(...positions) - coordinate + 1.5),
  ];
}

export function interfaceLeadEnd(
  mark: CircuitMark,
  source: boolean,
  count: number,
) {
  if (mark === "ac-input" || mark === "dc-output") return 13 / 3;
  if (source) return 6;
  return mark === "sensor-3wire" && count === 1 ? 10 / 3 : 5;
}

/** Interface leads and the presentation outline are independent for conversion. */
export function circuitInterfaceMark(
  mark: CircuitMark,
  cx: number,
  cy: number,
  pins: readonly InterfacePin[],
  vertical: boolean,
  source = false,
): string {
  const coordinates = pins.map((p) => (vertical ? p.x : p.y));
  const low = Math.min(...coordinates) - 2,
    high = Math.max(...coordinates) + 2;
  const span = conversionQualifierSpan(mark, vertical ? cx : cy, coordinates);
  const outline = vertical
    ? `<rect x="${n(low)}" y="${n(cy - 5)}" width="${n(high - low)}" height="10"/>`
    : `<rect x="${n(cx - 5)}" y="${n(low)}" width="10" height="${n(high - low)}"/>`;
  const sensorOutput = mark === "sensor-3wire" && pins.length === 1;
  const leadEnd = interfaceLeadEnd(mark, source, pins.length);
  const leads = pins
    .map((p) =>
      vertical
        ? `<line${source ? ' data-source-stub="true"' : ""} x1="${n(p.x)}" x2="${n(p.x)}" y1="${n(p.y)}" y2="${n(cy + (p.side === "NORTH" ? -leadEnd : leadEnd))}"/>`
        : `<line${source ? ' data-source-stub="true"' : ""} y1="${n(p.y)}" y2="${n(p.y)}" x1="${n(p.x)}" x2="${n(cx + (p.side === "WEST" ? -leadEnd : leadEnd))}"/>`,
    )
    .join("");
  return `<g data-function-interface="${mark}" fill="none" stroke="#17212b" stroke-width=".35">${source || sensorOutput || span ? "" : outline}${leads}</g>${composedCircuitMark(mark, cx, cy, vertical, span)}`;
}
