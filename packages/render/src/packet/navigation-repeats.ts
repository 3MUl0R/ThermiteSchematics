import type { ElectricalIr } from "@thermite/compiler";
import type {
  AnnotationReservation,
  PlacedOccurrence,
  NavigationAnnotation,
  IssuedNavigation,
} from "./navigation-types.js";
import { printableTextMetrics } from "../symbols/printable-font.js";
import { destinationToken } from "./navigation-location.js";
import { navigationHash } from "./navigation-identity.js";
import { compareText } from "../ordering.js";
import { required } from "../presentation/util.js";
export const NAVIGATION_FONT_MM = 3.502;
const measure = (s: string) => {
  const m = printableTextMetrics(s, NAVIGATION_FONT_MM);
  return Math.max(m.advance, m.right) - Math.min(m.left, 0);
};
// All 1–100 sheet tokens, including the widest zone glyph; never size to this pass's destinations.
let widestToken: string | undefined;
const maximumToken = () =>
  (widestToken ??= Array.from({ length: 100 }, (_, i) =>
    "ABCD"
      .split("")
      .flatMap((r) =>
        Array.from({ length: 6 }, (_, c) =>
          destinationToken({ sheet: i + 1, zone: `${r}${c + 1}` }),
        ),
      ),
  )
    .flat()
    .reduce((a, b) => (measure(a) >= measure(b) ? a : b)));
export interface RepeatPlan {
  groups: IssuedNavigation["canonicalGroups"];
  reservations: AnnotationReservation[];
  annotations: NavigationAnnotation[];
}
const readingOrder = (a: PlacedOccurrence, b: PlacedOccurrence) =>
  a.provenance.view.authoredOrder - b.provenance.view.authoredOrder ||
  a.destination.sheet - b.destination.sheet ||
  compareText(a.destination.zone, b.destination.zone) ||
  a.destination.anchorMm.y - b.destination.anchorMm.y ||
  a.destination.anchorMm.x - b.destination.anchorMm.x ||
  compareText(a.appearance, b.appearance);
function maximumRepeatForms(
  ir: Readonly<ElectricalIr>,
  canonical: PlacedOccurrence,
  count: number,
  token: string,
) {
  const fn = required(
    ir.functions.find(
      (f) =>
        f.id.deviceUid === canonical.source.deviceUid &&
        f.id.functionKey === canonical.source.functionKey,
    ),
    "Missing repeat source",
  );
  const designation = required(
    ir.devices.find((d) => d.uid === fn.id.deviceUid),
    "Missing repeat device",
  ).designation;
  const noun = fn.kind === "contact" ? "contact" : "function";
  // Ownership remains legible even when the nearest vacant slot lies beyond the frame.
  const prefix = `${designation}: `;
  const maxCanonical = canonicalLines(
    prefix,
    Array.from({ length: count - 1 }, () => token),
  );
  const maxRepeat = `${prefix}Repeat of ${token} (same ${noun})`;
  const w =
    Math.ceil(
      Math.max(measure(maxRepeat), ...maxCanonical.map(measure)) * 1000,
    ) /
      1000 +
    2;
  const h = Math.max(1, maxCanonical.length) * 4.8 + 1;
  return { prefix, noun, maxCanonical, maxRepeat, w, h };
}

export function planRepeatNavigation(
  ir: Readonly<ElectricalIr>,
  occurrences: readonly PlacedOccurrence[],
  maximumCounts: ReadonlyMap<string, number> = new Map(),
): RepeatPlan {
  const byFunction = new Map<string, PlacedOccurrence[]>();
  for (const o of occurrences)
    if (o.role === "full-function") {
      const key = JSON.stringify([o.source.deviceUid, o.source.functionKey]);
      byFunction.set(key, [...(byFunction.get(key) ?? []), o]);
    }
  const groups: RepeatPlan["groups"][number][] = [],
    reservations: AnnotationReservation[] = [],
    annotations: NavigationAnnotation[] = [];
  if (![...byFunction.values()].some((g) => g.length > 1))
    return { groups, reservations, annotations };
  const token = maximumToken();
  for (const appearances of byFunction.values()) {
    if (appearances.length < 2) continue;
    const sorted = appearances.slice().sort(readingOrder),
      canonical = required(sorted[0], "Missing canonical occurrence");
    const { prefix, noun, maxCanonical, maxRepeat, w, h } = maximumRepeatForms(
      ir,
      canonical,
      maximumCounts.get(
        JSON.stringify([
          canonical.source.deviceUid,
          canonical.source.functionKey,
        ]),
      ) ?? sorted.length,
      token,
    );
    groups.push({
      source: canonical.source,
      canonical: canonical.id,
      occurrences: sorted.map((o) => o.id),
    });
    for (const owner of sorted) {
      const id = `navigation/1/${navigationHash(owner.id)}`;
      const targets = owner === canonical ? sorted.slice(1) : [canonical];
      const lines =
        owner === canonical
          ? canonicalLines(
              prefix,
              targets.map((o) => destinationToken(o.destination)),
            )
          : [
              `${prefix}Repeat of ${destinationToken(canonical.destination)} (same ${noun})`,
            ];
      reservations.push({
        id,
        ownerAppearance: owner.appearance,
        profileId: `repeat-max-roles/1/${sorted.length}`,
        space: "sheet-slot",
        inkMm: { x: 0, y: 0, w, h },
        maximumForms: [maxCanonical.join("\n"), maxRepeat],
      });
      annotations.push({
        id,
        ownerOccurrence: owner.id,
        role: owner === canonical ? "canonical" : "repeat",
        targets: targets.map((o) => o.id),
        text: lines.join("\n"),
        primitiveIds: [`${id}/ink`],
        reservationId: id,
      });
    }
  }
  return { groups, reservations, annotations };
}

function canonicalLines(prefix: string, tokens: readonly string[]) {
  return Array.from(
    { length: Math.ceil(tokens.length / 3) },
    (_, i) =>
      `${i === 0 ? `${prefix}Also shown ` : ""}${tokens.slice(i * 3, i * 3 + 3).join("; ")}${i * 3 + 3 < tokens.length ? ";" : ""}`,
  );
}
