import { INK_ACCURACY_MM } from "./checks.mjs";
import { printedZones } from "./printed-zones.mjs";
import { reportIssue as issue } from "./report-checks.mjs";

/** Non-zone body text must stay right of the measured zone boundary (tolerance
 * = INK_ACCURACY_MM = 0.17 mm). Continuation-bank labels clear the zone-letter
 * column; rooted notices above zone row A and legends in explicit left banks
 * stay right of the left zone-letter gutter. */
export function textInZoneGutter(g) {
  const zones = printedZones(g);
  if (
    !g.frame ||
    !g.headerRule ||
    zones.numbers.length < 2 ||
    zones.letters.length < 2
  )
    return [];
  const colW =
    (zones.numbers.at(-1).anchor.x - zones.numbers[0].anchor.x) /
    (zones.numbers.length - 1);
  const rowH =
    (zones.letters.at(-1).anchor.y - zones.letters[0].anchor.y) /
    (zones.letters.length - 1);
  if (colW <= 0 || rowH <= 0) return [];
  const fieldLeft = zones.numbers[0].anchor.x - colW / 2;
  const fieldRight = zones.numbers.at(-1).anchor.x + colW / 2;
  const fieldTop = zones.letters[0].anchor.y - rowH / 2;
  const fieldBottom = zones.letters.at(-1).anchor.y + rowH / 2;
  const zoneLetterRight = Math.max(
    ...zones.letters.map((t) => t.bbox.x + t.bbox.w),
  );
  const leftBanked = fieldLeft > g.frame.x + 20;
  const gutterRight = Math.min(fieldLeft, g.frame.x + 18);
  const zoneSet = new Set([...zones.numbers, ...zones.letters]);
  const isZoneMark = (t) =>
    zoneSet.has(t) ||
    (t.sheetText &&
      !t.nested &&
      !t.deviceUid &&
      !t.wire &&
      !t.row &&
      !t.continuation &&
      t.tagField == null &&
      ((/^[1-9]\d*$/.test(t.text) && t.bbox.y >= fieldBottom - INK_ACCURACY_MM) ||
        (/^[A-Z]+$/.test(t.text) && t.bbox.x >= fieldRight - INK_ACCURACY_MM)));
  const out = [];
  for (const t of g.texts) {
    if (t.painted === false || !t.bbox || isZoneMark(t)) continue;
    if (t.bbox.y + t.bbox.h <= g.headerRule.y + INK_ACCURACY_MM) continue;
    if (g.titleBlock && t.bbox.y >= g.titleBlock.y - INK_ACCURACY_MM) continue;
    if (t.bbox.y >= fieldBottom - INK_ACCURACY_MM) continue;
    let limit = fieldLeft;
    if (t.continuation) limit = zoneLetterRight + 1;
    else if (
      t.bbox.y + t.bbox.h <= fieldTop + INK_ACCURACY_MM ||
      (leftBanked && t.tagKind === "legend")
    )
      limit = gutterRight;
    if (t.bbox.x < limit - INK_ACCURACY_MM)
      out.push(
        issue("text-in-zone-gutter", t, {
          text: t.text,
          leftMm: t.bbox.x,
          fieldLeftMm: limit,
          intrusionMm: limit - t.bbox.x,
          toleranceMm: INK_ACCURACY_MM,
        }),
      );
  }
  return out;
}
