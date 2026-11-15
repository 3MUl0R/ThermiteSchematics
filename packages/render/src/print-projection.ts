import { formatTerminalSet } from "@thermite/query";
import type { IrFunction } from "@thermite/compiler";

/** A native function supplies pair evidence; selectors never supply print text. */
export function printedTerminals(
  fn: Pick<IrFunction, "id" | "kind" | "terminals">,
) {
  return formatTerminalSet(
    fn.terminals.map((t) => t.terminalKey),
    undefined,
    fn,
  );
}

/** Internal presentation only. Lookup keys, IR and CSV identities are unchanged. */
export function printedFunction(fn: IrFunction): string {
  const noun =
    fn.kind === "contact"
      ? `${fn.normal_state === "open" ? "NO" : "NC"} contact`
      : fn.kind === "channel"
        ? `${fn.direction === "input" ? "Input" : "Output"} channel`
        : fn.kind.charAt(0).toUpperCase() + fn.kind.slice(1);
  return [noun, printedTerminals(fn)].filter(Boolean).join(" ");
}
