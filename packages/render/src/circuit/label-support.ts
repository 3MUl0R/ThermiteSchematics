import { printableLabelGeometry } from "../symbols/printable-label.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { CircuitLabelState } from "./layout-routes.js";
import { ownedWiringLabels } from "../layout/wiring-label-support.js";
import { existingCircuitCaption } from "./caption-association.js";
import { fullyCoincidentCaption } from "./coincident-caption.js";
import { circuitCaptionPositions } from "./caption-recovery.js";
import { required } from "../presentation/util.js";

/** Feed the final, already recovered label reservations to the shared physical
 * segment planner. Native route arrays and fixed terminal geometry never change. */
export function supportedCircuitLabels(state: CircuitLabelState) {
  const input: ElkNode = {
    ...state.graph,
    edges: (state.graph.edges ?? []).map((edge) => ({
      ...edge,
      labels: state.labels
        .filter((l) => edge.id === `e${l.index}`)
        .map((l) => ({
          text: l.text,
          x: l.x,
          y: l.y,
          width: l.width,
          height: l.height,
        })),
    })),
  };
  const graph = ownedWiringLabels(
      input,
      (id, l) =>
        fullyCoincidentCaption(Number(id.slice(1)), state.segments) ||
        !circuitLabelNeedsMove(
          {
            index: Number(id.slice(1)),
            x: required(l.x, "Missing label x"),
            y: required(l.y, "Missing label y"),
            width: required(l.width, "Missing label width"),
            height: required(l.height, "Missing label height"),
            text: required(l.text, "Missing label text"),
          },
          state,
        ),
      circuitCaptionPositions,
    ),
    occurrences = new Map<number, number>();
  const labels = state.labels.map((label) => {
    if (fullyCoincidentCaption(label.index, state.segments)) return label;
    const i = occurrences.get(label.index) ?? 0;
    occurrences.set(label.index, i + 1);
    const p = required(
      graph.edges?.find((e) => e.id === `e${label.index}`)?.labels?.[i],
      "Missing circuit label reservation",
    );
    return {
      ...label,
      x: required(p.x, "Missing circuit label x"),
      y: required(p.y, "Missing circuit label y"),
    };
  });
  return { labels };
}

export function circuitCaptionGeometry(
  line: string,
  i: number,
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
) {
  return printableLabelGeometry(
    { x: label.x, y: label.y + i * 3.1, width: label.width, height: 3.8 },
    line,
    label.width - 1.5,
    state.segments
      .filter((s) => s.index === label.index)
      .map((s) => [s.a, s.b]),
    2.5,
    false,
  );
}
function circuitLabelNeedsMove(
  label: CircuitLabelState["labels"][number],
  state: CircuitLabelState,
) {
  const own = state.segments
      .filter((s) => s.index === label.index)
      .map((s) => [s.a, s.b]),
    foreign = state.segments.filter((s) => s.index !== label.index),
    strokes = foreign.map((s) =>
      required(state.cs[s.index], "Missing circuit conductor").jumper
        ? 0.55
        : 0.32,
    ),
    stroke = required(state.cs[label.index], "Missing circuit conductor").jumper
      ? 0.55
      : 0.32;
  return label.text.split("\n").some(
    (line, i) =>
      !existingCircuitCaption(
        circuitCaptionGeometry(line, i, label, state).ink,
        own,
        foreign.map((s) => [s.a, s.b]),
        strokes,
        stroke,
      ),
  );
}
