import { describe, expect, it } from "vitest";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { IrDevice, IrDeviceType } from "@thermite/compiler";
import { parseHTML } from "linkedom";
import { renderCircuitLayout } from "../src/circuit/layout-drawing.js";
import { circuitRouteState } from "../src/circuit/layout-routes.js";
import {
  CIRCUIT_LANDING_OFFSET,
  circuitLandingGeometry,
} from "../src/circuit/landing-ports.js";
import { emitCircuitNode } from "../src/circuit/node-emission.js";
import { planCircuitGraphInput } from "../src/circuit/layout-input.js";
import type {
  DeviceNode,
  PhysicalConductor,
  Pin,
  Point,
} from "../src/circuit/types.js";
import { drawingDeviceTag } from "../src/device-tag-svg.js";
import { InlineLabelCollisionError } from "../src/layout/inline-label-error.js";
import {
  attachmentStrokeWeights,
  terminalAttachmentStroke,
  UNSELECTED_ATTACHMENT_STROKE_MM,
} from "../src/symbols/attachment-stroke.js";
import { circuitPacketCards } from "../src/layout/circuit-packet-cards.js";
import type { RenderedPacket } from "../src/packet/types.js";
import { escapeXmlAttribute as attr } from "../src/svg/escape.js";

const stubDevice = (uid: string): IrDevice => ({
  uid,
  designation: uid,
  typeId: "t",
  description: "Supply",
  properties: {},
  source: { file: "test.json", jsonPointer: `/objects/${uid}` },
});

const stubType = (): IrDeviceType => ({
  id: "t",
  kind: "device",
  description: "Supply",
  symbol: "thermite:power-supply",
  terminals: {},
  functions: {},
  source: { file: "types.json", jsonPointer: "/types/t" },
});

function baseDeviceNode(
  id: string,
  uid: string,
  pins: Pin[],
  width: number,
  height: number,
  rank: number,
): DeviceNode {
  return {
    id,
    device: stubDevice(uid),
    type: stubType(),
    functions: [],
    pins,
    rows: [],
    boundary: true,
    width,
    height,
    rank,
    pitch: 7,
    verticalOffsetX: 0,
    verticalScaleX: 1,
    relationLabels: [],
    tagColumnCaptions: [],
    sourceTerminalKeys: [],
    relations: [],
    gangs: [],
  };
}

function makeTaggedDevice(opts?: {
  bodyHeight?: number;
  tagCaptions?: string[];
  extraPinY?: number;
  pinY?: number;
}): DeviceNode {
  const bodyW = 24,
    bodyH = opts?.bodyHeight ?? 14,
    outerW = 42,
    pinY = opts?.pinY ?? 7;
  const plan = drawingDeviceTag(stubDevice("PS1"), stubType(), outerW, 1);
  const bodyY = plan.heightMm + 2;
  const bodyPins: Pin[] = [
    {
      id: "n0p0",
      terminal: { deviceUid: "PS1", terminalKey: "+" },
      x: bodyW,
      y: pinY,
      side: "EAST",
      label: "+",
      outside: 0,
    },
    ...(opts?.extraPinY !== undefined
      ? [
          {
            id: "n0p1",
            terminal: { deviceUid: "PS1", terminalKey: "-" },
            x: bodyW,
            y: opts.extraPinY,
            side: "EAST" as const,
            label: "-",
            outside: 0,
          },
        ]
      : []),
  ];
  const body = baseDeviceNode("n0", "PS1", bodyPins, bodyW, bodyH, 0);
  return {
    ...body,
    width: outerW,
    height: bodyY + bodyH,
    tagColumnCaptions: opts?.tagCaptions ?? [],
    pins: bodyPins.map((p) => ({ ...p, x: outerW, y: p.y + bodyY })),
    tagLane: {
      body,
      plan,
      geometry: {
        width: outerW,
        height: bodyY + bodyH,
        tagX: 0,
        tagY: 0,
        bodyX: 0,
        bodyY,
      },
    },
  };
}

function makeSimpleTarget(id: string, uid: string, key: string): DeviceNode {
  return baseDeviceNode(
    id,
    uid,
    [
      {
        id: `${id}p0`,
        terminal: { deviceUid: uid, terminalKey: key },
        x: 0,
        y: 5,
        side: "WEST",
        label: key,
        outside: 0,
      },
    ],
    12,
    10,
    1,
  );
}

type EdgeSpec = {
  id: string;
  srcPort: string;
  tgtPort: string;
  pts: Point[];
  ends: [
    { deviceUid: string; terminalKey: string },
    { deviceUid: string; terminalKey: string },
  ];
  jumper?: boolean;
};

const eastWire = (
  id: string,
  srcPort: string,
  tgtPort: string,
  ySrc: number,
  yTgt: number,
  toDev: string,
  turnX = 60,
  fromKey = "+",
): EdgeSpec => ({
  id,
  srcPort,
  tgtPort,
  pts: [
    { x: 52, y: ySrc },
    { x: turnX, y: ySrc },
    { x: turnX, y: yTgt },
    { x: 80, y: yTgt },
  ],
  ends: [
    { deviceUid: "PS1", terminalKey: fromKey },
    { deviceUid: toDev, terminalKey: "1" },
  ],
});

function makeHooks() {
  const fmt = (v: number) => Number(v.toFixed(3)).toString();
  const key = (t: { deviceUid: string; terminalKey: string }) =>
    JSON.stringify([t.deviceUid, t.terminalKey]);
  const hooks = {
    key,
    fkey: (f: { id: { functionKey: string } }) => f.id.functionKey,
    compare: (a: string, b: string) => a.localeCompare(b),
    n: fmt,
    text: () => "",
    conductorLabelLines: (c: PhysicalConductor) => [c.label],
    circuitDeviceTags: () => [],
    emitNode: (
      node: DeviceNode,
      x: number,
      y: number,
      vertical: boolean,
      conductors: PhysicalConductor[],
      diagnostics: never[],
      omitDesignation = false,
      attachmentWeights?: ReadonlyMap<string, number>,
      splitLandingPorts?: ReadonlySet<string>,
      suppressedStemPorts?: ReadonlySet<string>,
    ): string =>
      emitCircuitNode(
        {
          node,
          x,
          y,
          vertical,
          conductors,
          diagnostics,
          omitDesignation,
          attachmentWeights,
          splitLandingPorts,
          suppressedStemPorts,
        },
        {
          key,
          fkey: (f) => f.id.functionKey,
          n: fmt,
          text: () => "",
          emitNode: hooks.emitNode,
          pinLabel: (p) => p.label,
          oneSidedFunction: () => false,
          channelLabelLines: () => [],
          circuitNodeAttributes: (d) => ` data-device-uid="${d.device.uid}"`,
          mechanicalGangs: () => [],
        },
      ),
  };
  return hooks;
}

function runTaggedLayout(
  ps1: DeviceNode,
  targets: DeviceNode[],
  edgeSpecs: EdgeSpec[],
) {
  const nodes = [ps1, ...targets];
  const children: ElkNode[] = [
    {
      id: ps1.id,
      x: 10,
      y: 20,
      width: ps1.width,
      height: ps1.height,
      ports: [
        ...ps1.pins.map((p) => ({ id: p.id, x: p.x, y: p.y })),
        ...edgeSpecs
          .flatMap((e) => [e.srcPort, e.tgtPort])
          .filter((p) => p.includes("-circuit-landing-"))
          .map((id) => {
            const g = circuitLandingGeometry(id, nodes);
            return { id, x: g.outerRoutePort.x, y: g.outerRoutePort.y };
          }),
      ],
    },
    ...targets.map((t, i) => ({
      id: t.id,
      x: 80,
      y: 10 + i * 25,
      width: t.width,
      height: t.height,
      ports: t.pins.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    })),
  ];
  const cs: PhysicalConductor[] = edgeSpecs.map((e) => ({
    id: e.id,
    name: e.id,
    label: e.id,
    ends: e.ends,
    netId: "net",
    detail: "",
    jumper: Boolean(e.jumper),
  }));
  const edges: ElkExtendedEdge[] = edgeSpecs.map((e, i) => {
    const startPoint = e.pts[0],
      endPoint = e.pts.at(-1);
    if (!startPoint || !endPoint) throw new Error("Invalid edge spec");
    return {
      id: `e${i}`,
      sources: [e.srcPort],
      targets: [e.tgtPort],
      sections: [
        { id: `s${i}`, startPoint, endPoint, bendPoints: e.pts.slice(1, -1) },
      ],
    };
  });
  const graph: ElkNode = { id: "g", width: 120, height: 120, children, edges };
  const state = circuitRouteState(
    graph,
    nodes,
    cs,
    { id: "phys-test" },
    makeHooks(),
  );
  return renderCircuitLayout(state, [], new Map(), new Set(), false);
}

describe("circuit physical landing geometry (#630)", () => {
  it("exposes explicit physicalMarkerCentre, offsetPaintedLanding, and outerRoutePort coordinates", () => {
    const ps1 = makeTaggedDevice();
    const bodyY = ps1.tagLane?.geometry.bodyY ?? 0;
    const geom = circuitLandingGeometry("n0p0-circuit-landing-positive", [ps1]);
    expect(geom.physicalMarkerCentre).toEqual({ x: 24, y: bodyY + 7 });
    expect(geom.offsetPaintedLanding).toEqual({
      x: 24,
      y: bodyY + 7 + CIRCUIT_LANDING_OFFSET,
    });
    expect(geom.outerRoutePort).toEqual({
      x: 42,
      y: bodyY + 7 + CIRCUIT_LANDING_OFFSET,
    });
    expect(geom.hasRecessExtension).toBe(true);
  });

  it("extends split incidences through an 18 mm recess, suppresses only the split stem, and preserves unsplit sibling stems", () => {
    const ps1 = makeTaggedDevice({ bodyHeight: 20, pinY: 6, extraPinY: 14 });
    const y0 = 20 + (ps1.tagLane?.geometry.bodyY ?? 0) + 6;
    const y1 = 20 + (ps1.tagLane?.geometry.bodyY ?? 0) + 14;
    const targets = [
      makeSimpleTarget("n1", "S1", "1"),
      makeSimpleTarget("n2", "S2", "1"),
      makeSimpleTarget("n3", "S3", "1"),
      makeSimpleTarget("n4", "S4", "1"),
    ];
    const drawing = runTaggedLayout(ps1, targets, [
      eastWire(
        "W1",
        "n0p0-circuit-landing-negative",
        "n1p0",
        y0 - 0.625,
        15,
        "S1",
      ),
      eastWire("W2", "n0p0", "n2p0", y0, 40, "S2", 64),
      eastWire(
        "W3",
        "n0p0-circuit-landing-positive",
        "n3p0",
        y0 + 0.625,
        65,
        "S3",
      ),
      eastWire("W4", "n0p1", "n4p0", y1, 90, "S4", 64, "-"),
    ]);
    const doc = parseHTML(drawing.content).document;
    expect(
      doc.querySelector('[data-layout-port="n0p0"][data-terminal-attachment]'),
    ).toBeNull();
    expect(
      doc.querySelector('[data-layout-port="n0p1"][data-terminal-attachment]'),
    ).not.toBeNull();
    for (const [id, y] of [
      ["W1", y0 - 0.625],
      ["W2", y0],
      ["W3", y0 + 0.625],
    ] as const) {
      const d = doc
        .querySelector(
          `[data-circuit-conductor="${id}"] path[stroke="#17212b"]`,
        )
        ?.getAttribute("d");
      expect(d?.startsWith(`M 34 ${Number(y.toFixed(3))} `)).toBe(true);
    }
    const w4d = doc
      .querySelector('[data-circuit-conductor="W4"] path[stroke="#17212b"]')
      ?.getAttribute("d");
    expect(w4d?.startsWith(`M 52 ${Number(y1.toFixed(3))} `)).toBe(true);
    const aliases = [...doc.querySelectorAll("[data-circuit-landing-for]")];
    expect(aliases).toHaveLength(2);
    for (const a of aliases) expect(Number(a.getAttribute("cx"))).toBe(34);
  });

  it("handles reversed endpoints (target end on the split tagged port)", () => {
    const ps1 = makeTaggedDevice({ bodyHeight: 14, pinY: 7 });
    const y0 = 20 + (ps1.tagLane?.geometry.bodyY ?? 0) + 7;
    const targets = [
      makeSimpleTarget("n1", "S1", "1"),
      makeSimpleTarget("n2", "S2", "1"),
    ];
    const drawing = runTaggedLayout(ps1, targets, [
      {
        id: "W1",
        srcPort: "n1p0",
        tgtPort: "n0p0-circuit-landing-negative",
        pts: [
          { x: 80, y: 15 },
          { x: 60, y: 15 },
          { x: 60, y: y0 - 0.625 },
          { x: 52, y: y0 - 0.625 },
        ],
        ends: [
          { deviceUid: "S1", terminalKey: "1" },
          { deviceUid: "PS1", terminalKey: "+" },
        ],
      },
      {
        id: "W2",
        srcPort: "n2p0",
        tgtPort: "n0p0-circuit-landing-positive",
        pts: [
          { x: 80, y: 40 },
          { x: 60, y: 40 },
          { x: 60, y: y0 + 0.625 },
          { x: 52, y: y0 + 0.625 },
        ],
        ends: [
          { deviceUid: "S2", terminalKey: "1" },
          { deviceUid: "PS1", terminalKey: "+" },
        ],
      },
    ]);
    const doc = parseHTML(drawing.content).document;
    const w1d = doc
      .querySelector('[data-circuit-conductor="W1"] path[stroke="#17212b"]')
      ?.getAttribute("d");
    expect(w1d?.endsWith(`L 34 ${Number((y0 - 0.625).toFixed(3))}`)).toBe(true);
  });

  it("rejects tangential ELK launch away from the face before extending", () => {
    const ps1 = makeTaggedDevice({ bodyHeight: 14, pinY: 7 });
    const y0 = 20 + (ps1.tagLane?.geometry.bodyY ?? 0) + 7;
    const targets = [
      makeSimpleTarget("n1", "S1", "1"),
      makeSimpleTarget("n2", "S2", "1"),
    ];
    expect(() =>
      runTaggedLayout(ps1, targets, [
        {
          id: "W1",
          srcPort: "n0p0-circuit-landing-negative",
          tgtPort: "n1p0",
          pts: [
            { x: 52, y: y0 - 0.625 },
            { x: 52, y: 15 },
            { x: 80, y: 15 },
          ],
          ends: [
            { deviceUid: "PS1", terminalKey: "+" },
            { deviceUid: "S1", terminalKey: "1" },
          ],
        },
        eastWire(
          "W2",
          "n0p0-circuit-landing-positive",
          "n2p0",
          y0 + 0.625,
          40,
          "S2",
        ),
      ]),
    ).toThrow(InlineLabelCollisionError);
  });

  it("rejects recess extension violating full-stroke body-edge or sibling-marker clearance", () => {
    const targets = [
      makeSimpleTarget("n1", "S1", "1"),
      makeSimpleTarget("n2", "S2", "1"),
    ];
    const nearEdge = makeTaggedDevice({ bodyHeight: 14, pinY: 0.7 });
    const yEdge = 20 + (nearEdge.tagLane?.geometry.bodyY ?? 0) + 0.7;
    expect(() =>
      runTaggedLayout(nearEdge, targets, [
        eastWire(
          "W1",
          "n0p0-circuit-landing-negative",
          "n1p0",
          yEdge - 0.625,
          15,
          "S1",
        ),
        eastWire(
          "W2",
          "n0p0-circuit-landing-positive",
          "n2p0",
          yEdge + 0.625,
          40,
          "S2",
        ),
      ]),
    ).toThrow(InlineLabelCollisionError);

    const closeSibling = makeTaggedDevice({
      bodyHeight: 14,
      pinY: 6,
      extraPinY: 7.5,
    });
    const ySib = 20 + (closeSibling.tagLane?.geometry.bodyY ?? 0) + 6;
    expect(() =>
      runTaggedLayout(closeSibling, targets, [
        eastWire(
          "W1",
          "n0p0-circuit-landing-negative",
          "n1p0",
          ySib - 0.625,
          15,
          "S1",
        ),
        eastWire(
          "W2",
          "n0p0-circuit-landing-positive",
          "n2p0",
          ySib + 0.625,
          40,
          "S2",
        ),
      ]),
    ).toThrow(InlineLabelCollisionError);
  });

  it("rejects recess extension encroaching on tag-column captions", () => {
    const ps1 = makeTaggedDevice({
      bodyHeight: 14,
      pinY: 1.5,
      tagCaptions: ["Extra note"],
    });
    const y0 = 20 + (ps1.tagLane?.geometry.bodyY ?? 0) + 1.5;
    const targets = [
      makeSimpleTarget("n1", "S1", "1"),
      makeSimpleTarget("n2", "S2", "1"),
    ];
    expect(() =>
      runTaggedLayout(ps1, targets, [
        eastWire(
          "W1",
          "n0p0-circuit-landing-negative",
          "n1p0",
          y0 - 0.625,
          15,
          "S1",
        ),
        eastWire(
          "W2",
          "n0p0-circuit-landing-positive",
          "n2p0",
          y0 + 0.625,
          40,
          "S2",
        ),
      ]),
    ).toThrow(InlineLabelCollisionError);
  });

  it("canonicalises attachment stroke weights to the physical port while preserving separate faces", () => {
    const weights = attachmentStrokeWeights(
      [
        {
          id: "e0",
          sources: ["n0p0-circuit-landing-negative"],
          targets: ["n1p0"],
        },
        {
          id: "e1",
          sources: ["n0p0-circuit-landing-positive"],
          targets: ["n2p0"],
        },
        { id: "e2", sources: ["n0p1"], targets: ["n3p0"] },
      ],
      [{ jumper: false }, { jumper: false }, { jumper: true }],
    );
    expect(terminalAttachmentStroke("n0p0", weights)).toBe(0.32);
    expect(terminalAttachmentStroke("n0p1", weights)).toBe(0.55);
    expect(terminalAttachmentStroke("n0p2", weights)).toBe(
      UNSELECTED_ATTACHMENT_STROKE_MM,
    );
  });

  it("explicitly excludes landing alias circles in circuit-packet-cards cardPins", () => {
    const cond = attr(JSON.stringify([{ kind: "wire", uid: "w1" }]));
    const term = attr(JSON.stringify({ deviceUid: "PS1", terminalKey: "+" }));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><g data-off-view-conductors="${cond}" data-off-view-terminal-id="${term}"><rect class="off-view-card" x="60" y="10" width="30" height="10" fill="white" stroke="#17212b" stroke-width="0.3"/></g><circle data-device-uid="PS1" data-terminal-key="+" cx="10" cy="10" r=".65" fill="white" stroke="#17212b"/><circle data-device-uid="PS1" data-terminal-key="+" data-circuit-landing-for="n0p0" cx="60" cy="10" r=".001" fill="none" stroke="none"/></svg>`;
    const pkt: RenderedPacket = {
      format: "schematic-packet/0.1",
      page: {
        size: "a4",
        orientation: "landscape",
        widthMm: 100,
        heightMm: 100,
      },
      sheets: [
        {
          number: 1,
          title: "t",
          view: { kind: "circuit", format: "circuit-view/0.1", title: "t" },
          svg,
          references: [],
          continuations: [],
        },
      ],
      diagnostics: [],
    };
    const cards = circuitPacketCards(pkt);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.distance).toBeGreaterThan(45);
  });

  it("keeps external landing splitting INACTIVE on the production planCircuitGraphInput path", () => {
    const port = (id: string, x: number, side: string) => ({
      id,
      x,
      y: 10,
      layoutOptions: { "elk.port.side": side },
    });
    const children: ElkNode[] = [
      { id: "n0", width: 20, height: 20, ports: [port("n0p0", 20, "EAST")] },
      { id: "n1", width: 20, height: 20, ports: [port("n1p0", 0, "WEST")] },
      { id: "n2", width: 20, height: 20, ports: [port("n2p0", 0, "WEST")] },
    ];
    const edges: ElkExtendedEdge[] = [
      { id: "e0", sources: ["n0p0"], targets: ["n1p0"] },
      { id: "e1", sources: ["n0p0"], targets: ["n2p0"] },
    ];
    const cond = (id: string, to: string): PhysicalConductor => ({
      id,
      name: id,
      label: id,
      ends: [
        { deviceUid: "A", terminalKey: "1" },
        { deviceUid: to, terminalKey: "1" },
      ],
      netId: "n",
      detail: "",
      jumper: false,
    });
    const planned = planCircuitGraphInput(children, edges, new Set(), false, [
      cond("W1", "B"),
      cond("W2", "C"),
    ]);
    expect(planned.splitPorts.size).toBe(0);
    expect(planned.graph.edges?.map((e) => e.sources[0])).toEqual([
      "n0p0",
      "n0p0",
    ]);
  });
});
