import { AsyncLocalStorage } from "node:async_hooks";
import { InlineLabelFitError } from "./inline-label-error.js";

export interface ElkWorkLedger {
  label: string;
  limit: number;
  calls: number;
  cacheHits: number;
  baselineCalls: number;
  reserved?: number;
}
export class ElkWorkBudgetError extends InlineLabelFitError {}
export const elkWorkScope = new AsyncLocalStorage<ElkWorkLedger>();
export const elkWorkTrace = new AsyncLocalStorage<ElkWorkLedger[]>();
export const elkPacketWorkTrace = new AsyncLocalStorage<{
  calls: number;
  cacheHits: number;
  outsideSearchCalls: number;
}>();

export function elkWorkLedger(label: string, limit: number): ElkWorkLedger {
  const ledger = { label, limit, calls: 0, cacheHits: 0, baselineCalls: 0 };
  elkWorkTrace.getStore()?.push(ledger);
  return ledger;
}

/** Called only at the exact-input cache boundary, immediately before dispatch.
 * Failed layouts still performed work. Hits never consume a placement. */
export function chargeElkWork(hit = false) {
  const work = elkWorkScope.getStore();
  const packet = elkPacketWorkTrace.getStore();
  if (hit) {
    if (work) work.cacheHits++;
    if (packet) packet.cacheHits++;
    return;
  }
  if (work && work.calls >= work.limit - (work.reserved ?? 0))
    throw new ElkWorkBudgetError("Shared actual ELK layout budget exhausted.");
  if (work) work.calls++;
  if (packet) {
    packet.calls++;
    if (!work) packet.outsideSearchCalls++;
  }
}
