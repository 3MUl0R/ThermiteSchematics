import { describe, expect, it } from "vitest";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import type { IrDevice, IrDeviceType } from "@thermite/compiler";
import {
  admitExternalLandingCandidate,
  splitApproachClearanceGuard,
} from "../src/layout/circuit-external-landings.js";
import { circuitNodeClearanceGuard } from "../src/layout/circuit-native-guard.js";
import { extendSplitCircuitGraph } from "../src/circuit/recess-extension.js";
import type { DeviceNode } from "../src/circuit/types.js";

const port = (
  id: string,
  x: number,
  y: number,
  side: "EAST" | "WEST" | "NORTH" | "SOUTH",
): ElkPort => ({
  id,
  x,
  y,
  width: 0,
  height: 0,
  layoutOptions: { "elk.port.side": side },
});

const label = (text: string, x?: number, y?: number) => ({
  text,
  ...(x !== undefined ? { x, y } : {}),
  width: 8,
  height: 3.8,
  layoutOptions: { "elk.edgeLabels.inline": "true" },
});

function fanoutNodes(split: boolean): ElkNode[] {
  const n0Ports = split
    ? [
        port("p0-circuit-landing-negative", 20, 19.375, "EAST"),
        port("p0", 20, 20, "EAST"),
        port("p0-circuit-landing-positive", 20, 20.625, "EAST"),
      ]
    : [port("p0", 20, 20, "EAST")];
  return [
    {
      id: "n0",
      x: 5,
      y: 5,
      width: 20,
      height: 40,
      ports: n0Ports,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    },
    {
      id: "n1",
      x: 85,
      y: 5,
      width: 15,
      height: 16,
      ports: [port("q0", 0, 8, "WEST")],
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    },
    {
      id: "n2",
      x: 85,
      y: 29,
      width: 15,
      height: 16,
      ports: [port("q1", 0, 8, "WEST")],
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    },
  ];
}

function fanoutGraph(split: boolean, edges: ElkNode["edges"]): ElkNode {
  return {
    id: "fanout-tangent",
    width: 106,
    height: 50,
    children: fanoutNodes(split),
    edges,
  };
}

function routedEdge(
  id: string,
  src: string,
  tgt: string,
  xy: readonly number[],
  text: string,
  lx: number,
  ly: number,
) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push({ x: xy[i]!, y: xy[i + 1]! });
  return {
    id,
    sources: [src],
    targets: [tgt],
    sections: [
      {
        id: `${id}s`,
        startPoint: pts[0]!,
        bendPoints: pts.slice(1, -1),
        endPoint: pts.at(-1)!,
      },
    ],
    labels: [label(text, lx, ly)],
  };
}

function boundaryCounterexample() {
  const neg = "p0-circuit-landing-negative";
  const pos = "p0-circuit-landing-positive";
  const input = fanoutGraph(false, [
    { id: "e0", sources: ["p0"], targets: ["q0"], labels: [label("W0")] },
    { id: "e1", sources: ["p0"], targets: ["q1"], labels: [label("W1")] },
  ]);
  const base = fanoutGraph(false, [
    routedEdge(
      "e0",
      "p0",
      "q0",
      [25, 25, 45, 25, 45, 13, 85, 13],
      "W0",
      61,
      11.1,
    ),
    routedEdge(
      "e1",
      "p0",
      "q1",
      [25, 25, 45, 25, 45, 37, 85, 37],
      "W1",
      61,
      35.1,
    ),
  ]);
  const split = fanoutGraph(true, [
    { id: "e0", sources: [neg], targets: ["q0"], labels: [label("W0")] },
    { id: "e1", sources: [pos], targets: ["q1"], labels: [label("W1")] },
  ]);
  const candBoundary = fanoutGraph(true, [
    routedEdge("e0", neg, "q0", [25, 24.375, 25, 13, 85, 13], "W0", 61, 11.1),
    routedEdge("e1", pos, "q1", [25, 25.625, 25, 37, 85, 37], "W1", 61, 35.1),
  ]);
  const strokes = new Map([
    ["e0", 0.32],
    ["e1", 0.32],
  ]);
  return { input, base, split, candBoundary, strokes };
}

function nonRecessedDeviceNodes(): DeviceNode[] {
  const dev = (uid: string): IrDevice => ({
    uid,
    designation: uid,
    typeId: "t",
    description: "",
    properties: {},
    source: { file: "test.json", jsonPointer: `/objects/${uid}` },
  });
  const typ: IrDeviceType = {
    id: "t",
    kind: "device",
    description: "",
    symbol: "thermite:block",
    terminals: {},
    functions: {},
    source: { file: "types.json", jsonPointer: "/types/t" },
  };
  const make = (
    id: string,
    uid: string,
    pid: string,
    px: number,
    py: number,
    side: "EAST" | "WEST",
    w: number,
    h: number,
  ): DeviceNode => ({
    id,
    device: dev(uid),
    type: typ,
    functions: [],
    pins: [
      {
        id: pid,
        terminal: { deviceUid: uid, terminalKey: "1" },
        x: px,
        y: py,
        side,
        label: "1",
        outside: 0,
      },
    ],
    rows: [],
    boundary: true,
    width: w,
    height: h,
    rank: 0,
    pitch: 7,
    verticalOffsetX: 0,
    verticalScaleX: 1,
    relationLabels: [],
    tagColumnCaptions: [],
    sourceTerminalKeys: [],
    relations: [],
    gangs: [],
  });
  return [
    make("n0", "D0", "p0", 20, 20, "EAST", 20, 40),
    make("n1", "D1", "q0", 0, 8, "WEST", 15, 16),
    make("n2", "D2", "q1", 0, 8, "WEST", 15, 16),
  ];
}

describe("external landing admission launch and stroke-clearance guards (#630 review)", () => {
  it("rejects the synthetic boundary-running fan-out counterexample across all guards", () => {
    const { input, base, split, candBoundary, strokes } =
      boundaryCounterexample();
    expect(circuitNodeClearanceGuard(candBoundary)).toBe(false);
    expect(splitApproachClearanceGuard(candBoundary, input, strokes)).toBe(
      false,
    );
    expect(
      admitExternalLandingCandidate(
        candBoundary,
        split,
        input,
        base,
        undefined,
        strokes,
        [],
        true,
      ),
    ).toBe(false);
    // Also rejected when non-recessed DeviceNodes are supplied
    expect(
      extendSplitCircuitGraph(candBoundary, nonRecessedDeviceNodes(), strokes),
    ).toBeUndefined();
    expect(
      admitExternalLandingCandidate(
        candBoundary,
        split,
        input,
        base,
        nonRecessedDeviceNodes(),
        strokes,
        [],
        true,
      ),
    ).toBe(false);
  });

  it("rejects a tiny outward stub whose stroked vertical turn still overprints the symbol border", () => {
    const { input, base, split, candBoundary, strokes } =
      boundaryCounterexample();
    const scrape = structuredClone(candBoundary);
    // 0.20 mm outward launch followed by vertical turn at x=25.20:
    // stroke reaches 25.20 - 0.16 = 25.04, overlapping symbol border (25 + 0.15 = 25.15).
    scrape.edges![0]!.sections![0]!.bendPoints = [
      { x: 25.2, y: 24.375 },
      { x: 25.2, y: 13 },
    ];
    scrape.edges![1]!.sections![0]!.bendPoints = [
      { x: 25.2, y: 25.625 },
      { x: 25.2, y: 37 },
    ];
    expect(splitApproachClearanceGuard(scrape, input, strokes)).toBe(false);
    expect(
      admitExternalLandingCandidate(
        scrape,
        split,
        input,
        base,
        undefined,
        strokes,
        [],
        true,
      ),
    ).toBe(false);
  });

  it("rejects a split approach whose stroked launch collides with a neighbouring conductor", () => {
    const { input, base, split, candBoundary, strokes } =
      boundaryCounterexample();
    const crowded = structuredClone(candBoundary);
    crowded.edges![0]!.sections![0]!.bendPoints = [
      { x: 45, y: 24.375 },
      { x: 45, y: 13 },
    ];
    crowded.edges![1]!.sections![0]!.bendPoints = [
      { x: 35, y: 25.625 },
      { x: 35, y: 24.6 },
      { x: 45, y: 24.6 },
      { x: 45, y: 37 },
    ];
    // Horizontal segment at y=24.6 is 0.225 mm from e0's launch at y=24.375 (< 0.32 + 0.05)
    expect(splitApproachClearanceGuard(crowded, input, strokes)).toBe(false);
    expect(
      admitExternalLandingCandidate(
        crowded,
        split,
        input,
        base,
        undefined,
        strokes,
        [],
        true,
      ),
    ).toBe(false);
  });

  it("admits a valid normal-launch split with full symbol and conductor clearance", () => {
    const { input, base, split, candBoundary, strokes } =
      boundaryCounterexample();
    const clean = structuredClone(candBoundary);
    clean.edges![0]!.sections![0]!.bendPoints = [
      { x: 45, y: 24.375 },
      { x: 45, y: 13 },
    ];
    clean.edges![1]!.sections![0]!.bendPoints = [
      { x: 45, y: 25.625 },
      { x: 45, y: 37 },
    ];
    expect(circuitNodeClearanceGuard(clean)).toBe(true);
    expect(splitApproachClearanceGuard(clean, input, strokes)).toBe(true);
    expect(
      admitExternalLandingCandidate(
        clean,
        split,
        input,
        base,
        nonRecessedDeviceNodes(),
        strokes,
        [],
        true,
      ),
    ).toBe(true);
  });
});
