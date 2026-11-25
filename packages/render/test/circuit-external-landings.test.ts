import { afterEach, expect, it, vi } from "vitest";
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
import { compileProject, lockProject } from "@thermite/compiler";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "../src/layout/elk-runtime.js";
import { createElkEngine } from "../src/layout/elk-runtime.js";
import {
  circuitLayoutRun,
  layoutCircuitGroup,
} from "../src/layout/circuit-inline.js";
import { circuitInlineTrace } from "../src/layout/circuit-inline-context.js";
import {
  admitExternalLandingCandidate,
  circuitHasMergedExternalLandings,
  conservesOriginalPhysicalEndpoints,
  externalCircuitLandingInput,
  perSiteLandingNonRegression,
} from "../src/layout/circuit-external-landings.js";
import { elkWorkLedger, elkWorkScope } from "../src/layout/elk-work.js";
import { renderSchematicSheets } from "../src/index.js";
import type { CircuitViewRequest } from "../src/circuit.js";
import type { DeviceNode } from "../src/circuit/types.js";
import { CIRCUIT_LANDING_OFFSET } from "../src/circuit/landing-ports.js";
import { required } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

const BASE_OPTS = {
  "elk.algorithm": "layered",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "5",
  "elk.layered.spacing.nodeNodeBetweenLayers": "12",
  "elk.spacing.edgeNode": "3",
  "elk.spacing.edgeEdge": "3",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "3",
  "elk.layered.spacing.edgeNodeBetweenLayers": "3",
  "elk.spacing.edgeLabel": "1",
  "elk.padding": "[top=2,left=2,bottom=2,right=2]",
  "elk.randomSeed": "1",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
  "elk.layered.mergeEdges": "false",
};
const SRC = { file: "test.json", line: 1, column: 1 };

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

const edge = (
  id: string,
  src: string,
  tgt: string,
  text: string,
): ElkExtendedEdge => ({
  id,
  sources: [src],
  targets: [tgt],
  labels: [
    {
      text,
      width: 8,
      height: 3.8,
      layoutOptions: { "elk.edgeLabels.inline": "true" },
    },
  ],
});

function routeEdge(
  id: string,
  src: string,
  tgt: string,
  pts: readonly (readonly [number, number])[],
): ElkExtendedEdge {
  const first = required(pts[0]);
  const last = required(pts.at(-1));
  return {
    id,
    sources: [src],
    targets: [tgt],
    labels: [
      {
        text: id,
        x: (first[0] + last[0]) / 2,
        y: (first[1] + last[1]) / 2 - 2,
        width: 8,
        height: 3.8,
        layoutOptions: { "elk.edgeLabels.inline": "true" },
      },
    ],
    sections: [
      {
        id: `${id}s`,
        startPoint: { x: first[0], y: first[1] },
        endPoint: { x: last[0], y: last[1] },
        bendPoints: pts.slice(1, -1).map(([x, y]) => ({ x, y })),
      },
    ],
  };
}

function fanoutGraph(
  count: 2 | 3,
  vertical = false,
  reverseModel = false,
): ElkNode {
  const srcSide = vertical ? "SOUTH" : "EAST";
  const tgtSide = vertical ? "NORTH" : "WEST";
  const srcNode: ElkNode = {
    id: "n0",
    width: vertical ? 24 : 38,
    height: vertical ? 24 : 28,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: [port("p0", vertical ? 12 : 38, vertical ? 24 : 14, srcSide)],
  };
  const indices = Array.from({ length: count }, (_, i) => i);
  const order = reverseModel ? [...indices].reverse() : indices;
  const dests: ElkNode[] = order.map((k) => ({
    id: `n${k + 1}`,
    width: 24,
    height: 16,
    layoutOptions: { "elk.portConstraints": "FIXED_POS" },
    ports: [port(`q${k}`, vertical ? 12 : 0, vertical ? 0 : 8, tgtSide)],
  }));
  return {
    id: `fanout-${count}-${vertical ? "ttb" : "ltr"}`,
    layoutOptions: {
      ...BASE_OPTS,
      "elk.direction": vertical ? "DOWN" : "RIGHT",
    },
    children: [srcNode, ...dests],
    edges: indices.map((k) => edge(`e${k}`, "p0", `q${k}`, `W10${k}`)),
  };
}

function makeTagLane(
  id: string,
  pin: DeviceNode["pins"][number],
  tagOnPin: boolean,
) {
  const bodyW = 20;
  const outerW = 38;
  const tagY = tagOnPin ? 12 : 1;
  return {
    body: {
      width: bodyW,
      height: 28,
      rows: [],
      pins: [{ ...pin, x: bodyW }],
      tagColumnCaptions: [],
    },
    geometry: {
      bodyX: 0,
      bodyY: 0,
      tagX: bodyW + 1,
      tagY,
      width: outerW,
      height: 28,
      side: "right" as const,
      stems: [{ from: { x: bodyW, y: 14 }, to: { x: outerW, y: 14 } }],
    },
    plan: {
      ownerId: id,
      lines: ["PS1"],
      widthMm: 14,
      heightMm: 5,
      fontSizeMm: 2.8,
      lineHeightMm: 3.4,
      baselineOffsetMm: 2.5,
      overflow: false,
      textAnchor: "start" as const,
      x: bodyW + 1,
      y: tagY,
    },
  };
}

function stubNode(
  id: string,
  portId: string,
  kind: "tagged" | "blocked" | "dest",
): DeviceNode {
  const isDest = kind === "dest";
  const pin = {
    id: portId,
    terminal: { deviceUid: id, terminalKey: isDest ? "1" : "+" },
    label: isDest ? "1" : "+",
    side: isDest ? ("WEST" as const) : ("EAST" as const),
    x: isDest ? 0 : 38,
    y: isDest ? 8 : 14,
    outside: 0,
  };
  return {
    id,
    device: {
      uid: id,
      designation: isDest ? id.toUpperCase() : "PS1",
      typeId: isDest ? "t2" : "t1",
      source: SRC,
    },
    type: {
      id: isDest ? "t2" : "t1",
      name: isDest ? "Load" : "Supply",
      terminals: [],
      functions: [],
      source: SRC,
    },
    functions: [],
    gangs: [],
    rows: [],
    pins: [pin],
    width: isDest ? 24 : 38,
    height: isDest ? 16 : 28,
    relations: [],
    relationLabels: [],
    tagColumnCaptions: [],
    tagLane: isDest ? undefined : makeTagLane(id, pin, kind === "blocked"),
  };
}

const defaultStrokes = (input: ElkNode, weight = 0.32) =>
  new Map((input.edges ?? []).map((e) => [e.id, weight]));

function perSiteInput(): ElkNode {
  return {
    id: "per-site",
    children: [
      {
        id: "nA",
        x: 0,
        y: 0,
        width: 20,
        height: 40,
        ports: [port("pA", 20, 20, "EAST")],
      },
      {
        id: "nB",
        x: 0,
        y: 60,
        width: 20,
        height: 40,
        ports: [port("pB", 20, 20, "EAST")],
      },
      {
        id: "nT",
        x: 80,
        y: 0,
        width: 20,
        height: 100,
        ports: [
          port("t0", 0, 10, "WEST"),
          port("t1", 0, 20, "WEST"),
          port("t2", 0, 30, "WEST"),
          port("t3", 0, 70, "WEST"),
          port("t4", 0, 90, "WEST"),
        ],
      },
    ],
    edges: [
      edge("e0", "pA", "t0", "W0"),
      edge("e1", "pA", "t1", "W1"),
      edge("e2", "pA", "t2", "W2"),
      edge("e3", "pB", "t3", "W3"),
      edge("e4", "pB", "t4", "W4"),
    ],
  };
}

function perSiteBase(input: ElkNode): ElkNode {
  return {
    ...structuredClone(input),
    edges: [
      routeEdge("e0", "pA", "t0", [
        [20, 20],
        [40, 20],
        [40, 10],
        [80, 10],
      ]),
      routeEdge("e1", "pA", "t1", [
        [20, 20],
        [80, 20],
      ]),
      routeEdge("e2", "pA", "t2", [
        [20, 20],
        [40, 20],
        [40, 30],
        [80, 30],
      ]),
      routeEdge("e3", "pB", "t3", [
        [20, 80],
        [20, 70],
        [80, 70],
      ]),
      routeEdge("e4", "pB", "t4", [
        [20, 80],
        [20, 90],
        [80, 90],
      ]),
    ],
  };
}

function perSiteFixedA(base: ElkNode): ElkNode {
  const d = CIRCUIT_LANDING_OFFSET;
  const g = structuredClone(base);
  required(g.children?.[0]).ports = [
    port("pA-circuit-landing-negative", 20, 20 - d, "EAST"),
    port("pA", 20, 20, "EAST"),
    port("pA-circuit-landing-positive", 20, 20 + d, "EAST"),
  ];
  g.edges = [
    routeEdge("e0", "pA-circuit-landing-negative", "t0", [
      [20, 20 - d],
      [40, 20 - d],
      [40, 10],
      [80, 10],
    ]),
    routeEdge("e1", "pA", "t1", [
      [20, 20],
      [80, 20],
    ]),
    routeEdge("e2", "pA-circuit-landing-positive", "t2", [
      [20, 20 + d],
      [40, 20 + d],
      [40, 30],
      [80, 30],
    ]),
    required(g.edges?.[3]),
    required(g.edges?.[4]),
  ];
  return g;
}

it.each([false, true])(
  "admits 3-conductor and 2-conductor non-interleaved external splits cleanly (vertical=%s)",
  async (vertical) => {
    for (const count of [2, 3] as const) {
      const input = fanoutGraph(count, vertical);
      const nodes = vertical
        ? undefined
        : [
            stubNode("n0", "p0", "tagged"),
            ...Array.from({ length: count }, (_, k) =>
              stubNode(`n${k + 1}`, `q${k}`, "dest"),
            ),
          ];
      const run = circuitLayoutRun();
      const base = await layoutCircuitGroup(
        input,
        run,
        defaultStrokes(input),
        [],
        nodes,
      );
      expect(circuitHasMergedExternalLandings(base)).toBe(true);
      run.quality = true;
      const selected = await layoutCircuitGroup(
        input,
        run,
        defaultStrokes(input),
        [],
        nodes,
      );
      expect(circuitHasMergedExternalLandings(selected)).toBe(false);
      expect(conservesOriginalPhysicalEndpoints(selected, input)).toBe(true);
      expect(run.qualityAttempts).toBe(1);
    }
  },
);

it("rejects label loss and native physical endpoint mutation against originalInput", async () => {
  const input = fanoutGraph(2, false);
  const strokes = defaultStrokes(input);
  const original = await createElkEngine().layout(structuredClone(input));
  const splitInput = required(
    externalCircuitLandingInput(input, original, undefined, strokes),
  );
  const candidate = await createElkEngine().layout(structuredClone(splitInput));
  expect(
    admitExternalLandingCandidate(
      candidate,
      splitInput,
      input,
      original,
      undefined,
      strokes,
      [],
    ),
  ).toBe(true);

  const labelDropped = structuredClone(candidate);
  required(labelDropped.edges?.[0]).labels = [];
  expect(
    admitExternalLandingCandidate(
      labelDropped,
      splitInput,
      input,
      original,
      undefined,
      strokes,
      [],
    ),
  ).toBe(false);

  const forgedSplit = structuredClone(splitInput);
  const forgedCand = structuredClone(candidate);
  const extraPort = port("q-forged", 0, 12, "WEST");
  required(forgedSplit.children?.[1]).ports = [
    ...(forgedSplit.children?.[1]?.ports ?? []),
    extraPort,
  ];
  required(forgedSplit.edges?.[0]).targets = ["q-forged"];
  const candDest = required(forgedCand.children?.[1]);
  candDest.ports = [...(candDest.ports ?? []), extraPort];
  const candEdge = required(forgedCand.edges?.[0]);
  candEdge.targets = ["q-forged"];
  required(candEdge.sections?.[0]).endPoint = {
    x: required(candDest.x),
    y: required(candDest.y) + 12,
  };
  expect(conservesOriginalPhysicalEndpoints(forgedCand, input)).toBe(false);
  expect(
    admitExternalLandingCandidate(
      forgedCand,
      forgedSplit,
      input,
      original,
      undefined,
      strokes,
      [],
    ),
  ).toBe(false);
});

it("rejects split candidates whose final recess extension fails clearance", async () => {
  const input = fanoutGraph(2, false);
  const strokes = defaultStrokes(input);
  const blockedNodes = [
    stubNode("n0", "p0", "blocked"),
    stubNode("n1", "q0", "dest"),
    stubNode("n2", "q1", "dest"),
  ];
  const run = circuitLayoutRun();
  const base = await layoutCircuitGroup(input, run, strokes, [], blockedNodes);
  run.quality = true;
  const selected = await layoutCircuitGroup(
    input,
    run,
    strokes,
    [],
    blockedNodes,
  );
  expect(selected).toEqual(base);
});

it("rejects per-site worsening (new merge, false junction, or disconnection) despite aggregate improvement", () => {
  const input = perSiteInput();
  const strokes = defaultStrokes(input);
  const base = perSiteBase(input);
  expect(
    perSiteLandingNonRegression(
      perSiteFixedA(base),
      base,
      input,
      undefined,
      strokes,
    ),
  ).toBe(true);

  const newMergeB = perSiteFixedA(base);
  const bHead = required(newMergeB.edges).slice(0, 3);
  newMergeB.edges = [
    ...bHead,
    routeEdge("e3", "pB", "t3", [
      [20, 80],
      [40, 80],
      [40, 70],
      [80, 70],
    ]),
    routeEdge("e4", "pB", "t4", [
      [20, 80],
      [40, 80],
      [40, 90],
      [80, 90],
    ]),
  ];
  expect(
    perSiteLandingNonRegression(newMergeB, base, input, undefined, strokes),
  ).toBe(false);

  const newJunctionB = perSiteFixedA(base);
  newJunctionB.edges = [
    ...bHead,
    routeEdge("e3", "pB", "t3", [
      [20, 80],
      [20, 70],
      [80, 70],
    ]),
    routeEdge("e4", "pB", "t4", [
      [20, 80],
      [50, 80],
      [50, 70],
      [50, 90],
      [80, 90],
    ]),
  ];
  expect(
    perSiteLandingNonRegression(newJunctionB, base, input, undefined, strokes),
  ).toBe(false);

  const disconnectedB = perSiteFixedA(base);
  required(required(disconnectedB.edges?.[3]).sections?.[0]).startPoint = {
    x: 25,
    y: 80,
  };
  expect(
    perSiteLandingNonRegression(disconnectedB, base, input, undefined, strokes),
  ).toBe(false);
});

it("rejects feedback-edge DQ-15 detours and splits reverse-model fanout", async () => {
  const input = fanoutGraph(2, false);
  const strokes = defaultStrokes(input);
  const original = await createElkEngine().layout(structuredClone(input));
  const splitInput = required(
    externalCircuitLandingInput(input, original, undefined, strokes),
  );
  const detoured = await createElkEngine().layout(structuredClone(splitInput));
  const sec = required(required(detoured.edges?.[0]).sections?.[0]);
  sec.bendPoints = [
    { x: sec.startPoint.x + 5, y: sec.startPoint.y },
    { x: sec.startPoint.x + 5, y: sec.startPoint.y - 80 },
    { x: sec.endPoint.x - 5, y: sec.startPoint.y - 80 },
    { x: sec.endPoint.x - 5, y: sec.endPoint.y },
  ];
  expect(
    admitExternalLandingCandidate(
      detoured,
      splitInput,
      input,
      original,
      undefined,
      strokes,
      [],
    ),
  ).toBe(false);

  const revInput = fanoutGraph(3, false, true);
  const revRun = circuitLayoutRun();
  await layoutCircuitGroup(revInput, revRun, defaultStrokes(revInput));
  revRun.quality = true;
  const revSelected = await layoutCircuitGroup(
    revInput,
    revRun,
    defaultStrokes(revInput),
  );
  expect(circuitHasMergedExternalLandings(revSelected)).toBe(false);
});

it("guards K2,2 shared destinations without regression", async () => {
  const k22: ElkNode = {
    id: "k22",
    layoutOptions: { ...BASE_OPTS, "elk.direction": "RIGHT" },
    children: [
      {
        id: "src",
        width: 24,
        height: 40,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [port("s0", 24, 12, "EAST"), port("s1", 24, 28, "EAST")],
      },
      {
        id: "d0",
        width: 24,
        height: 24,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [port("t0", 0, 6, "WEST"), port("t1", 0, 18, "WEST")],
      },
      {
        id: "d1",
        width: 24,
        height: 24,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [port("t2", 0, 6, "WEST"), port("t3", 0, 18, "WEST")],
      },
    ],
    edges: [
      edge("e0", "s0", "t0", "W-24V-1"),
      edge("e1", "s1", "t1", "W-0V-1"),
      edge("e2", "s0", "t2", "W-24V-2"),
      edge("e3", "s1", "t3", "W-0V-2"),
    ],
  };
  const k22Run = circuitLayoutRun();
  const k22Base = await layoutCircuitGroup(k22, k22Run, defaultStrokes(k22));
  k22Run.quality = true;
  const k22After = await layoutCircuitGroup(k22, k22Run, defaultStrokes(k22));
  expect(conservesOriginalPhysicalEndpoints(k22After, k22)).toBe(true);
  expect(k22After.edges?.length).toBe(k22Base.edges?.length);
});

it("obeys 48-placement ceiling, 4-attempt quality budget, and exhausted ELK work", async () => {
  const input = fanoutGraph(2, false);
  const strokes = defaultStrokes(input);
  for (const limit of ["placement", "economy"] as const) {
    const run = circuitLayoutRun();
    const base = await layoutCircuitGroup(input, run, strokes);
    run.quality = true;
    if (limit === "placement") run.attempts = 48;
    else run.qualityAttempts = 4;
    expect(await layoutCircuitGroup(input, run, strokes)).toEqual(base);
    expect(run.attempts).toBe(limit === "placement" ? 48 : 1);
  }
  const exhaustedRun = circuitLayoutRun();
  const base = await layoutCircuitGroup(input, exhaustedRun, strokes);
  exhaustedRun.quality = true;
  const ledger = elkWorkLedger("exhausted", 0);
  const fallback = await elkWorkScope.run(ledger, () =>
    layoutCircuitGroup(input, exhaustedRun, strokes),
  );
  expect(fallback).toEqual(base);
});

it("shares the 48/4 budget across combined external-landing split and inline-jog repair", async () => {
  const combined: ElkNode = {
    id: "combined",
    layoutOptions: {
      ...BASE_OPTS,
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "7",
    },
    children: [
      {
        id: "n0",
        width: 30,
        height: 40,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [
          port("a0", 30, 8, "EAST"),
          port("a1", 30, 15, "EAST"),
          port("a2", 30, 22, "EAST"),
          port("a3", 30, 32, "EAST"),
        ],
      },
      {
        id: "n1",
        width: 30,
        height: 40,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: [
          port("b0", 0, 8, "WEST"),
          port("b1", 0, 15, "WEST"),
          port("b2", 0, 22, "WEST"),
          port("b3", 0, 30, "WEST"),
          port("b4", 0, 36, "WEST"),
        ],
      },
    ],
    edges: [
      edge("e0", "a0", "b0", "W0"),
      edge("e1", "a1", "b1", "W1"),
      edge("e2", "a2", "b2", "W2"),
      edge("e3", "a3", "b3", "W3"),
      edge("e4", "a3", "b4", "W4"),
    ],
  };
  const combRun = circuitLayoutRun();
  await layoutCircuitGroup(combined, combRun, defaultStrokes(combined));
  combRun.quality = true;
  combRun.qualityAttempts = 3;
  await layoutCircuitGroup(combined, combRun, defaultStrokes(combined));
  expect(combRun.qualityAttempts).toBeLessThanOrEqual(4);
  expect(combRun.attempts).toBeLessThanOrEqual(48);
});

const FANOUT_TYPES = {
  types: [
    {
      kind: "device_type",
      id: "fanout-lib:supply",
      symbol: "thermite:dc-supply",
      terminals: {
        "+": { connection_policy: "shared" },
        "-": { connection_policy: "shared" },
      },
      functions: { output: { kind: "source", terminals: ["+", "-"] } },
    },
    {
      kind: "device_type",
      id: "fanout-lib:lamp",
      symbol: "thermite:lamp",
      terminals: {
        "1": { connection_policy: "shared" },
        "2": { connection_policy: "shared" },
      },
      functions: { light: { kind: "load", terminals: ["1", "2"] } },
    },
  ],
};

const FANOUT_OBJECTS = [
  {
    kind: "device",
    uid: "00000000-0000-4000-8000-000000000001",
    designation: "PS1",
    type: "fanout-lib:supply",
  },
  {
    kind: "device",
    uid: "00000000-0000-4000-8000-000000000002",
    designation: "H1",
    type: "fanout-lib:lamp",
  },
  {
    kind: "device",
    uid: "00000000-0000-4000-8000-000000000003",
    designation: "H2",
    type: "fanout-lib:lamp",
  },
  {
    kind: "wire",
    uid: "00000000-0000-4000-8000-000000000011",
    designation: "W1",
    endpoints: [
      { device: "PS1", terminal: "+" },
      { device: "H1", terminal: "1" },
    ],
  },
  {
    kind: "wire",
    uid: "00000000-0000-4000-8000-000000000012",
    designation: "W2",
    endpoints: [
      { device: "PS1", terminal: "+" },
      { device: "H2", terminal: "1" },
    ],
  },
];

async function buildMinimalFanoutIr(dir: string) {
  const write = (rel: string, value: unknown) =>
    writeFile(join(dir, rel), JSON.stringify(value));
  await mkdir(join(dir, "library"));
  await write("system.json", {
    format: "electrical-system/0.1",
    project: { name: "Fanout Fallback" },
    sources: ["source.json"],
    libraries: [{ name: "fanout-lib", version: "0.1.0", path: "library" }],
  });
  await write("library/library.json", {
    name: "fanout-lib",
    version: "0.1.0",
    sources: ["types.json"],
  });
  await write("library/types.json", FANOUT_TYPES);
  await write("source.json", { objects: FANOUT_OBJECTS });
  const lock = await lockProject(dir);
  if (!lock.ok) throw Error(JSON.stringify(lock.diagnostics));
  const compiled = await compileProject(dir);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  return compiled.ir;
}

it("falls back cleanly to baseline in standalone renderSchematicSheets when split grows composition", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thermite-circland-"));
  try {
    const ir = await buildMinimalFanoutIr(dir);
    const view: CircuitViewRequest = {
      format: "circuit-view-request/0.1",
      title: "Fanout",
      groups: [
        {
          id: "g1",
          label: "Supply",
          conductors: ["W1", "W2"],
          functions: [
            { device: { by: "designation", value: "PS1" }, key: "output" },
            { device: { by: "designation", value: "H1" }, key: "light" },
            { device: { by: "designation", value: "H2" }, key: "light" },
          ],
        },
      ],
    };
    const traces: NonNullable<Parameters<typeof circuitInlineTrace.run>[0]> =
      [];
    const okResult = await circuitInlineTrace.run(traces, () =>
      renderSchematicSheets(ir, view),
    );
    if (!okResult.ok) throw Error(JSON.stringify(okResult.error));
    expect(okResult.value.sheets.length).toBe(1);
    expect(okResult.value.sheets[0]?.svg).toContain(
      "data-circuit-landing-for=",
    );
    expect(traces[0]?.viewDecisions[0]?.reason).toBe("accepted");

    const realCreate = engine.createElkEngine;
    vi.spyOn(engine, "createElkEngine").mockImplementation(() => {
      const elk = realCreate();
      const realLayout = elk.layout.bind(elk);
      elk.layout = async (inp, opts) => {
        const out = await realLayout(inp, opts);
        const hasSplit = (inp.edges ?? []).some((e) =>
          [...e.sources, ...e.targets].some((p) =>
            p.includes("-circuit-landing-"),
          ),
        );
        if (hasSplit) out.height = 500;
        return out;
      };
      return elk;
    });
    const fallbackTraces: NonNullable<
      Parameters<typeof circuitInlineTrace.run>[0]
    > = [];
    const fallback = await circuitInlineTrace.run(fallbackTraces, () =>
      renderSchematicSheets(ir, view),
    );
    if (!fallback.ok) throw Error(JSON.stringify(fallback.error));
    expect(fallback.value.sheets.length).toBe(1);
    expect(fallback.value.sheets[0]?.svg).not.toContain(
      "data-circuit-landing-for=",
    );
    expect(fallbackTraces[0]?.viewDecisions[0]?.reason).toBe("composition fit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
