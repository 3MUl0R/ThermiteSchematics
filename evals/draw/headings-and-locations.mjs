import { INK_ACCURACY_MM, overlap } from "./checks.mjs";
import { reportIssue as issue } from "./report-checks.mjs";

export const HEADING_CLEARANCE_MM = 1.5;

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
    if (gap < HEADING_CLEARANCE_MM - INK_ACCURACY_MM)
      out.push(
        issue("heading-clearance-violation", heading, {
          text: heading.text,
          otherElement: other.element,
          ...(other.text ? { otherText: other.text } : {}),
          gapMm: gap,
          minimumMm: HEADING_CLEARANCE_MM,
          toleranceMm: INK_ACCURACY_MM,
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
  for (const legend of g.legendBoxes ?? []) {
    for (const loc of g.locationFrames ?? []) {
      if (overlap(legend.bbox, loc.bbox, INK_ACCURACY_MM))
        out.push(
          issue("legend-inside-location-frame", legend, {
            locationElement: loc.element,
            locationBbox: loc.bbox,
          }),
        );
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
