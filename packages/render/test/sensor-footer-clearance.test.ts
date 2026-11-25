import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, lockProject } from "@thermite/compiler";
import { parseHTML } from "linkedom";
import { renderSchematicPacket } from "../src/sheets.js";
import {
  CAPTION_CLEARANCE_MM,
  CaptionPlacementError,
  captionInk,
  inkGap,
  ownerCaption,
  strokeBoxes,
} from "../src/symbols/caption-ink.js";
import { reserveCircuitCaptions } from "../src/symbols/circuit-caption-reservation.js";
import {
  circuitInterfaceMark,
  interfaceOutlineRect,
} from "../src/symbols/circuit-interface.js";
import { nodeCaptionSegments } from "../src/symbols/circuit-node-ink.js";
import { emitCircuitNode } from "../src/circuit/node-emission.js";
import { rowInBodyTexts } from "../src/circuit/node-symbols.js";
import type { DeviceNode } from "../src/circuit/types.js";

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(
    temporary.map((p) => rm(p, { recursive: true, force: true })),
  );
});

async function splitSensorIr() {
  const root = await mkdtemp(join(tmpdir(), "thermite-sensor-footer-"));
  temporary.push(root);
  await writeFile(
    join(root, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: "Split sensor footer witness" },
      sources: ["source.json"],
      libraries: [{ name: "core", version: "0.1.0" }],
    }),
  );
  const device = (n: number, designation: string, type: string) => ({
    uid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "device",
    designation,
    type,
  });
  const wire = (n: number, from: string, to: string) => ({
    uid: `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`,
    kind: "wire",
    designation: `W${n}`,
    endpoints: [from, to].map((s) => {
      const i = s.indexOf(".");
      return { device: s.slice(0, i), terminal: s.slice(i + 1) };
    }),
  });
  await writeFile(
    join(root, "source.json"),
    JSON.stringify({
      objects: [
        device(1, "PS1", "core:psu-24vdc"),
        device(2, "B1", "core:prox-pnp-3wire"),
        device(3, "PLC1", "core:plc-compact"),
        wire(1, "PS1.+", "B1.1"),
        wire(2, "PS1.-", "B1.3"),
        wire(3, "B1.4", "PLC1.X1.0"),
      ],
    }),
  );
  expect((await lockProject(root)).ok).toBe(true);
  const compiled = await compileProject(root);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.ir;
}

function textBox(el: Element) {
  return captionInk(
    el.textContent ?? "",
    Number(el.getAttribute("x")),
    Number(el.getAttribute("y")),
    Number(el.getAttribute("font-size")),
    el.getAttribute("text-anchor") ?? "start",
    el.getAttribute("font-weight") === "700",
  );
}

function rectStrokeBoxes(rect: Element, strokeWidth = 0.35) {
  const x = Number(rect.getAttribute("x"));
  const y = Number(rect.getAttribute("y"));
  const w = Number(rect.getAttribute("width"));
  const h = Number(rect.getAttribute("height"));
  return strokeBoxes(
    [
      [
        { x, y },
        { x: x + w, y },
      ],
      [
        { x: x + w, y },
        { x: x + w, y: y + h },
      ],
      [
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      [
        { x, y: y + h },
        { x, y },
      ],
    ],
    strokeWidth,
  );
}

async function renderSplitSensor(flow: "left-to-right" | "top-to-bottom") {
  const ir = await splitSensorIr();
  const packet = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "circuit-view-request/0.1",
        title: "Split sensor",
        flow,
        groups: [
          {
            id: "sensor-supply",
            label: "Sensor supply",
            lineReference: "220",
            functions: [
              { device: { by: "designation", value: "B1" }, key: "supply" },
            ],
            conductors: ["W1", "W2"],
          },
          {
            id: "sensor-output",
            label: "Sensor output",
            lineReference: "221",
            functions: [
              { device: { by: "designation", value: "B1" }, key: "output" },
            ],
            conductors: ["W3"],
          },
        ],
      },
    ],
  });
  expect(packet.ok, JSON.stringify(packet)).toBe(true);
  if (!packet.ok) throw new Error(packet.error.message);
  return packet.value;
}

function tightCoilNode(): DeviceNode {
  const coilFn = {
    id: { deviceUid: "k1", functionKey: "coil" },
    kind: "coil" as const,
    terminals: [
      { deviceUid: "k1", terminalKey: "A1" },
      { deviceUid: "k1", terminalKey: "A2" },
    ],
    properties: {},
  };
  return {
    id: "n0",
    device: {
      uid: "k1",
      designation: "K1",
      typeId: "local:relay",
      source: { file: "test.json", pointer: "/objects/0" },
    },
    type: {
      id: "local:relay",
      description: "Control relay",
      terminals: [
        { key: "A1", rating: { voltage_type: "DC" } },
        { key: "A2", rating: { voltage_type: "DC" } },
      ],
      functions: [],
      internalRelations: [],
      source: { file: "test.json", pointer: "/types/0" },
    },
    functions: [coilFn],
    pins: [
      {
        id: "n0p0",
        terminal: coilFn.terminals[0]!,
        x: 0,
        y: 7,
        side: "WEST",
        label: "A1",
        outside: 0,
      },
      {
        id: "n0p1",
        terminal: coilFn.terminals[1]!,
        x: 26,
        y: 7,
        side: "EAST",
        label: "A2",
        outside: 0,
      },
    ],
    rows: [{ f: coilFn, mark: "coil", start: 0, slots: 1, center: 7 }],
    boundary: false,
    width: 26,
    height: 12,
    rank: 0,
    pitch: 7,
    verticalOffsetX: 0,
    verticalScaleX: 1,
    relationLabels: ["13–14: 200", "23–24: 201"],
    tagColumnCaptions: [],
    sourceTerminalKeys: [],
    relations: [],
    gangs: [],
  };
}

function emitMinimalNode(node: DeviceNode): string {
  return emitCircuitNode(
    {
      node,
      x: 0,
      y: 0,
      vertical: false,
      conductors: [],
      diagnostics: [],
      omitDesignation: false,
      attachmentWeights: undefined,
    },
    {
      key: (t) => `${t.deviceUid}:${t.terminalKey}`,
      fkey: (f) => `${f.id.deviceUid}:${f.id.functionKey}`,
      n: (v) => String(Number(v.toFixed(3))),
      text: (x, y, value, size = 2.5, anchor = "start", bold = false) =>
        `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" font-weight="${bold ? "700" : "400"}">${value}</text>`,
      emitNode: () => "",
      pinLabel: (p) => p.label,
      oneSidedFunction: () => false,
      channelLabelLines: () => [],
      circuitNodeAttributes: () => "",
      mechanicalGangs: () => [],
    },
  );
}

describe("B1 split-sensor footer clearance (#625)", () => {
  it("accepts exact-clearance footer candidates despite IEEE-754 ULP drift without weakening clearance", () => {
    const bounds = { left: 0.5, right: 25.5, top: 0.5, bottom: 27.6 };
    const bottomFrame = strokeBoxes(
      [
        [
          { x: 0, y: 28.1 },
          { x: 26, y: 28.1 },
        ],
      ],
      0.4,
    );
    const placed = ownerCaption(
      "4: 221",
      13,
      27.1,
      2.5,
      "middle",
      false,
      bounds,
      bottomFrame,
      [],
    );
    // Exact bottom-clearing shift lands near y=26.86 instead of jumping upward.
    expect(placed.y).toBeGreaterThan(26.5);
    expect(placed.y).toBeLessThan(27.0);
    expect(inkGap(placed.box, bottomFrame[0]!)).toBeGreaterThanOrEqual(
      CAPTION_CLEARANCE_MM,
    );
  });

  for (const flow of ["left-to-right", "top-to-bottom"] as const) {
    it(`keeps split 3-wire PNP sensor footers clear of OUT, PNP and the interface outline (${flow})`, async () => {
      const packet = await renderSplitSensor(flow);
      const bodies = packet.sheets.flatMap((sheet) => [
        ...parseHTML(sheet.svg).document.querySelectorAll(
          "g[data-circuit-functions]:not([data-circuit-tag-lane])",
        ),
      ]);
      const supplyBody = bodies.find((g) =>
        g.querySelector('[data-function-key="supply"]'),
      );
      const outputBody = bodies.find((g) =>
        g.querySelector('[data-function-key="output"]'),
      );
      expect(supplyBody).toBeTruthy();
      expect(outputBody).toBeTruthy();

      // Site 1A: B1 output footer ("1 / 3: 220") must clear "OUT" and the sensor mark.
      const outputTexts = [...outputBody!.querySelectorAll("text")];
      const outText = outputTexts.find((t) => t.textContent === "OUT");
      const outputFooter = outputTexts.find(
        (t) => t.textContent === "1 / 3: 220",
      );
      expect(outText).toBeTruthy();
      expect(outputFooter).toBeTruthy();
      expect(
        inkGap(textBox(outputFooter!), textBox(outText!)),
      ).toBeGreaterThanOrEqual(0.3);

      // Site 1B: B1 supply footer ("4: 221") must clear the interface <rect> outline and "PNP".
      const supplyTexts = [...supplyBody!.querySelectorAll("text")];
      const pnpText = supplyTexts.find((t) => t.textContent === "PNP");
      const supplyFooter = supplyTexts.find((t) => t.textContent === "4: 221");
      const interfaceRect = supplyBody!.querySelector(
        'g[data-function-interface="sensor-3wire"] > rect',
      );
      expect(pnpText).toBeTruthy();
      expect(supplyFooter).toBeTruthy();
      expect(interfaceRect).toBeTruthy();
      const footerBox = textBox(supplyFooter!);
      expect(inkGap(footerBox, textBox(pnpText!))).toBeGreaterThanOrEqual(0.3);
      for (const edge of rectStrokeBoxes(interfaceRect!, 0.35)) {
        expect(inkGap(footerBox, edge)).toBeGreaterThanOrEqual(
          CAPTION_CLEARANCE_MM,
        );
      }
    });
  }

  it("grows the footer band and updates SOUTH pins only when footer reservation requires it", () => {
    const owner = {
      width: 26,
      height: 20,
      device: { designation: "B1" },
      relationLabels: ["4: 221"],
      pins: [
        { side: "NORTH", x: 10, y: 0 },
        { side: "SOUTH", x: 10, y: 20 },
      ],
    };
    let calls = 0;
    reserveCircuitCaptions([owner], true, (n) => {
      calls++;
      if (calls === 1) throw new CaptionPlacementError("4: 221", "footer");
      expect(n.height).toBeGreaterThan(20);
      expect(n.width).toBe(26);
      expect(n.pins[1]!.y).toBe(n.height);
    });
    expect(calls).toBe(2);
    expect(owner.pins[0]!.y).toBe(0);
    expect(owner.pins[1]!.y).toBe(owner.height);
  });

  it("reserves the painted interface <rect> outline in nodeCaptionSegments matching circuitInterfaceMark", () => {
    const supplyFn = {
      id: { deviceUid: "b1", functionKey: "supply" },
      kind: "load" as const,
      terminals: [
        { deviceUid: "b1", terminalKey: "1" },
        { deviceUid: "b1", terminalKey: "3" },
      ],
      properties: {},
    };
    const pins = [
      { terminal: supplyFn.terminals[0]!, x: 0, y: 9, side: "WEST" },
      { terminal: supplyFn.terminals[1]!, x: 0, y: 16, side: "WEST" },
    ];
    const rect = interfaceOutlineRect(
      "sensor-3wire",
      13,
      12.5,
      pins,
      false,
      false,
    );
    expect(rect).toEqual({ x: 8, y: 7, width: 10, height: 11 });
    expect(
      circuitInterfaceMark("sensor-3wire", 13, 12.5, pins, false, false),
    ).toContain('<rect x="8" y="7" width="10" height="11"/>');
    // Omitted for 1-pin sensor output, source, and conversion marks.
    expect(
      interfaceOutlineRect("sensor-3wire", 21, 7, [pins[0]!], false, false),
    ).toBeUndefined();
    expect(
      interfaceOutlineRect("sensor-3wire", 13, 12.5, pins, false, true),
    ).toBeUndefined();
    expect(
      interfaceOutlineRect("ac-input", 13, 12.5, pins, false, false),
    ).toBeUndefined();

    const { ownerSegments } = nodeCaptionSegments(
      {
        width: 26,
        height: 28.1,
        boundary: false,
        type: { symbol: "thermite:sensor-3wire" },
        sourceTerminalKeys: [],
        rows: [{ f: supplyFn, mark: "sensor-3wire" }],
        pins,
      },
      [{ x: 13, y: 12.5 }],
      false,
      () => true,
    );
    // Lower edge of the interface rect at y=18 must be present in reserved ownerSegments.
    expect(
      ownerSegments.some(
        ([a, b]) =>
          a.y === 18 &&
          b.y === 18 &&
          Math.min(a.x, b.x) === 8 &&
          Math.max(a.x, b.x) === 18,
      ),
    ).toBe(true);
  });

  it("includes coil AC/DC qualifier text in the footer obstacle plan and grows height when needed", () => {
    const node = tightCoilNode();
    expect(
      rowInBodyTexts(node.rows[0]!, {
        node,
        vertical: false,
        diagramCenterY: 6,
        key: (t) => `${t.deviceUid}:${t.terminalKey}`,
        channelLabelLines: () => [],
      }),
    ).toEqual([{ x: 13, y: 7.8, value: "DC", size: 2.5, anchor: "middle" }]);
    // Short 12 mm body cannot fit two footers below the coil + DC qualifier without growing.
    reserveCircuitCaptions([node], false, emitMinimalNode);
    expect(node.height).toBeGreaterThan(12);
    const texts = [
      ...parseHTML(emitMinimalNode(node)).document.querySelectorAll("text"),
    ];
    const dc = texts.find((t) => t.textContent === "DC");
    const footer1 = texts.find((t) => t.textContent === "13–14: 200");
    const footer2 = texts.find((t) => t.textContent === "23–24: 201");
    expect(dc).toBeTruthy();
    expect(footer1).toBeTruthy();
    expect(footer2).toBeTruthy();
    expect(inkGap(textBox(footer1!), textBox(dc!))).toBeGreaterThanOrEqual(0.3);
    expect(inkGap(textBox(footer2!), textBox(dc!))).toBeGreaterThanOrEqual(0.3);
  });
});
