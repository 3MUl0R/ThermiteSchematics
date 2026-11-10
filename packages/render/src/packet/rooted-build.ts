import { cardDistances, CARD_LOCALITY_AIM_MM } from "./rooted-locality.js";
import {
  continuationBanks,
  bankBounds,
  type ContinuationBank,
} from "./continuation-bank.js";
import { fitContinuations } from "./continuation-fit.js";
import { contentPages } from "./rooted-content.js";
import { rootedLocationContent } from "./location-headings.js";
import { required } from "../presentation/util.js";
import type { ElectricalIr } from "@thermite/compiler";
import type { PreparedSchematicDrawing } from "../renderer.js";
import type { RenderOutcome, RenderFailure } from "../types.js";
import type { Draft, PaperPage } from "./types.js";
import { continuationGridConstraint } from "./continuation-constraint.js";
import type {
  RootedConstraint,
  RootedDiagnostic,
} from "./rooted-constraint.js";
import { bounds } from "./page.js";
import { gridLinks, type RootedGrid } from "./rooted-plans.js";
import { rootedBankGrids } from "./rooted-bank-grids.js";
import { rootedDraft } from "./rooted-draft.js";
import { postTrimCaptionConstraint } from "./rooted-caption.js";
import { foldDrawingDrafts } from "./folding.js";
import { emitSchematicSvg } from "../svg/emitter.js";
import { offViewPacketFailure } from "../off-view/presentation.js";
import { OUTER_SVG_PADDING as pad } from "../symbols/catalog.js";
import { interiorJogs, routeDetours } from "./rooted-ink.js";

export interface RootedCandidate {
  printableDrafts?: Draft[];
  drafts: Draft[];
  bank: ContinuationBank;
  grid: RootedGrid;
  profile?: "compact" | "dense";
  prepared: PreparedSchematicDrawing;
  scale: number;
  jogs: Map<string, number>;
  detours?: ReadonlyMap<string, number>;
  greedy?: boolean;
  proximity: number;
  localityExcess?: number;
}
export type RootedBuildResult = RenderOutcome<RootedCandidate[]> &
  RootedDiagnostic;
export function rootedSpace(
  p: PreparedSchematicDrawing,
  page: PaperPage,
  compact: boolean,
  native = false,
) {
  let b = bounds(p.titleContext, page, native ? undefined : p.view);
  b = { ...b, y: b.y + 4, h: b.h - 4 };
  const full = page.widthMm - 2 * page.marginMm - 10;
  if (
    compact &&
    (p.layout.width + 2 * pad) * 0.25 <= full &&
    (p.layout.height + 2 * pad) * 0.25 <= b.h
  )
    b = { ...b, x: page.marginMm + 5, w: full };
  const scale = Math.max(
    0.25,
    Math.min(
      0.32,
      b.w / (p.layout.width + 2 * pad),
      b.h / (p.layout.height + 2 * pad),
    ),
  );
  return { b, scale };
}

function makeDrafts(
  p: PreparedSchematicDrawing,
  grid: RootedGrid,
  page: PaperPage,
  scale: number,
  inner: string,
  compact: boolean,
  profile: "compact" | "dense" | undefined,
  native: boolean,
  bank: ContinuationBank,
): Draft[] | string {
  const original = rootedSpace(p, page, compact, native).b;
  const b = bankBounds(original, bank);
  const drafts: Draft[] = [];
  for (let row = 0; row < grid.ys.length - 1; row++)
    for (let col = 0; col < grid.xs.length - 1; col++)
      drafts.push(
        rootedDraft(
          p,
          grid,
          col,
          row,
          b,
          scale,
          inner,
          profile,
          original.y - 9,
        ),
      );
  for (const d of drafts) d.rootedScoreBounds = original;
  if (!gridLinks(p, grid, b, scale, drafts))
    return "Continuation spacing does not fit this grid.";
  const caption = postTrimCaptionConstraint(drafts, page, native);
  if (caption) return caption;
  const originalDrafts = structuredClone(drafts);
  const pages =
    grid.ys.length === 2 && grid.xs.length > 2
      ? foldDrawingDrafts(
          drafts,
          p.layout,
          grid.xs,
          b,
          scale,
          p.layout.height + 2 * pad,
          { prepared: p, inner, ...(profile ? { profile } : {}) },
        )
      : drafts;
  const visible = contentPages(pages);
  if (typeof visible === "string") return visible;
  const failure =
    fitContinuations(visible, page, bank, native) ??
    postTrimCaptionConstraint(visible, page, native);
  if (!failure) return visible;
  if (pages === drafts) return failure;
  // Conservative fallback retains the complete original viewports and captions.
  const fallback = contentPages(originalDrafts);
  return typeof fallback === "string"
    ? fallback
    : (fitContinuations(fallback, page, bank, native) ??
        postTrimCaptionConstraint(fallback, page, native) ??
        fallback);
}

export function buildRootedCandidates(
  ir: Readonly<ElectricalIr>,
  p: PreparedSchematicDrawing,
  page: PaperPage,
  profile?: "compact" | "dense",
  native = false,
  explore = false,
  offset = 0,
): RootedBuildResult {
  const { b, scale } = rootedSpace(p, page, !!profile, native);
  if (b.w < 60 || b.h < 50)
    return offViewPacketFailure(
      p.graph,
      "unprintable-layout",
      "Title information leaves insufficient drawing space. Use a larger sheet or landscape.",
    );
  const banks = continuationBanks(p, b, scale, offset);
  const inner = "";
  const distances = cardDistances(p, scale);
  const constraint = continuationGridConstraint(
    p,
    banks.map((bank) => bankBounds(b, bank)),
    scale,
  );
  let captionFailure: string | RootedConstraint = constraint;
  const search = rootedBankGrids(p, b, scale, banks, explore);
  const candidates = search.grids.flatMap(({ bank, grid: g }) => {
    const drafts = makeDrafts(
      p,
      g,
      page,
      scale,
      inner,
      !!profile,
      profile,
      native,
      bank,
    );
    if (typeof drafts === "string") {
      captionFailure = drafts;
      return [];
    }
    return [
      {
        drafts,
        bank,
        grid: g,
        ...(profile ? { profile } : {}),
        prepared: p,
        scale,
        jogs: interiorJogs(p, scale),
        detours: routeDetours(p, scale),
        greedy: g.greedy === true,
        proximity: distances.reduce((sum, n) => sum + n, 0),
        localityExcess: distances.reduce(
          (sum, n) => sum + Math.max(0, n - CARD_LOCALITY_AIM_MM),
          0,
        ),
      },
    ];
  });
  if (!candidates.length && !explore)
    return buildRootedCandidates(ir, p, page, profile, native, true, offset);
  if (candidates.length) return { ok: true, value: candidates, constraint };
  return failedBuild(p, constraint, captionFailure, search.identityFailure);
}

function failedBuild(
  p: PreparedSchematicDrawing,
  constraint: RootedConstraint,
  caption: string | RootedConstraint,
  identityFailure: RenderFailure | undefined,
): RootedBuildResult {
  const message = typeof caption === "string" ? caption : caption.message;
  const error =
    identityFailure ??
    offViewPacketFailure(p.graph, "unprintable-layout", message).error;
  return {
    ok: false,
    error,
    constraint,
    ...(!identityFailure && typeof caption !== "string"
      ? { gridFailure: { error, suffix: error.message.slice(message.length) } }
      : {}),
  };
}

/** Only the selected layout is emitted; it still passes the original emitter. */
export function materializeRootedCandidate(
  ir: Readonly<ElectricalIr>,
  candidate: RootedCandidate,
  page: PaperPage,
): RenderOutcome<Draft[]> {
  const p = candidate.prepared,
    scale = candidate.scale;
  const emitted = emitSchematicSvg(
    p.graph,
    p.layout,
    p.titleContext,
    undefined,
    true,
    scale,
    ir,
  );
  if (!emitted.ok) return emitted;
  const inner = emitted.value
    .replace(/^<\?xml[^>]*>\s*/, "")
    .replace(/^<svg[^>]*>\s*/, "")
    .replace(/<\/svg>\s*$/, "");
  const drafts = makeDrafts(
    p,
    candidate.grid,
    page,
    scale,
    rootedLocationContent(inner, p, candidate.drafts),
    !!candidate.profile,
    candidate.profile,
    false,
    candidate.bank,
  );
  return typeof drafts === "string"
    ? offViewPacketFailure(p.graph, "unprintable-layout", drafts)
    : { ok: true, value: drafts };
}
