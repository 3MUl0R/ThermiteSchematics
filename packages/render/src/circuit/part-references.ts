import type { ElectricalIr } from "@thermite/compiler";
import type { CircuitViewRequest } from "../circuit.js";
import { measure } from "../symbols/circuit-text.js";
import { required } from "../presentation/util.js";

export function circuitPartReferences(
  ir: Readonly<ElectricalIr>,
  request: CircuitViewRequest,
  functions: readonly string[],
  appearances: Map<string, string[]>,
) {
  const terminalName = (id: string) => {
    const pair: unknown = JSON.parse(id);
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    )
      throw Error("Invalid circuit part terminal identity");
    const [uid, key] = pair;
    const device = required(
      ir.devices.find((d) => d.uid === uid),
      "Missing circuit part terminal owner",
    );
    return `${device.designation}.${key}`;
  };
  const terminals = (
    ids: readonly string[],
    targets: (id: string) => number[],
  ) =>
    ids.flatMap((id) => {
      const parts = targets(id);
      return parts.length ? [{ id, label: terminalName(id), parts }] : [];
    });
  const [group] = request.groups;
  if (
    request.groups.length !== 1 ||
    !group?.label ||
    group.lineReference ||
    measure(request.title) >= measure(group.label)
  )
    return { terminals, appearances };

  // The printed view title identifies its sole group across the folded parts.
  // Each part's heading still carries the complete authored group label.
  const projected = new Map(appearances);
  for (const id of functions) {
    const labels = appearances.get(id);
    if (labels)
      projected.set(id, [
        ...new Set(
          labels.map((label) =>
            label === group.label ? request.title : label,
          ),
        ),
      ]);
  }
  return { terminals, appearances: projected };
}
