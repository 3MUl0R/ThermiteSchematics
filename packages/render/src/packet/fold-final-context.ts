import { AsyncLocalStorage } from "node:async_hooks";
import type { ElectricalIr } from "@thermite/compiler";
import type { RootedSearch } from "./rooted-search.js";
import type { RootedCandidate } from "./rooted-build.js";
import type { RenderedPacket } from "./types.js";

export const foldSources = new WeakMap<RootedSearch, Readonly<ElectricalIr>>();
export interface FoldDecision {
  view: number;
  referenceRequests: number;
  branchRequests: number;
  qualityRequests: number;
  accepted: boolean;
  rejected: string[];
}
/** Observational receipts; logical ELK counters, not timing or cache dispatches. */
export const foldDecisionTrace = new AsyncLocalStorage<FoldDecision[]>();
export interface FoldTrialEvidence {
  view: number;
  raw: RootedCandidate;
  candidate: RootedCandidate;
  reference: RootedCandidate;
  basePacket: RenderedPacket;
  packet?: RenderedPacket;
  routesAllowed: boolean;
  packetAllowed: boolean;
}
export const foldTrialTrace = new AsyncLocalStorage<FoldTrialEvidence[]>();
