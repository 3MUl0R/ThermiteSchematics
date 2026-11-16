import { printableLabelGeometry } from "../symbols/printable-label.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { CircuitLabelState } from "./layout-routes.js";
import {
  ownedWiringLabels,
  wiringLabelLeaders,
} from "../layout/wiring-label-support.js";
import { labelLeaderArrow } from "../layout/wire-label-support.js";
import { required } from "../presentation/util.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";

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
    ),
    occurrences = new Map<number, number>();
  const labels = state.labels.map((label) => {
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
  const path = (points: readonly { x: number; y: number }[]) =>
    points
      .map((p, i) => `${i ? "L" : "M"} ${state.n(p.x)} ${state.n(p.y)}`)
      .join(" ");
  const leaders = wiringLabelLeaders(graph).flatMap((leader) => {
    const owner = required(
      state.cs[Number(leader.edgeId.slice(1))],
      "Missing circuit label owner",
    );
    return [
      `<path class="wire-label-leader" data-label-leader-owner="${attr(owner.id)}" d="${path(leader.points)}" fill="none" stroke="#475467" stroke-width=".15" stroke-dasharray=".5 .375"/>`,
      `<path class="wire-label-leader-arrow" d="${path(labelLeaderArrow(leader.points, 0.75))}" fill="none" stroke="#475467" stroke-width=".15"/>`,
    ];
  });
  return { labels, leaders };
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
  const nearest = (
    ink: { left: number; right: number; top: number; bottom: number },
    own: boolean,
  ) =>
    Math.min(
      ...state.segments
        .filter((s) => (s.index === label.index) === own)
        .map(({ a, b }) =>
          Math.hypot(
            Math.max(
              Math.min(a.x, b.x) - ink.right,
              ink.left - Math.max(a.x, b.x),
              0,
            ),
            Math.max(
              Math.min(a.y, b.y) - ink.bottom,
              ink.top - Math.max(a.y, b.y),
              0,
            ),
          ),
        ),
    );
  return label.text.split("\n").some((line, i) => {
    const p = circuitCaptionGeometry(line, i, label, state),
      own = nearest(p.ink, true);
    return own > 2 || nearest(p.ink, false) < own - 1e-7;
  });
}
