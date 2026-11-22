import { INK_ACCURACY_MM, overlap } from "./checks.mjs";
import { reportIssue as issue } from "./report-checks.mjs";

export const HEADING_CLEARANCE_MM = 1.5;
// Numerical & SVG-to-mm serialization epsilon only (<= 0.01 mm; never a drafting allowance).
export const HEADING_CLEARANCE_EPSILON_MM = 0.01;

function horizontalOverlap(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);
}

function verticalGap(a, b) {
  return Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
}

function checkHeadingAgainst(heading, others, out) {
  for (const other of others) {
    if (!other.bbox || !horizontalOverlap(heading.bbox, other.bbox)) continue;
    const gap = verticalGap(heading.bbox, other.bbox);
    if (gap < HEADING_CLEARANCE_MM - HEADING_CLEARANCE_EPSILON_MM)
      out.push(
        issue("heading-clearance-violation", heading, {
          text: heading.text,
          otherElement: other.element,
          ...(other.text ? { otherText: other.text } : {}),
          gapMm: gap,
          minimumMm: HEADING_CLEARANCE_MM,
          toleranceMm: HEADING_CLEARANCE_EPSILON_MM,
        }),
      );
  }
}

export function headingClearanceFindings(g) {
  const out = [];
  const painted = (g.texts ?? []).filter((t) => t.painted !== false && t.bbox);
  for (const t of painted) {
    if (t.text.startsWith("CONTINUED LOCATION:")) {
      const others = painted.filter((o) => o !== t);
      checkHeadingAgainst(t, others, out);
    } else if (t.documentId && (t.fontSize ?? 0) >= 3.5) {
      const others = [
        ...painted.filter((o) => o !== t && o.documentId !== t.documentId),
        ...(g.assemblyLabelPlates ?? []),
      ];
      checkHeadingAgainst(t, others, out);
    }
  }
  return out;
}

export function legendOutsideLocationFindings(g) {
  const out = [];
  const frames = g.locationFrames ?? [];
  if (!frames.length) return out;
  const legendItems = [
    ...(g.legendBoxes ?? []).map((b) => ({ item: b, kind: "plate" })),
    ...(g.texts ?? [])
      .filter(
        (t) =>
          t.painted !== false &&
          t.bbox &&
          (t.inDeviceLegend || t.tagKind === "legend"),
      )
      .map((t) => ({ item: t, kind: "ink" })),
  ];
  const seen = new Set();
  for (const { item, kind } of legendItems) {
    for (const loc of frames) {
      if (overlap(item.bbox, loc.bbox, 0)) {
        const key = `${item.element}:${loc.element}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          issue("legend-inside-location-frame", item, {
            overlapKind: kind,
            locationElement: loc.element,
            locationBbox: loc.bbox,
          }),
        );
      }
    }
  }
  return out;
}

export function locationFragmentCaptionFindings(g) {
  const out = [];
  for (const loc of g.locationFrames ?? []) {
    if (loc.occupied && !loc.hasLocalCaption)
      out.push(
        issue("unlabeled-location-fragment", loc, {
          locationElement: loc.element,
          ...(loc.locationName !== undefined
            ? { locationName: loc.locationName }
            : {}),
          ...(loc.foundCaptions !== undefined
            ? { foundCaptions: loc.foundCaptions }
            : {}),
        }),
      );
  }
  return out;
}

export function wireOwnershipReason(d, other, inline) {
  if (other + INK_ACCURACY_MM < d) return "nearer-foreign-wire";
  if (!inline && d > 0 && other < d + 0.5 - INK_ACCURACY_MM)
    return "foreign-wire-ownership-margin";
  if (d > 2 + INK_ACCURACY_MM) return "own-wire-distance";
  return null;
}
