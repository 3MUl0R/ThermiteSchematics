import { afterEach, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { compileCoreProjectFixture, required } from "./fixtures.js";
import { renderSchematicPacket } from "../src/index.js";
import * as branch from "../src/packet/fold-branch-input.js";
import { foldTrialTrace } from "../src/packet/fold-final-context.js";
import { routeGrowth } from "../src/packet/rooted-clipped-routes.js";
import { powerRouteGraph } from "../src/layout/power-placement-guard.js";
import {
  circuitConductorNonRegression,
  circuitConductorGuard,
  circuitRouteMetrics,
} from "../src/layout/circuit-route-quality.js";
import { conductorKey } from "../src/presentation/util.js";
import { ELK_OPTIONS } from "../src/layout/options.js";

afterEach(() => vi.restoreAllMocks());

function tailLabels(node: ElkNode, labels: ReadonlySet<string>): void {
  node.children?.forEach((child) => tailLabels(child, labels));
  for (const edge of node.edges ?? [])
    for (const label of edge.labels ?? [])
      if (label.id && labels.has(label.id))
        label.layoutOptions = {
          ...label.layoutOptions,
          [ELK_OPTIONS.edgeLabelsPlacement]: "TAIL",
        };
}

it("rejects the measured tail-label proposal's two ordinary L2 bends even with no new jog or detour", async () => {
  const c = await compileCoreProjectFixture(),
    input = branch.foldBranchInput;
  vi.spyOn(branch, "foldBranchInput").mockImplementation(
    (graph, labels, spacing) => {
      const copy = input(graph, labels, spacing);
      tailLabels(copy, labels);
      return copy;
    },
  );
  const trials: NonNullable<Parameters<typeof foldTrialTrace.run>[0]> = [];
  const result = await foldTrialTrace.run(trials, () =>
    renderSchematicPacket(
      c.ir,
      {
        format: "schematic-packet-request/0.1",
        layout: "compact",
        page: { size: "tabloid", orientation: "portrait" },
        views: [
          {
            format: "schematic-view-request/0.1",
            family: "power",
            flow: "left-to-right",
            root: { by: "designation", value: "M1" },
          },
          {
            format: "schematic-view-request/0.1",
            family: "control",
            flow: "left-to-right",
            root: { by: "designation", value: "K1" },
          },
        ],
      },
      c.presentation,
    ),
  );
  if (!result.ok) throw Error(JSON.stringify(result.error));
  expect(trials.length).toBe(2);
  for (const trial of trials) {
    const edge = required(
      trial.candidate.prepared.graph.edges.find(
        (e) => e.label?.text === "L2-CB1-K1",
      ),
    );
    const key = conductorKey(required(edge.elementIds[0]));
    for (const clipped of [false, true]) {
      const before = powerRouteGraph(trial.reference, clipped),
        after = powerRouteGraph(trial.candidate, clipped);
      expect(routeGrowth(trial.candidate, trial.reference, clipped)).toEqual([
        0, 0, 0, 0,
      ]);
      expect(
        circuitRouteMetrics(required(before.edges?.find((e) => e.id === key)))
          .bends,
      ).toBe(0);
      expect(
        circuitRouteMetrics(required(after.edges?.find((e) => e.id === key)))
          .bends,
      ).toBe(2);
      expect(circuitConductorNonRegression(after, before)).toBe(false);
    }
    expect(trial.routesAllowed).toBe(false);
  }
  expect(result.value).toBe(required(trials[0]).basePacket);
}, 30000);

function routed(height: number): ElkNode {
  return {
    id: "synthetic-route",
    edges: [
      {
        id: "same-two-ended-conductor",
        sources: ["a"],
        targets: ["b"],
        sections: [
          {
            id: "section",
            startPoint: { x: 0, y: 0 },
            endPoint: { x: 100, y: 0 },
            bendPoints: [
              { x: 30, y: 0 },
              { x: 30, y: height },
              { x: 70, y: height },
              { x: 70, y: 0 },
            ],
          },
        ],
      },
    ],
  };
}

it("keeps the existing length allowance and the ordinary quality pass's strict improvement requirement", () => {
  const original = routed(10),
    boundary = routed(25),
    excess = routed(25.005);
  expect(circuitRouteMetrics(required(original.edges?.[0]))).toMatchObject({
    length: 120,
    bends: 4,
    jogs: [],
    detours: [],
  });
  expect(circuitRouteMetrics(required(excess.edges?.[0]))).toMatchObject({
    bends: 4,
    jogs: [],
    detours: [],
  });
  expect(circuitConductorNonRegression(boundary, original)).toBe(true);
  expect(circuitConductorNonRegression(excess, original)).toBe(false);
  expect(circuitConductorGuard(boundary, original)).toBe(false);
});
