import { AsyncLocalStorage } from "node:async_hooks";
import type { RenderFailure } from "../types.js";

export type ViewRecoveryKind = "circuit-caption" | "series-loop-fallback";

export interface ViewRecoveryCause {
  readonly kind: ViewRecoveryKind;
  readonly failure: RenderFailure;
}

const viewRecoverySink = new AsyncLocalStorage<
  (recovery: ViewRecoveryCause) => void
>();

export async function captureViewRecovery<T>(
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly recovery?: ViewRecoveryCause }> {
  let recovery: ViewRecoveryCause | undefined;
  const result = await viewRecoverySink.run((cause) => {
    recovery ??= cause;
  }, fn);
  return recovery ? { result, recovery } : { result };
}

export function reportViewRecovery(
  kind: ViewRecoveryKind,
  failure: RenderFailure,
): void {
  viewRecoverySink.getStore()?.({ kind, failure });
}
