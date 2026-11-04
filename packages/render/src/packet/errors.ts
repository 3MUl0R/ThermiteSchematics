import type { InvalidSheetError } from "../errors.js";

import type { RenderOutcome } from "../types.js";

export function failure(
  reason: InvalidSheetError["reason"],
  message: string,
): RenderOutcome<never> {
  return {
    ok: false,
    error: { code: "R006", root: "packet", reason, message },
  };
}
export function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
