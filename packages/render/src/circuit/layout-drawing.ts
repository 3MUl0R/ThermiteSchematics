import { plannedCircuitCaption } from "./caption-plan.js";
import { circuitJunctionSvg } from "./junction-identity.js";
import { supportedCircuitLabels } from "./label-support.js";
import type { Diagnostic } from "@thermite/schema";
import type { IrFunction } from "@thermite/compiler";
import { escapeXmlAttribute as attr } from "../svg/escape.js";

import type { CircuitPins } from "./layout-input.js";
import type { CircuitLabelState } from "./layout-routes.js";
type Label = CircuitLabelState["labels"][number];
export function circuitDrawingContents(
  state: CircuitLabelState,
  vertical: boolean,
  weights: ReadonlyMap<string, number>,
  diagnostics: Diagnostic[],
) {
  const supported = supportedCircuitLabels(state);
  state = { ...state, labels: supported.labels };
  const { wireSvg, dots, labels, nodes, laidNodes, cs, emitNode } = state;
  const contents = [
    ...wireSvg,
    ...[...dots.values()].map((p) => circuitJunctionSvg(p, state)),
    ...labels.map((l) =>
      circuitWireLabel(l, state, supported.baseFallbacks.has(l.index)),
    ),
    ...nodes.map((d) => {
      const l = laidNodes.get(d.id)!;
      return emitNode(d, l.x!, l.y!, vertical, cs, diagnostics, false, weights);
    }),
  ].join("");
  return contents;
}

function circuitWireLabel(
  l: Label,
  state: CircuitLabelState,
  basePlacementFallback: boolean,
) {
  const { cs, n, text } = state;
  const plans = l.text.split("\n").map((line, i) => ({
    line,
    ...plannedCircuitCaption(line, i, l, state, basePlacementFallback),
  }));
  return (
    plans.map((p) => p.leader).join("") +
    `<g data-wire-label="${attr(cs[l.index]!.id)}"><rect x="${n(l.x)}" y="${n(l.y)}" width="${n(l.width)}" height="${n(l.height)}" fill="white"/>${plans.map((p) => text(p.x, p.baseline, p.line)).join("")}</g>`
  );
}

export function circuitDrawingResult(
  state: CircuitLabelState,
  fs: IrFunction[],
  pins: CircuitPins,
  contents: string,
  diagnostics: Diagnostic[],
) {
  const { graph, group, nodes, laidNodes, circuitDeviceTags } = state;
  const drawing = {
    id: group.id,
    label: group.label ?? group.id,
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(group.lineReference ? { lineReference: group.lineReference } : {}),
    width: graph.width!,
    height: graph.height!,
    deviceTags: circuitDeviceTags(nodes),
    content: `<g data-circuit-group="${attr(group.id)}"${group.lineReference ? ` data-source-line-reference="${attr(group.lineReference)}"` : ""}>${contents}</g>`,
    references: nodes.map((d) => {
      const l = laidNodes.get(d.id)!;
      return {
        deviceUid: d.device.uid,
        designation: d.device.designation,
        functions: d.functions.map((f) => f.id.functionKey),
        x: l.x! + d.width / 2,
        y: l.y! + d.height / 2,
      };
    }),
    coverage: circuitDrawingCoverage(state, fs, pins),
  };
  return drawing;
}

function circuitDrawingCoverage(
  state: CircuitLabelState,
  fs: IrFunction[],
  pins: CircuitPins,
) {
  const { cs, nodes, fkey, compare, key } = state;
  return {
    conductorIds: cs.map((c) => c.id),
    functionIds: fs.map(fkey).sort(compare),
    terminalIds: [...pins.keys()].sort(compare),
    boundaryTerminalIds: nodes
      .flatMap((d) =>
        d.pins
          .filter(
            (p) =>
              !d.functions.some((f) =>
                f.terminals.some((t) => key(t) === key(p.terminal)),
              ),
          )
          .map((p) => key(p.terminal)),
      )
      .sort(compare),
  };
}
