import type { ElectricalIr, IrDevice } from "@thermite/compiler";
import type { Diagnostic } from "@thermite/schema";
import type { CircuitViewRequest } from "../circuit.js";

const SNAKE_CASE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;

function deviceTerminalNames(
  ir: Readonly<ElectricalIr>,
  device: Readonly<IrDevice> | undefined,
): Set<string> {
  const names = new Set<string>();
  if (!device) return names;
  for (const terminal of ir.terminals)
    if (terminal.id.deviceUid === device.uid)
      names.add(terminal.id.terminalKey);
  const type = ir.deviceTypes.find((t) => t.id === device.typeId);
  for (const terminal of type?.terminals ?? []) names.add(terminal.key);
  return names;
}

function resolveDevice(
  ir: Readonly<ElectricalIr>,
  selector: CircuitViewRequest["groups"][number]["functions"][number]["device"],
): Readonly<IrDevice> | undefined {
  return ir.devices.find((d) =>
    selector.by === "uid"
      ? d.uid === selector.value
      : d.designation === selector.value,
  );
}

/** Warn when an authored circuit group label repeats a snake_case function key verbatim. */
export function lintCircuitGroupLabels(
  ir: Readonly<ElectricalIr>,
  view: Readonly<CircuitViewRequest>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const terminalCache = new Map<string, Set<string>>();
  const terminalsFor = (device: Readonly<IrDevice> | undefined) => {
    if (!device) return undefined;
    let names = terminalCache.get(device.uid);
    if (!names) {
      names = deviceTerminalNames(ir, device);
      terminalCache.set(device.uid, names);
    }
    return names;
  };
  for (const group of view.groups) {
    const label = group.label?.trim();
    if (!label) continue;
    const segments = label
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const matchedKeys = [
      ...new Set(
        group.functions
          .filter((fn) => {
            if (
              !SNAKE_CASE_KEY.test(fn.key) ||
              (label !== fn.key && !segments.includes(fn.key))
            )
              return false;
            const terminals = terminalsFor(resolveDevice(ir, fn.device));
            return !terminals?.has(fn.key);
          })
          .map((fn) => fn.key),
      ),
    ];
    if (!matchedKeys.length) continue;
    diagnostics.push({
      code: "W908",
      severity: "warning",
      ...ir.project.source,
      message: `Circuit view ${JSON.stringify(view.title)}, group ${JSON.stringify(group.id)}: group label ${JSON.stringify(label)} repeats snake_case function key ${matchedKeys.map((k) => JSON.stringify(k)).join(", ")}. Replace with a human-readable heading while keeping the function key unchanged.`,
    });
  }
  return diagnostics;
}
