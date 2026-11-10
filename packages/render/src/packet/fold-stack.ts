import { sumContent } from "./rooted-content.js";
import { required } from "../presentation/util.js";
import type { Draft, DrawingBounds } from "./types.js";
import { unionInk } from "./rooted-ink.js";
import { zone } from "./page.js";
import { n } from "./svg.js";

export const SECTION_GAP = 14;
export function sectionGroups(heights: readonly number[], available: number) {
  const groups: number[][] = [];
  let used = 0;
  heights.forEach((h, i) => {
    if (!groups.length || used + h + SECTION_GAP > available) {
      groups.push([i]);
      used = h;
    } else {
      required(groups.at(-1), "Missing fold group").push(i);
      used += SECTION_GAP + h;
    }
  });
  return groups;
}
function scopedSection(content: string, index: number) {
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
function append(
  draft: Draft,
  source: Draft,
  index: number,
  offset: number,
  destinations: Map<number, number>,
  b: DrawingBounds,
) {
  draft.content += `<g transform="translate(0 ${n(offset)})">${scopedSection(source.content, index)}</g>`;
  draft.links.push(
    ...source.links.map((l) => ({
      ...l,
      to: required(destinations.get(l.to), "Missing folded destination"),
      y: l.y + offset,
    })),
  );
  draft.references?.push(
    ...(source.references ?? []).map((r) => ({
      ...r,
      ...(r.yMm === undefined ? {} : { yMm: r.yMm + offset }),
      zone:
        r.xMm === undefined || r.yMm === undefined
          ? r.zone
          : zone(r.xMm, r.yMm + offset, b),
    })),
  );
  draft.rootedCaptionInk?.push(
    ...(source.rootedCaptionInk ?? []).map((s) => ({ ...s, y: s.y + offset })),
  );
  draft.rootedShapes?.push(
    ...(source.rootedShapes ?? []).map((s) => ({ ...s, y: s.y + offset })),
  );
}
export function stackSections(
  drafts: readonly Draft[],
  heights: readonly number[],
  groups: readonly number[][],
  b: DrawingBounds,
) {
  const destinations = new Map(
    groups.flatMap((g, i) => g.map((n) => [n + 1, i + 1] as const)),
  );
  return groups.map((group) => {
    const first = required(
      drafts[required(group[0], "Missing fold index")],
      "Missing fold source",
    );
    const sources = group.map((i) =>
      required(drafts[i], "Missing fold source"),
    );
    const draft: Draft = {
      ...first,
      rootedContent: sumContent(sources),
      rootedSections: sources.flatMap((s) => s.rootedSections ?? []),
      content: "",
      links: [],
      references: [],
      note: "Folded circuit sections; follow paired conductor references.",
      drawingBounds: b,
      rootedShapes: [],
      rootedCaptionInk: [],
    };
    let offset = 0;
    for (const i of group) {
      append(
        draft,
        required(drafts[i], "Missing fold source"),
        i,
        offset,
        destinations,
        b,
      );
      offset += required(heights[i], "Missing strip height") + SECTION_GAP;
    }
    const ink = unionInk(draft.rootedShapes ?? []);
    if (ink) draft.rootedInk = ink;
    return draft;
  });
}
