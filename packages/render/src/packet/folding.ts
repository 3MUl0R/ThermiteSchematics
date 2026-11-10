import { sumContent } from "./rooted-content.js";
import { required } from "../presentation/util.js";
import type { Draft, DrawingBounds } from "./types.js";
import type { NormalizedSchematicLayout } from "../types.js";
import { unionInk, shiftRootedInk, clipRootedInk } from "./rooted-ink.js";
import { zone } from "./page.js";
import { OUTER_SVG_PADDING } from "../symbols/catalog.js";
import { n } from "./svg.js";

/** Pack existing horizontal sections without changing ELK geometry or endpoints. */
export function foldDrawingDrafts(
  drafts: Draft[],
  layout: NormalizedSchematicLayout,
  xs: readonly number[],
  b: DrawingBounds,
  scale: number,
  fullH: number,
): Draft[] {
  const pad = OUTER_SVG_PADDING,
    nx = xs.length - 1;
  const untrimmed = structuredClone(drafts);
  const heights: number[] = [];
  for (let col = 0; col < nx; col++) {
    const x0 = xs[col]! - pad,
      x1 = xs[col + 1]! - pad;
    const spans = sectionSpans(layout, x0, x1);
    if (!spans.length) return untrimmed;
    const start = Math.max(0, Math.min(...spans.map((s) => s.y)) + pad - 12);
    const end = Math.min(
      fullH,
      Math.max(...spans.map((s) => s.y + s.h)) + pad + 12,
    );
    const h = (end - start) * scale,
      draft = drafts[col]!;
    heights.push(h);
    // Only the first viewport belongs to this section; text/metadata is unchanged.
    draft.content = draft.content.replace(/<svg\b[^>]*>/u, (tag) =>
      tag
        .replace(/\bheight="[^"]*"/u, `height="${n(h)}"`)
        .replace(
          /\bviewBox="[^"]*"/u,
          `viewBox="${n(xs[col]!)} ${n(start)} ${n(xs[col + 1]! - xs[col]!)} ${n(end - start)}"`,
        ),
    );
    shiftRootedInk(draft, -start * scale);
    clipRootedInk(draft, { x: b.x, y: b.y, w: (x1 - x0) * scale, h });
    draft.links = draft.links.map((link) => ({
      ...link,
      y: link.y - start * scale,
    }));
    if (draft.references)
      draft.references = draft.references.map((r) => ({
        ...r,
        ...(r.yMm === undefined ? {} : { yMm: r.yMm - start * scale }),
      }));
  }
  const groups: number[][] = [];
  let used = 0;
  heights.forEach((h, i) => {
    if (!groups.length || used + h + 14 > b.h) {
      groups.push([i]);
      used = h;
    } else {
      groups.at(-1)!.push(i);
      used += 14 + h;
    }
  });
  if (groups.length < drafts.length) {
    const destinations = new Map(
      groups.flatMap((group, index) =>
        group.map((i) => [i + 1, index + 1] as const),
      ),
    );
    const folded = groups.map((group) => {
      const draft: Draft = {
        ...drafts[group[0]!]!,
        rootedContent: sumContent(group.map((i) => drafts[i]!)),
        content: "",
        links: [],
        references: [],
        note: "Folded circuit sections; follow paired conductor references.",
        drawingBounds: b,
      };
      const inks = [];
      draft.rootedShapes = [];
      let offset = 0;
      for (const i of group) {
        const source = drafts[i]!;
        const scoped = scopedSection(source.content, i);
        draft.content += `<g transform="translate(0 ${n(offset)})">${scoped}</g>`;
        draft.links.push(
          ...source.links.map((link) => ({
            ...link,
            to: destinations.get(link.to)!,
            y: link.y + offset,
          })),
        );
        draft.references!.push(
          ...(source.references ?? []).map((r) => ({
            ...r,
            ...(r.yMm === undefined ? {} : { yMm: r.yMm + offset }),
            zone:
              r.xMm === undefined || r.yMm === undefined
                ? r.zone
                : zone(r.xMm, r.yMm + offset, b),
          })),
        );
        draft.rootedShapes.push(
          ...(source.rootedShapes ?? []).map((s) => ({
            ...s,
            y: s.y + offset,
          })),
        );
        if (source.rootedInk)
          inks.push({ ...source.rootedInk, y: source.rootedInk.y + offset });
        offset += heights[i]! + 14;
      }
      const ink = unionInk(inks);
      if (ink) draft.rootedInk = ink;
      return draft;
    });
    return folded;
  }
  // If packing is not possible, keep the untrimmed draft geometry/references.
  return untrimmed;
}

function scopedSection(content: string, index: number): string {
  return content.replace(/<[^>]+>/gu, (tag) =>
    tag
      .replace(
        /(?<=\s)id="([^"]+)"/gu,
        (_, id: string) => `id="section-${index}-${id}"`,
      )
      .replace(
        /(?<=\s)clip-path="url\(#([^)]+)\)"/gu,
        (_, id: string) => `clip-path="url(#section-${index}-${id})"`,
      ),
  );
}

function sectionSpans(
  layout: NormalizedSchematicLayout,
  x0: number,
  x1: number,
) {
  const spans: { y: number; h: number }[] = [];
  for (const box of [
    ...layout.nodes.filter((n) => n.kind !== "location"),
    ...layout.labels,
  ]) {
    if (box.x < x1 && box.x + box.width > x0)
      spans.push({ y: box.y, h: box.height });
  }
  for (const edge of layout.edges)
    for (let i = 1; i < edge.points.length; i++) {
      const a = required(edge.points[i - 1], "Missing route point"),
        z = required(edge.points[i], "Missing route point");
      if (Math.max(a.x, z.x) >= x0 && Math.min(a.x, z.x) <= x1)
        spans.push({ y: Math.min(a.y, z.y), h: Math.abs(a.y - z.y) });
    }
  return spans;
}
