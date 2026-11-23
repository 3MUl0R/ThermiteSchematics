import { circuitCaptionGeometry } from "./caption-geometry.js";
import type { CircuitLabelState } from "./layout-routes.js";
import {
  rectInkBox,
  routeInkDistance,
  segmentTouchesBox,
  pointInsideBox,
  type InkBox,
} from "../layout/ink-geometry.js";

const BEND_CLEARANCE = 0.36;
// The painted circuit terminal is the .65 mm radius plus half its .3 mm
// stroke. Leave 0.01 mm for formatting the SVG coordinates.
const TERMINAL_EDGE = 0.81;
// Circuit junction dots are painted at r = 0.55 mm; keep plates outside the
// dot and leave >= 0.50 mm of visible horizontal ray so DQ-13 sees all rays.
const JUNCTION_DOT_RADIUS = 0.55;
const JUNCTION_CLEARANCE = 1.05;

function terminalClearance(
  point: { x: number; y: number },
  route: readonly { x: number; y: number }[],
  height: number,
) {
  return point === route[0] || point === route.at(-1)
    ? Math.max(2, height) + TERMINAL_EDGE
    : BEND_CLEARANCE;
}

function dotDistanceToBox(point: { x: number; y: number }, box: InkBox) {
  return Math.hypot(
    Math.max(box.left - point.x, point.x - box.right, 0),
    Math.max(box.top - point.y, point.y - box.bottom, 0),
  );
}

function runDotsClear(
  box: InkBox,
  start: { x: number; y: number },
  end: { x: number; y: number },
  y: number,
  dots: CircuitLabelState["dots"],
) {
  for (const dot of dots.values()) {
    if (
      Math.abs(dot.y - y) <= 0.01 &&
      dot.x >= start.x - 0.01 &&
      dot.x <= end.x + 0.01 &&
      box.left < dot.x + JUNCTION_CLEARANCE - 1e-7 &&
      box.right > dot.x - JUNCTION_CLEARANCE + 1e-7
    )
      return false;
  }
  return true;
}

/** A plate may interrupt one straight owned run, with printed ink clear
 * of both terminals and bends. Beside and leader plates leave the run whole. */
export function circuitCaptionPlateFits(
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
) {
  return circuitCaptionPlate(label, state) !== undefined;
}

export function circuitCaptionPlate(
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
  printedInk?: readonly InkBox[],
) {
  if (plateFits(label, state)) return label;
  const ink =
    printedInk ??
    label.text
      .split("\n")
      .map((line, i) => circuitCaptionGeometry(line, i, label, state).ink);
  // Keep a visible pad around the measured glyphs. The original ELK
  // reservation still protects neighbours and is the maximum painted area.
  const pad = 0.25;
  const x = Math.max(label.x, Math.min(...ink.map((b) => b.left)) - pad),
    y = Math.max(label.y, Math.min(...ink.map((b) => b.top)) - pad),
    right = Math.min(
      label.x + label.width,
      Math.max(...ink.map((b) => b.right)) + pad,
    ),
    bottom = Math.min(
      label.y + label.height,
      Math.max(...ink.map((b) => b.bottom)) + pad,
    );
  const plate = { ...label, x, y, width: right - x, height: bottom - y };
  if (plateFits(plate, state)) return plate;
}

function plateFits(
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
) {
  const box = rectInkBox(label);
  if (
    [...state.dots.values()].some(
      (point) =>
        pointInsideBox(point, box) ||
        dotDistanceToBox(point, box) <= JUNCTION_DOT_RADIUS + 0.01,
    )
  )
    return false;
  if (
    state.segments.some(
      (s) =>
        s.index !== label.index &&
        routeInkDistance(
          box,
          [[s.a, s.b]],
          state.cs[s.index]?.jumper ? 0.55 : 0.32,
        ) <= 0.01,
    )
  )
    return false;
  const hidden = state.segments.filter(
    (s) => s.index === label.index && segmentTouchesBox(s.a, s.b, box),
  );
  if (!hidden.length) return true;
  const run = hidden[0],
    owner = state.routes.find((r) => r.index === label.index);
  if (hidden.length !== 1 || !run || !owner) return false;
  const { a, b } = run;
  if (Math.abs(a.y - b.y) >= 1e-7) return false;
  const [start, end] = a.x < b.x ? [a, b] : [b, a];
  const jumper = Boolean(state.cs[label.index]?.jumper);
  return (
    (!jumper || runDotsClear(box, start, end, a.y, state.dots)) &&
    box.left - start.x >=
      terminalClearance(start, owner.points, label.height) &&
    end.x - box.right >= terminalClearance(end, owner.points, label.height)
  );
}
