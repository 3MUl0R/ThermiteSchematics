import type { ElectricalIr } from "@thermite/compiler";
import type { Diagnostic } from "@thermite/schema";
import type { CircuitViewRequest } from "../circuit.js";

const SNAKE_CASE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;

/** Warn when an authored circuit group label repeats a snake_case function key verbatim. */
export function lintCircuitGroupLabels(
  ir: Readonly<ElectricalIr>,
  view: Readonly<CircuitViewRequest>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
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
          .map((fn) => fn.key)
          .filter(
            (key) =>
              SNAKE_CASE_KEY.test(key) &&
              (label === key || segments.includes(key)),
          ),
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
