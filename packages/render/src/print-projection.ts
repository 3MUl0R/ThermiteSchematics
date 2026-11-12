import type { IrFunction, IrDeviceType } from "@thermite/compiler";

/** Internal presentation only. Lookup keys, IR and CSV identities are unchanged. */
export function printedFunction(fn: IrFunction): string {
  const noun =
    fn.kind === "contact"
      ? `${fn.normal_state === "open" ? "NO" : "NC"} contact`
      : fn.kind === "channel"
        ? `${fn.direction === "input" ? "Input" : "Output"} channel`
        : fn.kind.charAt(0).toUpperCase() + fn.kind.slice(1);
  const terminals = fn.terminals.map((t) => t.terminalKey);
  return [
    noun,
    terminals.join(terminals.some((t) => t.includes("–")) ? ", " : "–"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Port keys are selectors, never connector names. The schema currently has no
 * communication-port terminal binding; an absent identity stays unspecified. */
export function printedPort(
  type: Pick<IrDeviceType, "ports"> | undefined,
  key: string,
): string {
  const port = type?.ports?.[key];
  return (
    port?.description?.trim() ||
    port?.connector?.trim() ||
    "Port identity not specified"
  );
}
