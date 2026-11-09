import type { IrDeviceType, IrDeviceTypeFunction } from "@thermite/compiler";
import type { FunctionSymbolRule } from "./mappings.js";

/** A control binding must preserve the authored protection/contact identity.
 * Power keeps its existing compatibility rules, including unsupported overrides. */
export function protectionControlRefusal(
  profile: string | undefined,
  mark: string | undefined,
  fn: { kind: string; normal_state?: "open" | "closed" },
): string | undefined {
  let supported: string;
  if (profile === "thermite:fuse") {
    if (
      mark === "fuse" ||
      (mark === undefined &&
        (fn.kind === "other" || fn.normal_state === "closed"))
    )
      return;
    supported =
      'Fuse control accepts unmarked other/2, a "fuse" mark, or a closed unmarked contact/2.';
  } else if (profile === "thermite:breaker") {
    if (
      mark === undefined ||
      ["breaker", "contact-no", "contact-nc"].includes(mark)
    )
      return;
    supported =
      'Breaker control accepts unmarked contacts or "breaker", "contact-no" and "contact-nc" marks.';
  } else return;
  return `Unsupported control protection identity: normal_state=${fn.kind === "contact" ? JSON.stringify(fn.normal_state) : "not applicable"}, circuitSymbols=${mark === undefined ? "unmarked" : JSON.stringify(mark)}. ${supported} Use a circuit view with a compatible explicit mark to retain the authored identity.`;
}

export function protectionFamilyRules(
  profile: string | undefined,
  type: IrDeviceType,
  fn: IrDeviceTypeFunction,
  rule: FunctionSymbolRule,
): FunctionSymbolRule[] {
  if (profile !== "thermite:fuse" && profile !== "thermite:breaker")
    return [rule];
  const refusal = protectionControlRefusal(
    profile,
    type.circuitSymbols?.[fn.key],
    fn,
  );
  return rule.families
    .filter((family) => family !== "control" || !refusal)
    .map((family) => ({
      ...rule,
      families: [family],
      classification: family === "control" ? "protection" : rule.classification,
      traversalRole:
        family === "control" ? "protection-contact" : rule.traversalRole,
    }));
}
