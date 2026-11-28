import { captionInk } from "../symbols/caption-ink.js";
import type { CaptionBox } from "../symbols/circuit-caption.js";
import {
  ATTACHMENT_LABEL_CLEARANCE_MM,
  circuitMarkInkBounds,
  circuitMarkName,
  circuitWindingPoints,
} from "../symbols/circuit.js";
import { TERMINAL_TEXT_SIZE } from "../symbols/circuit-text.js";
import { PRINTABLE_SYMBOL_POLICY } from "../symbols/printable-policy.js";
import { strokeMiters } from "../symbols/stroke-join.js";
import type { DeviceNode, FunctionRow, Pin } from "./types.js";

export const LATERAL_PIN_INSET_MM = 1.5;
// Half a millimetre plus room for the emitted stroke and glyph coordinates to
// round independently. This also preserves the established winding clearance.
const CLEARANCE_MM = 0.56;
const HALF_STROKE = PRINTABLE_SYMBOL_POLICY.conductorStrokeMm / 2;
type Point = readonly [number, number];

/** Bounds of the winding body and its miters. Horizontal rays from the first
 * and last corners to the pins sit below their respective captions. */
function windingBody(points: readonly Point[], coupled: boolean): CaptionBox {
  const body = points.slice(1, -1);
  const vertices: Point[] = [
    ...body.flatMap(([x, y]): Point[] => [
      [x - HALF_STROKE, y - HALF_STROKE],
      [x + HALF_STROKE, y + HALF_STROKE],
    ]),
    ...strokeMiters(points, HALF_STROKE),
  ];
  const first = body[0],
    last = body.at(-1);
  if (!coupled && first && last) {
    const [x, y] = first;
    vertices.push(
      [x + 4 + HALF_STROKE, y - 1],
      [x + 4 + HALF_STROKE, last[1] + 1],
    );
  }
  return {
    left: Math.min(...vertices.map((p) => p[0])),
    right: Math.max(...vertices.map((p) => p[0])),
    top: Math.min(...vertices.map((p) => p[1])),
    bottom: Math.max(...vertices.map((p) => p[1])),
  };
}

function lateralBody(
  row: FunctionRow,
  pins: readonly Pin[],
  pitch: number,
  coupled: boolean,
): CaptionBox[] {
  const { mark, f, center, slots, channelLines } = row;
  const rowPins = f.terminals.flatMap((t) => {
    const pin = pins.find((p) => p.terminal.terminalKey === t.terminalKey);
    return pin ? [pin] : [];
  });
  const ports = rowPins.map((pin) => pin.y);
  const [first, last] = rowPins;
  if (mark === "winding" && first && last) {
    // Only the direction of the horizontal leads affects the corner miters.
    const edge = (pin: Pin) => (pin.side === "WEST" ? -10 : 10);
    const b = windingBody(
      circuitWindingPoints(0, first.y, last.y, f.kind === "source", coupled, [
        edge(first),
        edge(last),
      ]),
      coupled,
    );
    return [b];
  }
  if (mark === "motor") {
    const radius = Math.max(5, (slots * pitch) / 2 - 2) + HALF_STROKE;
    return [
      {
        left: -radius,
        right: radius,
        top: center - radius,
        bottom: center + radius,
      },
    ];
  }
  const specialized = mark === "level-sensor" || mark === "sensor-3wire";
  if (channelLines && !specialized) return [];
  const markY = channelLines
    ? center - (9 + channelLines.length * 3.1) / 2 + 4
    : center;
  const ink = circuitMarkInkBounds(mark, false, true);
  const boxes = [{ ...ink, top: ink.top + markY, bottom: ink.bottom + markY }];
  if (
    ports.length &&
    [
      "level-sensor",
      "conductivity-probe",
      "receptacle",
      "sensor-3wire",
    ].includes(circuitMarkName(mark)) &&
    f.kind !== "source" &&
    (mark !== "sensor-3wire" || ports.length > 1) &&
    (!channelLines || mark === "sensor-3wire")
  ) {
    // Interface face has a 10 mm depth and a 0.35 mm outline.
    boxes.push({
      left: -5.175,
      right: 5.175,
      top: Math.min(...ports) - 2.175,
      bottom: Math.max(...ports) + 2.175,
    });
  }
  return boxes;
}

/** Reserve each label lane independently about the centred symbol ink. */
export function lateralPinClearanceWidth(
  pins: readonly Pin[],
  rows: readonly FunctionRow[],
  pitch: number,
  coupled: boolean,
  label: (p: Pin) => string,
) {
  const bodies = rows.flatMap((row) => lateralBody(row, pins, pitch, coupled));
  let width = 0;
  for (const pin of pins) {
    if (pin.omitLabel) continue;
    const west = pin.side === "WEST";
    const ink = captionInk(
      label(pin),
      west ? LATERAL_PIN_INSET_MM : -LATERAL_PIN_INSET_MM,
      pin.y - LATERAL_PIN_INSET_MM,
      TERMINAL_TEXT_SIZE,
      west ? "start" : "end",
    );
    for (const body of bodies) {
      if (
        ink.bottom + CLEARANCE_MM <= body.top ||
        body.bottom + CLEARANCE_MM <= ink.top
      )
        continue;
      const reach = west ? ink.right - body.left : body.right - ink.left;
      width = Math.max(width, 2 * (reach + CLEARANCE_MM + 0.002));
    }
  }
  return Math.ceil(width * 1000) / 1000;
}

const VERTICAL_BOX_MARKS = new Set([
  "level-sensor",
  "conductivity-probe",
  "receptacle",
  "sensor-3wire",
]);

function verticalBody(
  row: FunctionRow,
  pins: readonly Pin[],
  pitch: number,
  coupled: boolean,
  frame: Pick<DeviceNode, "verticalOffsetX" | "verticalScaleX">,
): CaptionBox[] {
  const { mark, f, center, slots, channelLines } = row;
  const laneX = (y: number) => y * frame.verticalScaleX + frame.verticalOffsetX;
  const cx = laneX(center);
  const rowPins = f.terminals.flatMap((t) => {
    const pin = pins.find((p) => p.terminal.terminalKey === t.terminalKey);
    return pin ? [pin] : [];
  });
  const portXs = rowPins.map((pin) => laneX(pin.y));
  const [first, last] = rowPins;
  if (mark === "winding" && first && last) {
    const edge = (pin: Pin) => (pin.side === "WEST" ? -10 : 10);
    const pts = circuitWindingPoints(
      0,
      laneX(first.y),
      laneX(last.y),
      f.kind === "source",
      coupled,
      [edge(first), edge(last)],
    );
    const b = windingBody(pts, coupled);
    return [{ left: b.top, right: b.bottom, top: b.left, bottom: b.right }];
  }
  if (mark === "motor") {
    const r =
      Math.max(5, (slots * pitch * frame.verticalScaleX) / 2 - 2) + HALF_STROKE;
    return [{ left: cx - r, right: cx + r, top: -r, bottom: r }];
  }
  const specialized = mark === "level-sensor" || mark === "sensor-3wire";
  if (channelLines && !specialized) return [];
  const offY = channelLines ? -(9 + channelLines.length * 3.1) / 2 + 4 : 0;
  const ink = circuitMarkInkBounds(mark, true, true);
  const boxes: CaptionBox[] = [
    {
      left: ink.left + cx,
      right: ink.right + cx,
      top: ink.top + offY,
      bottom: ink.bottom + offY,
    },
  ];
  if (
    portXs.length &&
    VERTICAL_BOX_MARKS.has(circuitMarkName(mark)) &&
    f.kind !== "source" &&
    (mark !== "sensor-3wire" || portXs.length > 1) &&
    (!channelLines || mark === "sensor-3wire")
  )
    boxes.push({
      left: Math.min(...portXs) - 2.175,
      right: Math.max(...portXs) + 2.175,
      top: -5.175,
      bottom: 5.175,
    });
  return boxes;
}

function verticalOffsetAttachmentHeight(
  pins: readonly Pin[],
  rows: readonly FunctionRow[],
  label: (p: Pin) => string,
  frame: Pick<DeviceNode, "verticalOffsetX" | "verticalScaleX">,
  verticalFooter: number,
): number {
  let hasNorthOffset = false;
  let hasSouthOffset = false;
  for (const row of rows) {
    const first = row.f.terminals[0];
    const last = row.f.terminals.at(-1);
    if (!first || !last) continue;
    const ends = row.mark === "earth" ? [first] : [first, last];
    ends.forEach((t, i) => {
      const targetSide = i === 0 ? "WEST" : "EAST";
      const pin =
        pins.find(
          (p) =>
            p.terminal.deviceUid === t.deviceUid &&
            p.terminal.terminalKey === t.terminalKey &&
            p.side === targetSide,
        ) ??
        pins.find(
          (p) =>
            p.terminal.deviceUid === t.deviceUid &&
            p.terminal.terminalKey === t.terminalKey,
        );
      if (!pin) return;
      if (pin.side !== targetSide) {
        hasNorthOffset = true;
        hasSouthOffset = true;
      } else if (Math.abs(pin.y - row.center) >= 1e-7) {
        if (targetSide === "WEST") hasNorthOffset = true;
        else hasSouthOffset = true;
      }
    });
  }
  if (!hasNorthOffset && !hasSouthOffset) return 0;
  let height = 0;
  for (const pin of pins) {
    if (pin.omitLabel) continue;
    const north = pin.side === "WEST";
    const pinX = pin.y * frame.verticalScaleX + frame.verticalOffsetX;
    const ink = captionInk(
      label(pin),
      pinX + 1,
      north ? 6 : -1.5,
      TERMINAL_TEXT_SIZE,
      "start",
    );
    if (north && hasNorthOffset)
      height = Math.max(
        height,
        2 * (ink.bottom + ATTACHMENT_LABEL_CLEARANCE_MM + 1 + 4) +
          verticalFooter,
      );
    if (!north && hasSouthOffset)
      height = Math.max(
        height,
        2 * (4 + 1 + ATTACHMENT_LABEL_CLEARANCE_MM - ink.top) - verticalFooter,
      );
  }
  return height;
}

/** Reserve vertical (TTB) terminal-label lanes clear of centered symbol ink. */
export function verticalPinClearanceHeight(
  pins: readonly Pin[],
  rows: readonly FunctionRow[],
  pitch: number,
  coupled: boolean,
  label: (p: Pin) => string,
  frame: Pick<DeviceNode, "verticalOffsetX" | "verticalScaleX">,
  verticalFooter: number,
) {
  const bodies = rows.flatMap((row) =>
    verticalBody(row, pins, pitch, coupled, frame),
  );
  let height = verticalOffsetAttachmentHeight(
    pins,
    rows,
    label,
    frame,
    verticalFooter,
  );
  for (const pin of pins) {
    if (pin.omitLabel) continue;
    const north = pin.side === "WEST";
    const pinX = pin.y * frame.verticalScaleX + frame.verticalOffsetX;
    const ink = captionInk(
      label(pin),
      pinX + 1,
      north ? 6 : -1.5,
      TERMINAL_TEXT_SIZE,
      "start",
    );
    for (const body of bodies) {
      if (
        ink.right + CLEARANCE_MM <= body.left ||
        body.right + CLEARANCE_MM <= ink.left
      )
        continue;
      const requiredHeight = north
        ? 2 * (ink.bottom + CLEARANCE_MM - body.top + 0.002) + verticalFooter
        : 2 * (body.bottom + CLEARANCE_MM - ink.top + 0.002) - verticalFooter;
      height = Math.max(height, requiredHeight);
    }
  }
  return Math.ceil(height * 1000) / 1000;
}
