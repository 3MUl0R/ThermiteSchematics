import { beforeAll, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import type { ElectricalIr } from "@thermite/compiler";
import { terminalPassThroughFixture } from "../fixtures/presentation-cases.js";
import { layoutPresentationGraph } from "../src/layout/elk-adapter.js";
import { buildPresentationGraph } from "../src/presentation.js";
import { emitSchematicSvg } from "../src/svg/emitter.js";
import { svgSemanticId } from "../src/svg/escape.js";
import { duplicateTerminalCaptionIds } from "../src/svg/terminal-captions.js";
import { prepareSchematicTitleContext } from "../src/title-block.js";
import { compileCoreFixture } from "./fixtures.js";

let ir: ElectricalIr;
beforeAll(async () => {
  ir = await compileCoreFixture();
});

async function drawing(flow: "left-to-right" | "top-to-bottom") {
  // Synthetic two-wire pass-through: PS1.+ -> TB1.1 -> TB1.2. The
  // intermediate physical terminal has two distinct conductor landing ports.
  const f = terminalPassThroughFixture(ir);
  const b = buildPresentationGraph({
    ir: f.ir,
    selected: { ...f.selected, view: { ...f.selected.view, flow } },
  });
  if (!b.ok) throw Error(JSON.stringify(b));
  const l = await layoutPresentationGraph(b.value.graph);
  if (!l.ok) throw Error(JSON.stringify(l));
  return { graph: b.value.graph, layout: l.value };
}

it.each(["left-to-right", "top-to-bottom"] as const)(
  "prints one owned caption while preserving both landings and all layout data in %s",
  async (flow) => {
    const { graph, layout } = await drawing(flow);
    const node = graph.nodes.find(
      (n) =>
        n.kind === "symbol" &&
        n.symbolId === "ais:terminal" &&
        n.ports[0]?.terminal.terminalKey === "1",
    )!;
    const captions = node.labels.filter((l) => l.role === "terminal");
    expect(captions).toHaveLength(2);
    expect(node.ports).toHaveLength(2);
    expect(
      node.ports.map(
        (p) =>
          graph.edges.filter(
            (e) => e.sourcePortId === p.id || e.targetPortId === p.id,
          ).length,
      ),
    ).toEqual([1, 1]);
    const before = JSON.stringify({ graph, layout });
    const title = prepareSchematicTitleContext(
      "Synthetic pass-through",
      graph.view,
    );
    if (!title.ok) throw Error(JSON.stringify(title));
    const result = emitSchematicSvg(graph, layout, title.value);
    if (!result.ok) throw Error(JSON.stringify(result));
    const document = new DOMParser().parseFromString(
      result.value,
      "image/svg+xml",
    );
    const printed = captions.filter(
      (c) =>
        document.querySelector(
          `text[clip-path="url(#${svgSemanticId("clip", [c.id])})"]`,
        )?.textContent === "1",
    );
    expect(printed).toHaveLength(1);
    for (const p of node.ports)
      expect(
        document.getElementById(
          svgSemanticId("terminal", [
            p.terminal.deviceUid,
            p.terminal.terminalKey,
            p.symbolPortId,
          ]),
        ),
      ).not.toBeNull();
    expect(document.querySelectorAll("path.wire-path")).toHaveLength(2);
    expect(JSON.stringify({ graph, layout })).toBe(before);
  },
);

it("uses the nearest existing body slot and keeps a separate appearance's caption", async () => {
  const { graph, layout } = await drawing("left-to-right");
  const node = graph.nodes.find(
    (n) =>
      n.kind === "symbol" &&
      n.labels.filter((l) => l.role === "terminal").length === 2,
  )!;
  const [first, second] = node.labels.filter((l) => l.role === "terminal");
  const positions = layout.labels.map((l) =>
    l.id === first!.id ? { ...l, x: -1000 } : l,
  );
  const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
  expect(
    duplicateTerminalCaptionIds(graph, positions, nodes).has(first!.id),
  ).toBe(true);
  expect(
    duplicateTerminalCaptionIds(graph, positions, nodes).has(second!.id),
  ).toBe(false);
  const separate = {
    ...second!,
    id: "separate-caption",
    ownerId: "separate-port",
  };
  const port = node.ports.find((p) => p.id === second!.ownerId)!;
  const appearance = {
    ...node,
    id: "separate-appearance",
    labels: [separate],
    ports: [{ ...port, id: separate.ownerId }],
  };
  const separatePosition = {
    ...positions.find((l) => l.id === second!.id)!,
    id: separate.id,
    ownerId: separate.ownerId,
  };
  nodes.set(appearance.id, { ...nodes.get(node.id)!, id: appearance.id });
  expect(
    duplicateTerminalCaptionIds(
      { ...graph, nodes: [...graph.nodes, appearance] },
      [...positions, separatePosition],
      nodes,
    ).has(separate.id),
  ).toBe(false);
  expect(
    duplicateTerminalCaptionIds(
      { ...graph, nodes: [...graph.nodes].reverse() },
      [...positions].reverse(),
      nodes,
    ),
  ).toEqual(duplicateTerminalCaptionIds(graph, positions, nodes));
});

it("breaks equally near caption-slot ties by catalog port order", async () => {
  const { graph, layout } = await drawing("top-to-bottom");
  const node = graph.nodes.find(
    (n) =>
      n.kind === "symbol" &&
      n.labels.filter((l) => l.role === "terminal").length === 2,
  )!;
  const ports = [...node.ports].sort((a, b) => a.order - b.order);
  const captions = node.labels.filter((l) => l.role === "terminal");
  const positions = layout.labels.map((l) =>
    captions.some((c) => c.id === l.id) ? { ...l, x: 0, y: 0 } : l,
  );
  const hidden = duplicateTerminalCaptionIds(
    graph,
    positions,
    new Map(layout.nodes.map((n) => [n.id, n])),
  );
  expect(hidden.has(captions.find((c) => c.ownerId === ports[0]!.id)!.id)).toBe(
    false,
  );
  expect(hidden.has(captions.find((c) => c.ownerId === ports[1]!.id)!.id)).toBe(
    true,
  );
});
