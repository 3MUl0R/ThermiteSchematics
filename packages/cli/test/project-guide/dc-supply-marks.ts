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
  readonly explicit?: string;
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
    label: "2+ non-earth pins all rated AC without AC roles",
    target: "load",
    terminals: [
      { key: "A", rating: { voltage_type: "AC" } },
      { key: "B", rating: { voltage_type: "AC" } },
      { key: "PE", role: "protective_earth" },
    ],
    expected: "ac-input",
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
    label: "AC-rated shield non-power pin conflict on load",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "N", role: "ac_input_return", rating: { voltage_type: "AC" } },
      { key: "S", role: "shield", rating: { voltage_type: "AC" } },
    ],
    expected: "load",
  },
  {
    label: "AC-rated no_connection non-power pin conflict on load",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "N", role: "ac_input_return", rating: { voltage_type: "AC" } },
      { key: "NC", role: "no_connection", rating: { voltage_type: "AC" } },
    ],
    expected: "load",
  },
  {
    label: "2-terminal source with AC rating",
    target: "source",
    terminals: [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", role: "dc_negative_output" },
    ],
    expected: "source",
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
  {
    label: "2-terminal source with shield non-power role",
    target: "source",
    terminals: [
      { key: "+", role: "dc_positive_output" },
      { key: "S", role: "shield" },
    ],
    expected: "source",
  },
  {
    label: "2-terminal source with no_connection non-power role",
    target: "source",
    terminals: [
      { key: "+", role: "dc_positive_output" },
      { key: "NC", role: "no_connection" },
    ],
    expected: "source",
  },
  {
    label: "explicit compatible load binding overrides default ac-input",
    target: "load",
    terminals: [
      { key: "L", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "N", role: "ac_input_return", rating: { voltage_type: "AC" } },
    ],
    explicit: "load",
    expected: "load",
  },
  {
    label: "explicit compatible ac-input binding overrides default load",
    target: "load",
    terminals: [
      { key: "A", role: "dc_input" },
      { key: "B", role: "dc_return" },
    ],
    explicit: "ac-input",
    expected: "ac-input",
  },
  {
    label: "explicit compatible source binding overrides default dc-output",
    target: "source",
    terminals: [
      { key: "+", role: "dc_positive_output" },
      { key: "-", role: "dc_negative_output" },
    ],
    explicit: "source",
    expected: "source",
  },
  {
    label: "explicit compatible dc-output binding overrides default source",
    target: "source",
    terminals: [
      { key: "+", role: "dc_positive_output" },
      { key: "S", role: "shield" },
    ],
    explicit: "dc-output",
    expected: "dc-output",
  },
];

function evaluateCase(
  baseType: IrDeviceType,
  deviceUid: string,
  fn: IrFunction,
  terminals: IrDeviceTypeTerminal[],
  explicit?: string,
) {
  const copy = structuredClone(baseType);
  copy.terminals = terminals;
  if (explicit !== undefined) {
    copy.circuitSymbols = {
      ...copy.circuitSymbols,
      [fn.id.functionKey]: explicit,
    };
  }
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
        "`thermite:dc-supply` default: 2-pin source `dc-output` unless AC/earth/auxiliary or other non-power facts; 2/3-pin load skips earth and uses `ac-input` only with complete AC roles or 2+ non-earth pins all rated AC, no DC/auxiliary/non-power conflict; else generic `load`. Explicit compatible bindings take precedence.",
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
          const mark = evaluateCase(
            type,
            ps1.uid,
            fn,
            row.terminals,
            row.explicit,
          );
          expect(mark, row.label).toBe(row.expected);
          if (fallbackMark === "") fallbackMark = mark;
        }
        expect(() =>
          evaluateCase(
            type,
            ps1.uid,
            acInput,
            type.terminals.slice(0, 2),
            "dc-output",
          ),
        ).toThrow(/incompatible/);
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
