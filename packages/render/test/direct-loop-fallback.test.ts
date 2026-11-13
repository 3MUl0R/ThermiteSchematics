import { afterEach, expect, it, vi } from "vitest";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { parseHTML } from "linkedom";
import * as layouts from "../src/layout/direct-loop-layout.js";
import * as runtime from "../src/layout/elk-runtime.js";
import { checkLabels } from "../src/signal-loop.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { fixture, removeFixtures } from "../../cli/test/analog-output.cases.js";
import graphFixture from "./direct-loop-jog.fixture.json";

const factory = runtime.createElkEngine;
afterEach(async () => {
  vi.restoreAllMocks();
  await removeFixtures();
});

// Independent pre-inline reference: the exact Round 2 layout options.
async function round2(
  children: ElkNode[],
  edges: ElkExtendedEdge[],
  vertical: boolean,
) {
  return factory().layout({
    id: "loop",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": vertical ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "8",
      "elk.spacing.edgeEdge": vertical ? "3" : "6",
      "elk.spacing.edgeNode": "5",
      "elk.padding": "[top=6,left=6,bottom=6,right=6]",
      "elk.randomSeed": "1",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: structuredClone(children),
    edges: structuredClone(edges),
  });
}

it.each(["left-to-right", "top-to-bottom"] as const)(
  "preserves Round 2 refusal outcomes across uniform and mixed wire widths in %s",
  async (flow) => {
    const f = await fixture(),
      ir = await f.compile();
    const names = [
      (i: number) => `W${i}`,
      (i: number) => `W1${i}`,
      (i: number) => `AO${i}+`,
      (i: number) => `W-AO-0${i}`,
      ...[1, 3, 6, 10, 15, 19, 20, 21, 22, 26, 40, 80].map(
        (n) => (i: number) => `W${"A".repeat(n)}${i}`,
      ),
    ];
    const outcomes: boolean[] = [];
    for (const label of names)
      for (const mixed of [false, true]) {
        const input = structuredClone(ir);
        for (const [i, wire] of input.wires.entries())
          wire.designation = mixed && i % 2 ? `W${i + 1}` : label(i + 1);
        for (const entry of input.indexes.objectRefByDesignation) {
          const wire = input.wires.find((w) => w.uid === entry.value.uid);
          if (wire) entry.key = wire.designation!;
        }
        input.indexes.objectRefByDesignation.sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
        );
        const request = {
          ...f.packet,
          page: {
            ...f.packet.page,
            orientation: flow === "top-to-bottom" ? "portrait" : "landscape",
          },
          views: [{ ...f.packet.views[0], flow }],
        };
        const mock = vi
          .spyOn(layouts, "layoutDirectLoop")
          .mockImplementation(round2);
        const before = await renderSchematicPacket(input, request);
        mock.mockRestore();
        const after = await renderSchematicPacket(input, request);
        expect(
          after.ok,
          JSON.stringify({
            flow,
            label: input.wires[0]!.designation,
            mixed,
            before: before.ok ? null : before.error,
            after: after.ok ? null : after.error,
          }),
        ).toBe(before.ok);
        outcomes.push(before.ok);
        if (after.ok) {
          expect(after.value.sheets).toHaveLength(1);
          expect(
            parseHTML(after.value.sheets[0]!.svg).document.querySelectorAll(
              "[data-loop-conductor]",
            ),
          ).toHaveLength(6);
          // At this measured boundary 6 mm cannot fit the page, so the complete
          // legacy result must be reproduced, rather than mixing label modes.
          if (
            flow === "top-to-bottom" &&
            !mixed &&
            /^WA{20,21}\d$/.test(input.wires[0]!.designation!) &&
            before.ok
          )
            expect(after.value.sheets[0]!.svg).toBe(
              before.value.sheets[0]!.svg,
            );
        }
      }
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  },
);

it("retries the whole loop when no inline vertical segment fits the label height", async () => {
  const { children, edges } = structuredClone(graphFixture);
  const ids = edges.slice(0, 6).map((e) => e.id);
  for (const edge of edges.slice(0, 6)) edge.labels[0]!.height = 20;
  const inputs: ElkNode[] = [],
    outputs: ElkNode[] = [];
  vi.spyOn(runtime, "createElkEngine").mockImplementation(() => {
    const engine = factory();
    return {
      layout: async (input: ElkNode) => {
        inputs.push(structuredClone(input));
        const graph = await engine.layout(input);
        outputs.push(structuredClone(graph));
        return graph;
      },
    } as ReturnType<typeof factory>;
  });
  const graph = await layouts.layoutDirectLoop(
    children,
    edges,
    true,
    ids,
    checkLabels,
  );
  checkLabels(graph);
  expect(inputs).toHaveLength(2);
  expect(
    inputs[0]!
      .edges!.filter((e) => ids.includes(e.id))
      .every((e) => e.labels!.length === 0),
  ).toBe(true);
  expect(inputs[1]!.edges).toEqual(edges);
  expect(inputs[1]!.layoutOptions!["elk.spacing.edgeEdge"]).toBe("6");
  expect(graph).toEqual(outputs[1]);
});
