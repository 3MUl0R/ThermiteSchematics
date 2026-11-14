import { hasCompactFrame } from "./frame-profile.js";
import type { RootedCandidate } from "./rooted-build.js";
import type { ContinuationBank } from "./continuation-bank.js";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type { FoldGroups } from "./frame-fold-groups.js";
import type { RootedGrid } from "./rooted-plans.js";
import type { Draft, DrawingBounds, PaperPage } from "./types.js";
import { required } from "../presentation/util.js";
import { n } from "./svg.js";

export const FRAME_LOSS_LIMIT_PERCENT = 2;
export interface FrameField extends DrawingBounds {
  area: number;
  anchorArea: number;
}
export interface FrameAttempt {
  id: string;
  bank: ContinuationBank;
  grid: RootedGrid;
  groups?: FoldGroups;
  fields: FrameField[];
  losses: number[];
  pages: number;
  scale: number;
  failure?: string;
}
export interface FrameReceipt {
  view: PreparedSchematicDrawing["view"];
  rootedViewOrdinal: number;
  referenceScale: number;
  referenceFields: FrameField[];
  /** Bounds for the new search, in addition to one existing-placement probe. */
  candidateLimit: {
    gridsPerBank: 36;
    banksPerLayout: 6;
    foldsPerGrid: 64;
    layouts: 52;
  };
  candidates: FrameAttempt[];
  sheets: {
    sheet: number;
    strategy:
      "existing-compact" | "folded-group" | "legacy-continuation-placement";
    candidate: string;
    lossPercent: number;
  }[];
  fallback?: {
    sheet: number;
    strategy:
      "existing-compact" | "folded-group" | "legacy-continuation-placement";
    lossPercent: number;
    failure?: string;
  }[];
  termination?:
    | "existing-within-budget"
    | "zero-loss-lower-bound"
    | "bounded-enumeration"
    | "no-compatible-fallback";
}
interface Context {
  reference: RootedCandidate | null;
  receipt: FrameReceipt;
  layouts: WeakMap<PreparedSchematicDrawing, number>;
  layoutCount: number;
  attempts: Set<string>;
}
const pages = new WeakMap<PaperPage, Map<string, Context>>();
const receipts = new WeakMap<PaperPage, FrameReceipt[]>();
const selected = new WeakMap<Draft[], RootedCandidate>();
const key = (view: PreparedSchematicDrawing["view"]) => JSON.stringify(view);
export const rememberFrameCandidate = (candidate: RootedCandidate) =>
  selected.set(candidate.drafts, candidate);
export const frameCandidate = (drafts: Draft[]) =>
  required(selected.get(drafts), "Missing selected frame reference");
export function frameContext(
  page: PaperPage,
  view: PreparedSchematicDrawing["view"],
) {
  const ctx = pages.get(page)?.get(key(view));
  return ctx?.reference ? ctx : undefined;
}
export function beginFramePlanning(
  page: PaperPage,
  reference: RootedCandidate,
) {
  const all = receipts.get(page) ?? [];
  const receipt: FrameReceipt = {
    view: reference.prepared.view,
    rootedViewOrdinal: all.length,
    referenceScale: reference.scale,
    referenceFields: reference.drafts.map((d) =>
      frameField(required(d.drawingBounds, "Missing legacy drawing field")),
    ),
    candidateLimit: {
      gridsPerBank: 36,
      banksPerLayout: 6,
      foldsPerGrid: 64,
      layouts: 52,
    },
    candidates: [],
    sheets: [],
  };
  all.push(receipt);
  receipts.set(page, all);
  const map = pages.get(page) ?? new Map<string, Context>();
  map.set(key(reference.prepared.view), {
    reference,
    receipt,
    layouts: new WeakMap(),
    layoutCount: 0,
    attempts: new Set(),
  });
  pages.set(page, map);
}
export function compactPlanningReceipts(
  page: PaperPage,
): readonly FrameReceipt[] {
  return structuredClone(receipts.get(page) ?? []);
}

/** Compare both printed tick endpoints and the independently reconstructed mark sequence. */
export function frameField(b: DrawingBounds): FrameField {
  const q = (v: number) => Number(n(v));
  const x = q(b.x),
    y = q(b.y),
    w = q(b.x + b.w) - x,
    h = q(b.y + b.h) - y;
  const aw = q(((q(b.x + (b.w * 11) / 12) - q(b.x + b.w / 12)) / 5) * 6);
  const ah = q(((q(b.y + (b.h * 7) / 8) - q(b.y + b.h / 8)) / 3) * 4);
  return { x, y, w, h, area: w * h, anchorArea: aw * ah };
}
export function fieldLoss(before: FrameField, after: FrameField): number {
  return Math.max(
    0,
    ((before.area - after.area) / before.area) * 100,
    ((before.anchorArea - after.anchorArea) / before.anchorArea) * 100,
  );
}
export function candidateLosses(candidate: RootedCandidate, page: PaperPage) {
  const ctx = hasCompactFrame(page)
    ? frameContext(page, candidate.prepared.view)
    : undefined;
  if (!ctx) return [];
  const refs = ctx.receipt.referenceFields;
  return candidate.drafts.map((d, i) =>
    fieldLoss(
      required(refs[Math.min(i, refs.length - 1)], "Missing reference field"),
      frameField(required(d.drawingBounds, "Missing candidate drawing field")),
    ),
  );
}
export function frameBudgetFailure(
  candidate: RootedCandidate,
  page: PaperPage,
): string | undefined {
  const ctx = hasCompactFrame(page)
    ? frameContext(page, candidate.prepared.view)
    : undefined;
  if (!ctx) return;
  if (candidate.drafts.length !== ctx.receipt.referenceFields.length)
    return "page-count";
  if (Math.abs(candidate.scale - ctx.receipt.referenceScale) > 1e-12)
    return "scale-change";
  if (
    candidateLosses(candidate, page).some(
      (v) => v > FRAME_LOSS_LIMIT_PERCENT + 1e-8,
    )
  )
    return "drawing-field-loss";
}
export function frameBudgetOrder(
  a: RootedCandidate,
  b: RootedCandidate,
  page: PaperPage,
): number {
  if (!hasCompactFrame(page) || !frameContext(page, a.prepared.view)) return 0;
  const aa = candidateLosses(a, page),
    bb = candidateLosses(b, page);
  return (
    Number(!!frameBudgetFailure(a, page)) -
      Number(!!frameBudgetFailure(b, page)) ||
    Math.max(0, ...aa) - Math.max(0, ...bb) ||
    aa.reduce((n, v) => n + v, 0) - bb.reduce((n, v) => n + v, 0)
  );
}
export function frameZeroLoss(candidate: RootedCandidate, page: PaperPage) {
  return (
    hasCompactFrame(page) &&
    !!frameContext(page, candidate.prepared.view) &&
    !frameBudgetFailure(candidate, page) &&
    candidateLosses(candidate, page).every((v) => v === 0)
  );
}

export function recordFrameAttempt(
  page: PaperPage,
  p: PreparedSchematicDrawing,
  profile: RootedCandidate["profile"],
  bank: ContinuationBank,
  grid: RootedGrid,
  groups: FoldGroups | undefined,
  scale: number,
  fields: DrawingBounds[],
  failure?: string,
) {
  const ctx = frameContext(page, p.view);
  if (!ctx) return;
  let ordinal = ctx.layouts.get(p);
  if (ordinal === undefined) {
    ordinal = ctx.layoutCount++;
    ctx.layouts.set(p, ordinal);
  }
  const id = JSON.stringify([ordinal, profile, bank, grid, groups]);
  if (ctx.attempts.has(id)) return;
  ctx.attempts.add(id);
  const measured = fields.map(frameField),
    refs = ctx.receipt.referenceFields;
  const losses = measured.map((f, i) =>
    fieldLoss(
      required(refs[Math.min(i, refs.length - 1)], "Missing reference field"),
      f,
    ),
  );
  ctx.receipt.candidates.push({
    id,
    bank: structuredClone(bank),
    grid: structuredClone(grid),
    ...(groups ? { groups: structuredClone(groups) } : {}),
    fields: measured,
    losses,
    pages: fields.length,
    scale,
    ...(failure ? { failure } : {}),
  });
}
export function finishFramePlanning(
  page: PaperPage,
  candidate: RootedCandidate,
  strategy:
    "existing-compact" | "folded-group" | "legacy-continuation-placement",
) {
  const ctx = required(
    frameContext(page, candidate.prepared.view),
    "Missing frame planning context",
  );
  const losses = candidateLosses(candidate, page);
  const id = JSON.stringify([
    ctx.layouts.get(candidate.prepared),
    candidate.profile,
    candidate.bank,
    candidate.grid,
    candidate.foldGroups,
  ]);
  ctx.receipt.sheets = losses.map((lossPercent, sheet) => ({
    sheet: sheet + 1,
    strategy,
    candidate: id,
    lossPercent,
  }));
  ctx.receipt.termination =
    strategy === "existing-compact"
      ? "existing-within-budget"
      : frameZeroLoss(candidate, page)
        ? "zero-loss-lower-bound"
        : "bounded-enumeration";
  ctx.reference = null;
}
