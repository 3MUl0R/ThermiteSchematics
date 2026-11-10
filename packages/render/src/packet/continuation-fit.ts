import { required } from "../presentation/util.js";
import { packContinuationLabels } from "./continuation-pack.js";
import {
  continuationPackingConstraint,
  continuationShortfall,
} from "./continuation-constraint.js";
import type { Draft, PaperPage } from "./types.js";
import type { ContinuationBank } from "./continuation-bank.js";
import { continuationLabel } from "./continuation-label.js";
import { inkOverlaps, textInk } from "./rooted-caption.js";
import { bounds } from "./page.js";
import { rootedNoticeLines, rootedSheetView } from "../off-view/notice.js";
import type { InkBox } from "./rooted-ink.js";

const near = (a: InkBox, b: InkBox) =>
  inkOverlaps(
    { x: a.x - 0.999, y: a.y - 0.999, w: a.w + 1.998, h: a.h + 1.998 },
    b,
  );
function fixedInk(d: Draft, page: PaperPage, native: boolean): InkBox[] {
  const b = d.drawingBounds ?? bounds(d.title, page),
    m = page.marginMm,
    v = rootedSheetView(d.view);
  const result = [...(d.rootedCaptionInk ?? [])];
  if (v && !native)
    rootedNoticeLines(v, page.widthMm - 2 * m - 36, 2.7).forEach((l, i) =>
      result.push(textInk(l.text, m + 18, m + 19 + 4 * i, 2.7, l.bold)),
    );
  for (let col = 0; col < 6; col++)
    result.push(
      textInk(
        String(col + 1),
        b.x + (b.w * (col + 0.5)) / 6,
        m + 12,
        2.2,
        false,
        "middle",
      ),
    );
  for (let row = 0; row < 4; row++)
    result.push(
      textInk(
        required("ABCD"[row], "Missing zone row"),
        m + 3,
        b.y + (b.h * (row + 0.5)) / 4,
        2.2,
      ),
    );
  return result;
}
/** Validate reserved physical ink after cropping/folding, before picking a grid. */
export function fitContinuations(
  drafts: Draft[],
  page: PaperPage,
  bank: ContinuationBank,
  native = false,
): string | undefined {
  for (const d of drafts) {
    for (const l of d.links)
      l.label = continuationLabel(l, bank.width, bank.headerWidth, bank.single);
    if (!packContinuationLabels(d))
      return continuationPackingConstraint(d.links);
    const frame = page.marginMm + 1.2,
      footer = bounds(d.title, page),
      bottom = footer.y + footer.h + 14 - 1.2;
    const occupied = [...fixedInk(d, page, native), ...(d.rootedShapes ?? [])];
    const labels: InkBox[] = [];
    for (const l of d.links) {
      const box = required(l.label, "Missing continuation label").bounds;
      const short = Math.max(
        frame - box.x,
        box.x + box.w - (page.widthMm - frame),
        frame - box.y,
        box.y + box.h - bottom,
      );
      if (short > 0.001)
        return `Continuation ${l.id} (${l.conductor}) needs ${box.w.toFixed(2)} × ${box.h.toFixed(2)} mm at the ${l.side} cut; sheet clearance is short by ${short.toFixed(2)} mm. Use a larger sheet, landscape or another flow.`;
      if (
        required(l.label, "Missing continuation label").rows.some(
          (r) =>
            occupied.some((o) => near(r.ink, o)) ||
            labels.some((o) => near(r.ink, o)),
        )
      )
        return `Continuation ${l.id} (${l.conductor}) cannot keep 1 mm clear ink at the ${l.side} cut (${box.w.toFixed(2)} × ${box.h.toFixed(2)} mm), short by ${continuationShortfall(
          required(l.label, "Missing label").rows.map((r) => r.ink),
          [...occupied, ...labels],
        ).toFixed(2)} mm. Use a larger sheet, landscape or another flow.`;
      labels.push(
        ...required(l.label, "Missing continuation label").rows.map(
          (r) => r.ink,
        ),
      );
    }
  }
  return undefined;
}
