import type { PresentationLabel, PresentationGraph } from "../types.js";
import type { SvgAttributes } from "./writer.js";
import { decodeSvgSemanticId } from "./escape.js";
import { required } from "../presentation/util.js";
import type { RenderSourceRegistry } from "./source-registry.js";

export type TerminalCaptionOwner = {
  readonly bodyId: string;
  readonly key: string;
};

export function terminalCaptionOwners(
  graph: Readonly<PresentationGraph>,
): ReadonlyMap<string, TerminalCaptionOwner> {
  const owners = new Map<string, TerminalCaptionOwner>();
  for (const node of graph.nodes) {
    if (node.kind === "junction") continue;
    for (const port of node.ports)
      owners.set(port.id, { bodyId: node.id, key: port.terminal.terminalKey });
  }
  return owners;
}

export function rootedLabelAttributes(
  graph: Readonly<PresentationGraph>,
  registry: RenderSourceRegistry,
) {
  const owners = terminalCaptionOwners(graph);
  return (presentation: PresentationLabel): SvgAttributes =>
    tagLabelAttributes(presentation, graph.view, owners, registry);
}

export function tagLabelAttributes(
  presentation: PresentationLabel,
  view: PresentationGraph["view"],
  owners?: ReadonlyMap<string, TerminalCaptionOwner>,
  registry?: RenderSourceRegistry,
): SvgAttributes {
  if (presentation.role === "terminal" && owners && registry) {
    const owner = required(
      owners.get(presentation.ownerId),
      `Terminal caption ${presentation.id} has no owned port.`,
    );
    return {
      "data-terminal-key": registry.valueFor(
        "terminal.key",
        owner.key,
        `terminal caption ${presentation.id} key`,
      ),
      "data-terminal-caption-body": owner.bodyId,
    };
  }
  const source =
    presentation.role === "device"
      ? presentation.textSources.find((s) => s.field === "device.designation")
      : undefined;
  if (!source) return {};
  const owner = decodeSvgSemanticId("device", source.ownerId)[0];
  return {
    "data-tag-owner-uid": owner,
    ...(view.format === "schematic-view/0.2" && view.intent === "conductors"
      ? { "data-tag-field": "designation" }
      : { "data-tag-key": presentation.text }),
    "data-tag-kind": "body",
    "data-tag-block": owner,
  };
}
