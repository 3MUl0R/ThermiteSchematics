import type { ElectricalIr } from "@thermite/compiler";
import type {
  AnnotationReservation,
  PlacedOccurrence,
  NavigationAnnotation,
  IssuedNavigation,
} from "./navigation-types.js";
import { navigationHash } from "./navigation-identity.js";
import { compareText } from "../ordering.js";
import { required } from "../presentation/util.js";
import {
  distinctDestinations,
  labelLines,
  maximumRepeatForms,
  maximumToken,
  repeatNoun,
} from "./navigation-labels.js";
export { NAVIGATION_FONT_MM } from "./navigation-labels.js";
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
interface LabelMember {
  owner: PlacedOccurrence;
  canonical: PlacedOccurrence;
  targets: PlacedOccurrence[];
  count: number;
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
    labels = new Map<string, LabelMember[]>();
  for (const [key, appearances] of byFunction) {
    if (appearances.length < 2) continue;
    const sorted = appearances.slice().sort(readingOrder),
      canonical = required(sorted[0], "Missing canonical occurrence");
    const count = maximumCounts.get(key) ?? sorted.length;
    groups.push({
      source: canonical.source,
      canonical: canonical.id,
      occurrences: sorted.map((o) => o.id),
    });
    for (const owner of sorted) {
      const symbol = JSON.stringify([
        owner.source.deviceUid,
        owner.destination.sheet,
        owner.provenance.symbolKey,
      ]);
      labels.set(symbol, [
        ...(labels.get(symbol) ?? []),
        {
          owner,
          canonical,
          targets: owner === canonical ? sorted.slice(1) : [canonical],
          count,
        },
      ]);
    }
  }
  const planned = [...labels.values()].map((members) =>
    groupedLabel(ir, members),
  );
  return {
    groups,
    reservations: planned.map((p) => p.reservation),
    annotations: planned.map((p) => p.annotation),
  };
}
function groupedLabel(ir: Readonly<ElectricalIr>, members: LabelMember[]) {
  members.sort((a, b) =>
    compareText(a.owner.source.functionKey, b.owner.source.functionKey),
  );
  const owner = required(members[0], "Missing symbol owner").owner;
  const tag = required(
    ir.devices.find((d) => d.uid === owner.source.deviceUid),
    "Missing repeat device",
  ).designation;
  const noun = repeatNoun(
    ir,
    members.map((m) => m.owner),
  );
  const count = members.reduce((n, m) => n + m.count - 1, 0);
  const token = maximumToken();
  const maximum = maximumRepeatForms(
    tag,
    noun,
    members.map((m) => m.count),
    token,
  );
  const { also, repeats, lines } = groupedText(members, tag, noun);
  const owners = members.map((m) => m.owner.id);
  const id = `navigation/2/${navigationHash(owners)}`;
  const reservation: AnnotationReservation = {
    id,
    ownerAppearance: owner.appearance,
    ownerOccurrence: owner.id,
    profileId: `repeat-max-roles/2/${count}/${members.length}`,
    space: "sheet-slot",
    inkMm: { x: 0, y: 0, w: maximum.w, h: maximum.h },
    maximumForms: maximum.forms,
    shapes: maximum.shapes,
  };
  const annotation: NavigationAnnotation = {
    id,
    ownerOccurrence: owner.id,
    ownerOccurrences: owners,
    role:
      also.length && repeats.length
        ? "mixed"
        : also.length
          ? "canonical"
          : "repeat",
    targets: [...new Set(members.flatMap((m) => m.targets.map((o) => o.id)))],
    text: lines.join("\n"),
    primitiveIds: [`${id}/ink`],
    reservationId: id,
  };
  return { reservation, annotation };
}

function groupedText(
  members: readonly LabelMember[],
  tag: string,
  noun: string,
) {
  const also = members
    .filter((m) => m.owner === m.canonical)
    .flatMap((m) => m.targets);
  const repeats = members
    .filter((m) => m.owner !== m.canonical)
    .flatMap((m) => m.targets);
  const prefix = `${tag}: `,
    lines: string[] = [];
  if (also.length)
    lines.push(
      labelLines(prefix, "Also shown", distinctDestinations(also)).join(" "),
    );
  if (repeats.length)
    lines.push(
      labelLines(
        also.length ? "" : prefix,
        "Repeat of",
        distinctDestinations(repeats),
        ` (same ${noun})`,
      ).join(" "),
    );
  return { also, repeats, lines };
}
