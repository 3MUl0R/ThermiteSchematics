import {
  circuitMarkName,
  composedCircuitMark,
  type CircuitMark,
} from "./circuit-mark.js";
import { PRINTABLE_SYMBOL_POLICY } from "./printable-policy.js";

type InterfacePin = { x: number; y: number; side: string };
export type InterfaceOutlineRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
const INTERFACE_MARKS = new Set([
  "level-sensor",
  "conductivity-probe",
  "receptacle",
  "ac-input",
  "dc-output",
  "source",
  "sensor-3wire",
]);
const n = (v: number) => String(Number(v.toFixed(3)));

export function usesCircuitInterface(
  functionKind: string,
  mark: CircuitMark,
): boolean {
  if (functionKind === "channel") return mark === "sensor-3wire";
  if (mark === "motor" || mark === "winding") return false;
  return INTERFACE_MARKS.has(circuitMarkName(mark));
}

/** Shared local outline rect painted by circuitInterfaceMark (undefined when omitted). */
export function interfaceOutlineRect(
  mark: CircuitMark,
  cx: number,
  cy: number,
  pins: readonly InterfacePin[],
  vertical: boolean,
  source = false,
): InterfaceOutlineRect | undefined {
  if (!pins.length || source) return undefined;
  if (mark === "sensor-3wire" && pins.length === 1) return undefined;
  const coordinates = pins.map((p) => (vertical ? p.x : p.y));
  if (conversionQualifierSpan(mark, vertical ? cx : cy, coordinates))
    return undefined;
  const low = Math.min(...coordinates) - 2,
    high = Math.max(...coordinates) + 2;
  return vertical
    ? { x: low, y: cy - 5, width: high - low, height: 10 }
    : { x: cx - 5, y: low, width: 10, height: high - low };
}

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

export function interfaceLeadTip(
  mark: CircuitMark,
  pin: InterfacePin,
  pins: readonly InterfacePin[],
  cx: number,
  cy: number,
  vertical: boolean,
  source: boolean,
) {
  const gap = PRINTABLE_SYMBOL_POLICY.separateStubGapMm;
  const depth =
    mark === "ac-input" || mark === "dc-output"
      ? 10 / 3 + gap
      : mark === "sensor-3wire" && pins.length === 1 && !source
        ? 10 / 3
        : 5 +
          (source ||
          circuitMarkName(mark) === "receptacle" ||
          pins.some((p) => p !== pin && p.side === pin.side)
            ? gap
            : 0);
  return vertical
    ? { x: pin.x, y: cy + (pin.side === "NORTH" ? -depth : depth) }
    : { x: cx + (pin.side === "WEST" ? -depth : depth), y: pin.y };
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
  const span = conversionQualifierSpan(mark, vertical ? cx : cy, coordinates);
  const rect = interfaceOutlineRect(mark, cx, cy, pins, vertical, source);
  const outline = rect
    ? `<rect data-electrical-role="functional-boundary" x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}"/>`
    : "";
  const leads = pins
    .map((p) => {
      const tip = interfaceLeadTip(mark, p, pins, cx, cy, vertical, source);
      const role = source ? ' data-source-stub="true"' : "";
      return vertical
        ? `<line data-electrical-role="terminal-lead"${role} x1="${n(p.x)}" x2="${n(tip.x)}" y1="${n(p.y)}" y2="${n(tip.y)}"/>`
        : `<line data-electrical-role="terminal-lead"${role} y1="${n(p.y)}" y2="${n(tip.y)}" x1="${n(p.x)}" x2="${n(tip.x)}"/>`;
    })
    .join("");
  return `<g data-function-interface="${circuitMarkName(mark)}" fill="none" stroke="#17212b" stroke-width=".35">${outline}${leads}</g>${composedCircuitMark(mark, cx, cy, vertical, span)}`;
}
