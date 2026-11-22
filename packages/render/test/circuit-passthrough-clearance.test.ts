import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "@thermite/compiler";
import { prepareCircuitView } from "../src/circuit.js";
import { verticalPinClearanceHeight } from "../src/circuit/pin-clearance.js";
import type { FunctionRow, Pin } from "../src/circuit/types.js";

it.each(["left-to-right", "top-to-bottom"] as const)(
  "prints one label and one [+N] per physical pass-through terminal while preserving both routing ports (%s)",
  async (flow) => {
    const compiled = await compileProject("examples/circuit-pagination");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const tb = compiled.ir.devices.find((d) =>
      compiled.ir.functions.some(
        (f) =>
          f.id.deviceUid === d.uid &&
          f.kind === "bus" &&
          f.terminals.length === 1,
      ),
    );
    if (!tb)
      throw new Error(
        "Missing pass-through terminal strip in circuit-pagination",
      );
    const tbFunctions = compiled.ir.functions.filter(
      (f) =>
        f.id.deviceUid === tb.uid &&
        f.kind === "bus" &&
        f.terminals.length === 1,
    );
    expect(tbFunctions.length).toBeGreaterThan(0);
    const view = await prepareCircuitView(compiled.ir, {
      format: "circuit-view-request/0.1",
      title: "Pass-through terminal captions",
      flow,
      groups: [
        {
          id: "tb-pass-through",
          functions: tbFunctions.map((f) => ({
            device: { by: "designation" as const, value: tb.designation },
            key: f.id.functionKey,
          })),
          conductors: [],
        },
      ],
    });
    const doc = parseHTML(view.groups[0]!.content).document;
    for (const fn of tbFunctions) {
      const terminal = fn.terminals[0]!;
      const tid = JSON.stringify([terminal.deviceUid, terminal.terminalKey]);
      const ports = [...doc.querySelectorAll(`[data-terminal-id='${tid}']`)];
      // Both pass-through routing ports and terminal markers remain present.
      expect(ports).toHaveLength(2);
      for (const port of ports) {
        expect(port.getAttribute("data-layout-port")).toBeTruthy();
        expect(port.querySelector("circle")).not.toBeNull();
      }
      // Exactly one printed <text> label per physical terminal on the symbol body.
      const texts = ports.flatMap((port) => [...port.querySelectorAll("text")]);
      expect(texts).toHaveLength(1);
      expect(texts[0]!.textContent).toContain(terminal.terminalKey);
    }
  },
);

it("reserves vertical (TTB) terminal-label clearance against own winding body ink (#481)", () => {
  const pinA: Pin = {
    id: "n0p0",
    terminal: { deviceUid: "t1", terminalKey: "H1" },
    x: 0,
    y: 10,
    side: "WEST",
    label: "H1",
    outside: 0,
  };
  const pinB: Pin = {
    id: "n0p1",
    terminal: { deviceUid: "t1", terminalKey: "X2" },
    x: 0,
    y: 12,
    side: "EAST",
    label: "X2",
    outside: 1,
  };
  const row: FunctionRow = {
    f: {
      id: { deviceUid: "t1", functionKey: "sec" },
      kind: "source",
      terminals: [pinA.terminal, { deviceUid: "t1", terminalKey: "X3" }],
      properties: {},
    },
    mark: "winding",
    start: 0,
    slots: 2,
    center: 14,
  };
  const pinC: Pin = {
    id: "n0p2",
    terminal: { deviceUid: "t1", terminalKey: "X3" },
    x: 0,
    y: 22,
    side: "EAST",
    label: "X3",
    outside: 0,
  };
  const required = verticalPinClearanceHeight(
    [pinA, pinB, pinC],
    [row],
    8,
    false,
    (p) => (p.outside ? `${p.label} [+${p.outside}]` : p.label),
    { verticalOffsetX: 1, verticalScaleX: 1 },
    0,
  );
  // Uncoupled winding body + core line extends to +4.2 mm below diagramCenterY;
  // SOUTH label at height - 1.5 directly under it needs > 16 mm total height.
  expect(required).toBeGreaterThan(16);
  // An omitted pass-through label does not add vertical height demand.
  const omitted = verticalPinClearanceHeight(
    [
      { ...pinA, omitLabel: true },
      { ...pinB, omitLabel: true },
      { ...pinC, omitLabel: true },
    ],
    [row],
    8,
    false,
    (p) => p.label,
    { verticalOffsetX: 1, verticalScaleX: 1 },
    0,
  );
  expect(omitted).toBe(0);
});
