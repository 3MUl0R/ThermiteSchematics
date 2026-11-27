import { expect, it } from "vitest";
import { m3Delivery } from "./m3-delivery.mjs";
import { nativeNeeds, nativeRows } from "./m3-native.mjs";
import { legacyDependencyFindings } from "./document-dependencies.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { binding, fixture, ink, point } from "./m3-fixture.mjs";

const term = (deviceUid, terminalKey) => ({ deviceUid, terminalKey });
const endPair = (a, b) => [{ terminal: a }, { terminal: b }];

const wiringCableIr = () => ({
  devices: [
    { uid: "pt1", designation: "PT1" },
    { uid: "tb1", designation: "TB1" },
    { uid: "plc1", designation: "PLC1" },
  ],
  terminals: [
    term("pt1", "+"),
    term("pt1", "-"),
    term("tb1", "1"),
    term("tb1", "2"),
    term("plc1", "AI0+"),
    term("plc1", "AI0-"),
  ].map((id) => ({ id })),
  wires: [
    {
      uid: "w130",
      designation: "W130",
      endpoints: endPair(term("plc1", "AI0+"), term("tb1", "1")),
    },
    {
      uid: "w131",
      designation: "W131",
      endpoints: endPair(term("plc1", "AI0-"), term("tb1", "2")),
    },
  ],
  jumpers: [],
  cables: [
    {
      uid: "cbl1",
      designation: "CBL1",
      typeId: "t-cable",
      assignments: [
        { id: "1+", endpoints: endPair(term("pt1", "+"), term("tb1", "1")) },
        { id: "1-", endpoints: endPair(term("pt1", "-"), term("tb1", "2")) },
        { id: "2+", usage: "spare", endpoints: [null, null] },
        { id: "2-", usage: "spare", endpoints: [null, null] },
      ],
    },
  ],
  cableConductors: ["1+", "1-"].map((conductorId, i) => ({
    id: { cableUid: "cbl1", conductorId },
    cableUid: "cbl1",
    endpoints: endPair(term("pt1", i ? "-" : "+"), term("tb1", i ? "2" : "1")),
  })),
  cableTypes: [
    {
      id: "t-cable",
      conductors: [{ id: "1+" }, { id: "1-" }, { id: "2+" }, { id: "2-" }],
    },
  ],
});

const paintedConductor = (wire, extra = {}) => ({
  conductor: true,
  wire,
  painted: true,
  reviewPainted: true,
  nativeBodyPainted: true,
  ...extra,
});

const wiringSheetContext = () => {
  const ir = wiringCableIr();
  const sheet = {
    number: 1,
    view: { kind: "wiring", title: "PT1 analog wiring" },
  };
  const request = {
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "PT1 analog wiring",
        conductors: ["CBL1/1+", "CBL1/1-", "W130", "W131"],
      },
    ],
  };
  const g = {
    navigationViews: ["native-view"],
    devices: [
      { deviceUid: "pt1" },
      { deviceUid: "tb1" },
      { deviceUid: "plc1" },
    ],
    terminals: [
      { deviceUid: "pt1", terminal: "+" },
      { deviceUid: "pt1", terminal: "-" },
      { deviceUid: "tb1", terminal: "1" },
      { deviceUid: "tb1", terminal: "2" },
      { deviceUid: "plc1", terminal: "AI0+" },
      { deviceUid: "plc1", terminal: "AI0-" },
    ],
    shapes: [
      paintedConductor("w130"),
      paintedConductor("w131"),
      paintedConductor(JSON.stringify({ cableUid: "cbl1", conductorId: "1+" })),
      paintedConductor(JSON.stringify({ cableUid: "cbl1", conductorId: "1-" })),
    ],
  };
  return { ir, sheet, request, g };
};

const signalLoopContext = () => {
  const ir = {
    devices: [
      { uid: "tx1", designation: "TX1" },
      { uid: "tb1", designation: "TB1" },
      { uid: "plc1", designation: "PLC1" },
    ],
    wires: [],
    jumpers: [],
    cables: [
      {
        uid: "cbl3",
        designation: "CBL3",
        typeId: "t-1pair",
        assignments: [
          { id: "1+", endpoints: endPair(term("tx1", "+"), term("tb1", "5")) },
          { id: "1-", endpoints: endPair(term("tx1", "-"), term("tb1", "6")) },
        ],
      },
    ],
    cableConductors: ["1+", "1-"].map((conductorId, i) => ({
      id: { cableUid: "cbl3", conductorId },
      cableUid: "cbl3",
      endpoints: endPair(
        term("tx1", i ? "-" : "+"),
        term("tb1", i ? "6" : "5"),
      ),
    })),
    cableTypes: [{ id: "t-1pair", conductors: [{ id: "1+" }, { id: "1-" }] }],
    relations: [],
  };
  const sheet = {
    number: 29,
    view: { kind: "signal-loop", title: "TX1 - signal loop" },
  };
  const directReq = {
    views: [
      {
        format: "signal-loop-view-request/0.1",
        from: { device: "TX1", function: "signal" },
        to: { device: "PLC1", function: "ai0" },
      },
    ],
  };
  const drawnAll = {
    navigationViews: ["native-view"],
    devices: [
      { deviceUid: "tx1" },
      { deviceUid: "tb1" },
      { deviceUid: "plc1" },
    ],
    terminals: [],
    shapes: ["1+", "1-"].map((conductorId) => {
      const id = JSON.stringify({ cableUid: "cbl3", conductorId });
      return paintedConductor(id, { loopConductor: id });
    }),
    collapsedCableAssemblies: [],
  };
  return { ir, sheet, directReq, drawnAll };
};

const emptyPacket = (sheet) => {
  const base = fixture();
  base.packet.sheets = [sheet];
  base.packet.navigation = {
    documentFormat: "issued-documents/1",
    documents: [],
    dependencies: [],
    autoDocuments: [],
  };
  return base.packet;
};

it("protocol 5.53 retains 5.49 summary readability", () => {
  expect(EVALS_VERSION).toBe("5.53");
  const sample = { evalsVersion: "5.49", summary: { "DQ-19": { pass: 1 } } };
  expect(readReportSummary(sample)).toEqual(sample.summary);
});

it("V5-04 wiring: recognizes drawn cable conductors encoded as object JSON and still flags hidden cores", () => {
  const { ir, sheet, request, g } = wiringSheetContext();
  const needs = nativeNeeds(sheet, g, ir, nativeRows(ir), request);
  expect(needs.filter((n) => n.need === "conductor-incidence")).toEqual([]);

  const hiddenNeeds = nativeNeeds(
    sheet,
    { ...g, shapes: g.shapes.slice(0, 3) },
    ir,
    nativeRows(ir),
    request,
  ).filter((n) => n.need === "conductor-incidence");
  expect(hiddenNeeds.map((n) => n.noteId).sort()).toEqual([
    'wiring-incidence/["pt1","-"]',
    'wiring-incidence/["tb1","2"]',
  ]);

  const irExtra = structuredClone(ir);
  irExtra.wires.push({
    uid: "w-extra",
    designation: "W-EXTRA",
    endpoints: endPair(term("pt1", "+"), term("plc1", "AI0+")),
  });
  const extraNeeds = nativeNeeds(
    sheet,
    g,
    irExtra,
    nativeRows(irExtra),
    request,
  ).filter((n) => n.need === "conductor-incidence");
  expect(extraNeeds.map((n) => n.noteId).sort()).toEqual([
    'wiring-incidence/["plc1","AI0+"]',
    'wiring-incidence/["pt1","+"]',
  ]);

  const legacy = legacyDependencyFindings(
    sheet,
    { sheets: [sheet] },
    { ...g, texts: [ink("see wire schedule")] },
    [{ ...g, texts: [ink("see wire schedule")] }],
    ir,
    null,
  );
  expect(legacy.findings).toEqual([]);
});

it("V5-04 wiring: flags orphan [+N] legend note when zero conductor-incidence needs exist and passes without it", () => {
  const { ir, sheet, request, g } = wiringSheetContext();
  const packet = emptyPacket(sheet);
  const gOrphan = {
    ...g,
    texts: [
      ink(
        "Terminal wiring: device internals are not shown. [ +N ] = other physical connections at that terminal.",
        {
          element: "text-69",
          bbox: { x: 28, y: 129, w: 116, h: 2.5 },
          anchor: point(28, 131.5),
        },
      ),
    ],
  };
  const bad = m3Delivery(sheet, packet, gOrphan, [gOrphan], ir, request, {
    binding,
    tables: [],
  });
  expect(bad.findings.map((f) => f.kind)).toEqual([
    "document-visible-caption-without-native-need",
  ]);
  expect(bad.findings[0].need).toBe("conductor-incidence");

  const gClean = {
    ...g,
    texts: [
      ink("Terminal wiring: device internals are not shown.", {
        element: "text-69",
        bbox: { x: 28, y: 129, w: 62, h: 2.5 },
        anchor: point(28, 131.5),
      }),
    ],
  };
  const ok = m3Delivery(sheet, packet, gClean, [gClean], ir, request, {
    binding,
    tables: [],
  });
  expect([...ok.findings, ...ok.targetFindings]).toEqual([]);
});

it("V5-04 signal-loop: omits core-inventory when all cable cores are individually drawn", () => {
  const { ir, sheet, directReq, drawnAll } = signalLoopContext();
  const seriesReq = {
    views: [
      {
        ...directReq.views[0],
        loopPower: { device: "PS1", function: "dc_output" },
      },
    ],
  };
  expect(nativeNeeds(sheet, drawnAll, ir, nativeRows(ir), directReq)).toEqual(
    [],
  );
  expect(nativeNeeds(sheet, drawnAll, ir, nativeRows(ir), seriesReq)).toEqual(
    [],
  );
});

it("V5-04 signal-loop: still requires core-inventory for collapsed assemblies or omitted cores", () => {
  const { ir, sheet, directReq, drawnAll } = signalLoopContext();
  const asmReq = {
    views: [
      {
        ...directReq.views[0],
        cableAssemblies: [
          { cable: "CBL3", connector: "M12", description: "Cordset" },
        ],
      },
    ],
  };
  expect(
    nativeNeeds(
      sheet,
      { ...drawnAll, shapes: [], collapsedCableAssemblies: [] },
      ir,
      nativeRows(ir),
      asmReq,
    ).map((n) => [n.need, n.noteId, n.facts.length]),
  ).toEqual([["core-inventory", "loop-core-details", 2]]);
  expect(
    nativeNeeds(
      sheet,
      {
        ...drawnAll,
        shapes: [],
        collapsedCableAssemblies: [{ cableUid: "cbl3" }],
      },
      ir,
      nativeRows(ir),
      undefined,
    ).map((n) => [n.need, n.noteId, n.facts.length]),
  ).toEqual([["core-inventory", "loop-core-details", 2]]);
  expect(
    nativeNeeds(
      sheet,
      { ...drawnAll, shapes: [drawnAll.shapes[0]] },
      ir,
      nativeRows(ir),
      directReq,
    ).map((n) => [n.need, n.noteId, n.facts.length]),
  ).toEqual([["core-inventory", "loop-core-details", 2]]);
});

it("V5-04 signal-loop: rejects orphan core-details note when zero core-inventory needs exist", () => {
  const { ir, sheet, directReq, drawnAll } = signalLoopContext();
  const packet = emptyPacket(sheet);
  const orphanG = {
    ...drawnAll,
    texts: [
      ink(
        "Heavy line = cable assembly, not a shared electrical net. Pin maps run from transmitter toward input; other core details are outside this view.",
        { element: "text-99" },
      ),
    ],
  };
  const orphanRes = m3Delivery(
    sheet,
    packet,
    orphanG,
    [orphanG],
    ir,
    directReq,
    { binding, tables: [] },
  );
  expect(orphanRes.findings.map((f) => f.kind)).toEqual([
    "document-visible-caption-without-native-need",
  ]);
  expect(orphanRes.findings[0].need).toBe("core-inventory");
});
