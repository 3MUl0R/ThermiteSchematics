import { pinnedMetrics } from "../off-view/metrics.js";
import { rootedNoticeLines } from "../off-view/notice.js";
import type { NormalizedSchematicView } from "../types.js";
import type { DrawingBounds, Link, PaperPage } from "./types.js";

export function textInk(
  value: string,
  x: number,
  y: number,
  size: number,
  bold = false,
  anchor = "start",
) {
  const m = pinnedMetrics(value, size, bold);
  const start =
    x -
    (anchor === "middle" ? m.advance / 2 : anchor === "end" ? m.advance : 0);
  return {
    x: start + m.left,
    y: y - m.top,
    w: m.right - m.left,
    h: m.top - m.bottom,
  };
}
type Ink = ReturnType<typeof textInk>;
export function inkOverlaps(a: Ink, b: Ink) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

/** The caption has its own lane between the complete notice and top links. */
export function captionConstraint(
  caption: string,
  b: DrawingBounds,
  page: PaperPage,
  view: NormalizedSchematicView,
  links: readonly Link[],
  captionY = b.y - 9,
) {
  if (!caption) return undefined;
  const ink = textInk(caption, b.x, captionY, 2.5);
  const shortfall = Math.max(b.x - ink.x, ink.x + ink.w - b.x - b.w);
  if (shortfall > 0.001)
    return `Continued-location caption exceeds its header width by ${shortfall.toFixed(2)} mm. Use a larger sheet or landscape.`;
  const notices = rootedNoticeLines(
    view,
    page.widthMm - 2 * page.marginMm - 36,
    2.7,
  ).map((l, i) =>
    textInk(
      l.text,
      page.marginMm + 18,
      page.marginMm + 19 + 4 * i,
      2.7,
      l.bold,
    ),
  );
  const captions = links.flatMap((l) => l.label?.rows.map((r) => r.ink) ?? []);
  if ([...notices, ...captions].some((other) => inkOverlaps(ink, other)))
    return "Continued-location caption ink overlaps the notice or a continuation. Use a larger sheet or landscape.";
  return undefined;
}
