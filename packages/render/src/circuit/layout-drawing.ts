import { printableLabelGeometry } from "../symbols/printable-label.js";
import type { Diagnostic } from "@thermite/schema";
import type { IrFunction } from "@thermite/compiler";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import type { DeviceNode, PhysicalConductor } from "./types.js";
import type { CircuitPins } from "./layout-input.js";
import type { CircuitLabelState } from "./layout-routes.js";
type Label = CircuitLabelState["labels"][number];
export function circuitDrawingContents(
  state: CircuitLabelState,
  vertical: boolean,
  weights: ReadonlyMap<string, number>,
  diagnostics: Diagnostic[],
) {
  const { wireSvg, dots, labels, nodes, laidNodes, cs, emitNode, n } = state;
  const contents = [
    ...wireSvg,
    ...[...dots.values()].map(
      (p) =>
        `<circle data-circuit-junction="true" cx="${n(p.x)}" cy="${n(p.y)}" r=".55" fill="#17212b"/>`,
    ),
    ...labels.map((l) => circuitWireLabel(l, state)),
    ...nodes.map((d) => {
      const l = laidNodes.get(d.id)!;
      return emitNode(d, l.x!, l.y!, vertical, cs, diagnostics, false, weights);
    }),
  ].join("");
  return contents;
}

function circuitWireLabel(l: Label, state: CircuitLabelState) {
  const { cs, n } = state;
  return `<g data-wire-label="${attr(cs[l.index]!.id)}"><rect x="${n(l.x)}" y="${n(l.y)}" width="${n(l.width)}" height="${n(l.height)}" fill="white"/>${l.text
    .split("\n")
    .map((line, i) => circuitWireLabelLine(line, i, l, state))
    .join("")}</g>`;
}

function circuitWireLabelLine(
  line: string,
  i: number,
  l: Label,
  state: CircuitLabelState,
) {
  const { segments, text } = state;
  const p = printableLabelGeometry(
    { x: l.x, y: l.y + i * 3.1, width: l.width, height: 3.8 },
    line,
    l.width - 1.5,
    segments.filter((s) => s.index === l.index).map((s) => [s.a, s.b]),
    2.5,
    false,
  );
  return text(p.x, p.baseline, line);
}

export function circuitDrawingResult(
  state: CircuitLabelState,
  fs: IrFunction[],
  pins: CircuitPins,
  contents: string,
  diagnostics: Diagnostic[],
) {
  const { graph, group, nodes, cs, laidNodes, circuitDeviceTags } = state;
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
