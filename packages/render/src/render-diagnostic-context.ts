import type { ElectricalIr } from "@thermite/compiler";
import type { RenderFailure, RenderOutcome } from "./types.js";
import { packetViewContext, record } from "./packet/errors.js";

/** Existing precise device/view details take precedence over caller scope. */
function hasNamedScope(details: unknown): boolean {
  const pending = [details],
    seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value))
      continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "designation" && typeof child === "string" && child.length)
        return true;
      if (key === "viewIndex" && Number.isInteger(child) && Number(child) >= 0)
        return true;
      if (
        key === "functionDisplayKeys" &&
        Array.isArray(child) &&
        child.some((v) => typeof v === "string" && v.length)
      )
        return true;
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
  return false;
}

function callerScope(
  ir: Readonly<ElectricalIr>,
  request: unknown,
  error: RenderFailure,
) {
  const requestField =
    "reason" in error && error.reason === "invalid-page"
      ? "/page"
      : record(request) && request.format === "schematic-packet-request/0.1"
        ? "/views"
        : "/";
  const base = { projectName: ir.project.name, requestField };
  try {
    if (record(request) && request.format === "schematic-packet-request/0.1") {
      if (!Array.isArray(request.views) || !request.views.length)
        return { ...base, views: [] };
      const authoredViews: readonly unknown[] = request.views;
      // A rejected oversized request has no rendered contributors. Identify its
      // first overflowing authored entry without walking an unbounded array.
      const views =
        authoredViews.length > 40
          ? [packetViewContext(authoredViews[40], 40, ir)]
          : authoredViews.map((view, index) =>
              packetViewContext(view, index, ir),
            );
      return { ...base, views };
    }
    return { ...base, views: [packetViewContext(request, 0, ir)] };
  } catch {
    // Context must never replace the original diagnostic for a hostile caller.
    return { ...base, views: [], scopeUnavailable: true };
  }
}

/** Add identities after failure selection; preserve code, reason and message. */
export function renderDiagnosticContext<E extends RenderFailure>(
  ir: Readonly<ElectricalIr>,
  request: unknown,
  error: E,
): E {
  if (!/^R00[1-6]$/u.test(error.code)) return error;
  const details =
    "details" in error && record(error.details) ? error.details : undefined;
  if (hasNamedScope(details)) return error;
  return {
    ...error,
    details: { ...details, diagnosticContext: callerScope(ir, request, error) },
  };
}

export function contextualRenderOutcome<T>(
  ir: Readonly<ElectricalIr>,
  request: unknown,
  result: RenderOutcome<T>,
): RenderOutcome<T> {
  if (result.ok) return result;
  const error = renderDiagnosticContext(ir, request, result.error);
  return error === result.error ? result : { ...result, error };
}
