import { beforeAll, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { captionHostWitness } from "./helpers/circuit-caption-host.js";
import { circuitCaptionPlacement } from "../src/circuit/caption-placement.js";
import { circuitCaptionPlate } from "../src/circuit/inline-plate.js";
import { renderCircuitLayout } from "../src/circuit/layout-drawing.js";
import { circuitGraphInput } from "../src/circuit/layout-input.js";
import type { CircuitLabelState } from "../src/circuit/layout-routes.js";
let native: CircuitLabelState;
beforeAll(async () => {
  [, , , native] = await captionHostWitness();
});
const label = { index: 0, x: 10, y: 10, width: 12, height: 3.8, text: "103" };
function fixture(points: readonly { x: number; y: number }[]) {
  return {
    ...native,
    cs: native.cs.slice(0, 1).map((c) => ({ ...c, jumper: false })),
    labels: [label],
    routes: [{ index: 0, points: [...points] }],
    segments: points
      .slice(1)
      .map((b, i) => ({ index: 0, a: points[i] ?? b, b })),
    graph: { id: "plate-host", width: 50, height: 40, children: [], edges: [] },
  };
}
it("keeps an elbow outside the paint when only the reservation reaches it", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 21.5, y: 11.9 },
    { x: 21.5, y: 30 },
  ]);
  const p = circuitCaptionPlacement("103", 0, label, state);
  expect(p).toBeDefined();
  const plate = circuitCaptionPlate(label, state, p ? [p.ink] : []);
  expect(plate).toBeDefined();
  if (!plate || !p) throw Error("Expected measured plate");
  expect(plate.x + plate.width).toBeGreaterThan(p.ink.right);
  expect(21.5 - plate.x - plate.width).toBeGreaterThanOrEqual(0.35);
});

it("rejects a bend with less than a stroke of ink outside even the tight plate", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 18.4, y: 11.9 },
    { x: 18.4, y: 30 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, state)).toBeUndefined();
});

it("keeps a valid straight inline plate", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  expect(
    circuitCaptionPlacement("103", 0, label, state)?.points,
  ).toBeUndefined();
  expect(circuitCaptionPlacement("103", 0, label, state)).toBeDefined();
});

it("shrinks plate padding clear of a foreign stroke past its edge", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  state.segments.push({
    index: 1,
    a: { x: 22.04, y: 0 },
    b: { x: 22.04, y: 30 },
  });
  const plate = circuitCaptionPlate(label, state);
  expect(plate).toBeDefined();
  if (!plate) throw Error("Expected measured plate");
  expect(plate.x + plate.width).toBeLessThan(22.04 - 0.16);
});
it("leaves at least the painted plate height outside the terminal ring", () => {
  const clear = fixture([
    { x: 6, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  const hidden = fixture([
    { x: 11, y: 11.9 },
    { x: 35, y: 11.9 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, clear)).toBeDefined();
  const plate = circuitCaptionPlate(label, clear);
  expect(plate).toBeDefined();
  if (!plate) throw Error("Expected measured plate");
  expect(plate.x - 6 - 0.8).toBeGreaterThanOrEqual(Math.max(2, plate.height));
  expect(circuitCaptionPlacement("103", 0, label, hidden)).toBeUndefined();
});

it("rejects any plate interrupting a vertical run even with wide margins and accepts beside placement", () => {
  const centered = fixture([
    { x: 16, y: 0 },
    { x: 16, y: 30 },
  ]);
  const beside = fixture([
    { x: 9, y: 0 },
    { x: 9, y: 30 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, centered)).toBeUndefined();
  expect(circuitCaptionPlacement("103", 0, label, beside)).toBeDefined();
});
it("does not hide a second owned leg behind an otherwise valid straight host", () => {
  const state = fixture([
    { x: 0, y: 11.9 },
    { x: 35, y: 11.9 },
    { x: 35, y: 30 },
    { x: 16, y: 30 },
    { x: 16, y: 0 },
  ]);
  expect(circuitCaptionPlacement("103", 0, label, state)).toBeUndefined();
});

function loopNode(id: string, side: string, xs: readonly number[]) {
  return {
    id,
    width: 40,
    height: 20,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: xs.map((x, i) => ({
      id: `${id}p${i}`,
      x,
      y: 0,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": side },
    })),
  };
}

const loopEdge = (a: string, b: string) => ({
  id: `${a}-${b}`,
  sources: [a],
  targets: [b],
  labels: [{ text: "BRIDGE", width: 15, height: 5 }],
});

it("keeps 3 mm edgeEdge spacing for disjoint same-side loops and scopes nested spacing per node", () => {
  const n2 = loopNode("N2", "SOUTH", [0, 5, 30, 35]);
  const disjoint = circuitGraphInput(
    [loopNode("N1", "NORTH", [0, 5, 30, 35]), n2],
    [loopEdge("N1p0", "N1p1"), loopEdge("N1p2", "N1p3")],
    new Set([0, 1]),
    true,
    [],
  );
  expect(disjoint.layoutOptions?.["elk.spacing.edgeEdge"]).toBe("3");
  expect(
    disjoint.children?.map((c) => c.layoutOptions?.["elk.spacing.individual"]),
  ).toEqual([undefined, undefined]);

  const adjacent = circuitGraphInput(
    [loopNode("N1", "NORTH", [0, 5, 30, 35]), n2],
    [loopEdge("N1p0", "N1p1"), loopEdge("N1p1", "N1p2")],
    new Set([0, 1]),
    true,
    [],
  );
  expect(adjacent.layoutOptions?.["elk.spacing.edgeEdge"]).toBe("3");
  expect(
    adjacent.children?.map((c) => c.layoutOptions?.["elk.spacing.individual"]),
  ).toEqual([undefined, undefined]);

  const nested = circuitGraphInput(
    [loopNode("N1", "NORTH", [0, 10, 15, 35]), n2],
    [loopEdge("N1p1", "N1p2"), loopEdge("N1p0", "N1p3")],
    new Set([0, 1]),
    true,
    [],
  );
  expect(nested.layoutOptions?.["elk.spacing.edgeEdge"]).toBe("3");
  expect(
    nested.children?.map((c) => [
      c.id,
      c.layoutOptions?.["elk.spacing.individual"],
    ]),
  ).toEqual([
    ["N1", "spacing.edgeEdge:7.2"],
    ["N2", undefined],
  ]);
});

function multilineLeaderGraph(
  multiLabel: {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  },
  [p0, p1, p2]: readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ],
) {
  return {
    id: "multiline-leader",
    width: 70,
    height: 70,
    children: [
      { id: "obs-below", x: 10, y: 21.5, width: 25, height: 15 },
      { id: "obs-right", x: 37, y: 5, width: 25, height: 35 },
      { id: "obs-top", x: 26.8, y: 19.6, width: 9.2, height: 1 },
    ],
    edges: [
      {
        id: "e0",
        sources: ["p0"],
        targets: ["p1"],
        sections: [
          { id: "s0", startPoint: p0, bendPoints: [p1], endPoint: p2 },
        ],
        labels: [{ ...multiLabel }],
      },
    ],
  };
}

function multilineLeaderFixture() {
  const multiLabel = {
    index: 0,
    x: 15.5,
    y: 12.5,
    width: 18,
    height: 6.9,
    text: "BRIDGE\n18 AWG / Blue",
  };
  const route = [
    { x: 26, y: 21 },
    { x: 36, y: 21 },
    { x: 36, y: 29 },
  ] as const;
  const [p0, , p2] = route;
  const baseConductor = native.cs[0];
  const baseNode = native.nodes[0];
  if (!baseConductor || !baseNode) throw Error("Missing native fixture state");
  const conductor = { ...baseConductor, jumper: false };
  const [end0, end1] = conductor.ends;
  const stubNode = {
    ...baseNode,
    id: "n0",
    functions: [],
    relationLabels: [],
    tagColumnCaptions: [],
    pins: [
      {
        id: "p0",
        terminal: end0,
        x: p0.x,
        y: p0.y,
        side: "NORTH" as const,
        label: end0.terminalKey,
        outside: 0,
      },
      {
        id: "p1",
        terminal: end1,
        x: p2.x,
        y: p2.y,
        side: "NORTH" as const,
        label: end1.terminalKey,
        outside: 0,
      },
    ],
  };
  const state = {
    ...native,
    graph: multilineLeaderGraph(multiLabel, route),
    nodes: [stubNode],
    laidNodes: new Map([["n0", { id: "n0", x: 0, y: 0, width: 0, height: 0 }]]),
    cs: [conductor],
    emitNode: () => "",
    wireSvg: [],
    dots: new Map(),
    labels: [],
    routes: [],
    segments: [],
  };
  return { multiLabel, route: [...route], state };
}

it("emits one shared block leader per multiline offset caption block", () => {
  const { multiLabel, route, state } = multilineLeaderFixture();
  const placedState = {
    ...state,
    labels: [multiLabel],
    routes: [{ index: 0, points: route }],
    segments: route.slice(1).map((b, i) => ({ index: 0, a: route[i] ?? b, b })),
  };
  const line0 = circuitCaptionPlacement("BRIDGE", 0, multiLabel, placedState);
  const line1 = circuitCaptionPlacement(
    "18 AWG / Blue",
    1,
    multiLabel,
    placedState,
  );
  expect(line0?.points).toBeDefined();
  expect(line1?.points).toEqual(line0?.points);

  const drawing = renderCircuitLayout(state, [], new Map(), new Set(), true);
  const doc = parseHTML(drawing.content).document;
  const texts = [...doc.querySelectorAll("[data-wire-label] text")].map(
    (t) => t.textContent,
  );
  expect(texts).toEqual(["BRIDGE", "18 AWG / Blue"]);
  expect(doc.querySelectorAll("path.wire-label-leader")).toHaveLength(1);
  expect(doc.querySelectorAll("path.wire-label-leader-arrow")).toHaveLength(1);
});
