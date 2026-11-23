import { required } from "../presentation/util.js";
import type { ContinuationBank } from "./continuation-bank.js";
import { fitContinuations } from "./continuation-fit.js";
import { rootedDraft } from "./rooted-draft.js";
import { expandStripHeadings, stripEnvelope } from "./strip-envelope.js";
import type { Draft, PaperPage, RootedLegendSource } from "./types.js";
import { OUTER_SVG_PADDING as pad } from "../symbols/catalog.js";

function horizontalLinkMarginCrop(
  source: RootedLegendSource,
  draft: Draft,
  v: { x: number; y: number; w: number; h: number },
  crop: { x: number; y: number; w: number; h: number },
  bank: ContinuationBank,
) {
  const b = required(draft.drawingBounds, "Missing strip bounds");
  const marginUnits = (bank.width / 2 + 3.6) / source.scale;
  let left = crop.x;
  for (const link of draft.links) {
    if (link.side !== "top" && link.side !== "bottom") continue;
    const linkX = v.x + (link.x - b.x) / source.scale;
    left = Math.min(left, linkX - marginUnits);
  }
  left = Math.max(v.x, left);
  if (left >= crop.x - 0.001) return undefined;
  return expandStripHeadings(
    source.prepared,
    { ...crop, x: left, w: crop.x + crop.w - left },
    v.x + v.w,
    v.x,
    "x",
  );
}

function buildTrimmedStrip(
  source: RootedLegendSource,
  draft: Draft,
  v: { x: number; y: number; w: number; h: number },
  crop: { x: number; y: number; w: number; h: number },
  inner: string,
): Draft {
  const next = rootedDraft(
    source.prepared,
    {
      xs: [crop.x + pad, crop.x + crop.w + pad],
      ys: [crop.y + pad, crop.y + crop.h + pad],
    },
    0,
    0,
    required(draft.drawingBounds, "Missing strip bounds"),
    source.scale,
    inner,
    source.profile,
    draft.continuedCaptionY,
  );
  next.links = draft.links.map((link) => ({
    ...link,
    x: link.x + (v.x - crop.x) * source.scale,
    y: link.y + (v.y - crop.y) * source.scale,
  }));
  return next;
}

/** Remove only empty space perpendicular to the cuts. The existing envelope
 * includes symbols, routes, cards and whole headings; print scale is unchanged. */
export function trimLegendStrip(
  source: RootedLegendSource,
  draft: Draft,
  inner: string,
  bank?: ContinuationBank,
  page?: PaperPage,
): Draft {
  const p = source.prepared,
    v = required(draft.rootedSections?.[0], "Missing legend strip").viewport,
    vertical = p.view.flow === "top-to-bottom",
    envelope = vertical
      ? stripEnvelope(p, v.y, v.y + v.h, p.layout.width + pad, "x")
      : stripEnvelope(p, v.x, v.x + v.w, p.layout.height + pad);
  if (!envelope || !draft.rootedContent?.figures) return draft;
  const crop = vertical
    ? {
        ...v,
        x: Math.max(v.x, envelope.x),
        w:
          Math.min(v.x + v.w, envelope.x + envelope.w) -
          Math.max(v.x, envelope.x),
      }
    : {
        ...v,
        y: Math.max(v.y, envelope.y),
        h:
          Math.min(v.y + v.h, envelope.y + envelope.h) -
          Math.max(v.y, envelope.y),
      };
  const tight = buildTrimmedStrip(source, draft, v, crop, inner);
  if (!vertical || !bank || !page || !tight.links.length) return tight;
  const probe = structuredClone(tight);
  for (const link of probe.links) {
    link.to = 99;
    link.toZone = "D6";
  }
  if (!fitContinuations([probe], page, bank)) return tight;
  const padded = horizontalLinkMarginCrop(source, draft, v, crop, bank);
  return padded ? buildTrimmedStrip(source, draft, v, padded, inner) : tight;
}
