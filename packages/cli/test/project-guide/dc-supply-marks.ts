import {
  compileProject,
  type IrDeviceType,
  type IrDeviceTypeTerminal,
  type IrFunction,
} from "@thermite/compiler";
import { expect } from "vitest";
import { circuitMark } from "../../../render/src/symbols/circuit.js";
import { ctx, noteJson, type FactModule } from "./harness.js";

interface MarkCase {
  readonly label: string;
  readonly target: "load" | "source";
  readonly terminals: IrDeviceTypeTerminal[];
  readonly expected: string;
}

const MARK_CASES: readonly MarkCase[] = [
  {
    label: "one non-earth AC pin + AC-rated protectiveEarth",
    target: "load",
    terminals: [
      { key: "A", rating: { voltage_type: "AC" } },
      { key: "B", role: "protectiveEarth", rating: { voltage_type: "AC" } },
    ],
    expected: "load",
  },
  {
    label: "complete AC roles + DC-rated protective_earth",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "protective_earth", rating: { voltage_type: "DC" } },
    ],
    expected: "ac-input",
  },
  {
    label: "line-to-line ac_line_input pair + protective_earth",
    target: "load",
    terminals: [
      { key: "L1", role: "ac_line_input" },
      { key: "L2", role: "ac_line_input" },
      { key: "PE", role: "protective_earth" },
    ],
    expected: "ac-input",
  },
  {
    label: "incomplete AC roles with AC-rated neutral",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "neutral", rating: { voltage_type: "AC" } },
      { key: "PE", role: "protective_earth" },
    ],
    expected: "load",
  },
  {
    label: "AC role pair with DC-rated return conflict",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "N", role: "ac_input_return", rating: { voltage_type: "DC" } },
    ],
    expected: "load",
  },
  {
    label: "AC-rated aux pin conflict",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "N", role: "ac_input_return", rating: { voltage_type: "AC" } },
      { key: "A", role: "aux", rating: { voltage_type: "AC" } },
    ],
    expected: "load",
  },
  {
    label: "2-terminal source with protective_earth role",
    target: "source",
    terminals: [
      { key: "+", role: "dc_positive_output" },
      { key: "-", role: "protective_earth" },
    ],
    expected: "source",
  },
  {
    label: "2-terminal source with aux role",
    target: "source",
    terminals: [
      { key: "+", role: "dc_positive_output" },
      { key: "-", role: "aux" },
    ],
    expected: "source",
  },
];

function evaluateCase(
  baseType: IrDeviceType,
  deviceUid: string,
  fn: IrFunction,
  terminals: IrDeviceTypeTerminal[],
) {
  const copy = structuredClone(baseType);
  copy.terminals = terminals;
  return circuitMark(copy, {
    ...fn,
    terminals: terminals.map(({ key: terminalKey }) => ({
      deviceUid,
      terminalKey,
    })),
  });
}

const module: FactModule = {
  facts: [
    {
      claim:
        "`thermite:dc-supply`: 2-pin source `dc-output` (no AC/earth/aux); 2/3-pin load skips earth; `ac-input`: complete AC roles (including line-to-line) or 2+ non-earth pins all rated AC, no DC/aux; else `load`.",
      async check() {
        const compiled = await compileProject(ctx.pristine.starter);
        if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
        const ps1 = compiled.ir.devices.find((d) => d.designation === "PS1")!;
        const type = structuredClone(
          compiled.ir.deviceTypes.find((t) => t.id === ps1.typeId)!,
        );
        const acInput = compiled.ir.functions.find(
          (f) => f.id.deviceUid === ps1.uid && f.id.functionKey === "ac_input",
        )!;
        const dcOutput = compiled.ir.functions.find(
          (f) => f.id.deviceUid === ps1.uid && f.id.functionKey === "dc_output",
        )!;
        expect(type.symbol).toBe("thermite:dc-supply");
        const acMark = circuitMark(type, acInput);
        const dcMark = circuitMark(type, dcOutput);
        expect(acMark).toBe("ac-input");
        expect(dcMark).toBe("dc-output");
        let fallbackMark = "";
        for (const row of MARK_CASES) {
          const fn = row.target === "load" ? acInput : dcOutput;
          const mark = evaluateCase(type, ps1.uid, fn, row.terminals);
          expect(mark, row.label).toBe(row.expected);
          if (fallbackMark === "") fallbackMark = mark;
        }
        noteJson({
          symbol: type.symbol,
          marks: [acMark, dcMark, fallbackMark],
        });
      },
    },
  ],
  unexecuted: new Map(),
};
export default module;
