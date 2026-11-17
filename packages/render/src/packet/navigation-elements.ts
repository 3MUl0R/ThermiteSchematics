import type { ElectricalIr } from "@thermite/compiler";
import type { PlacedOccurrence } from "./navigation-types.js";
import type { RepeatPlan } from "./navigation-repeats.js";
import { printedFunction } from "../print-projection.js";
import { sameFunction } from "./mirror-facts.js";
import { navigationHash } from "./navigation-identity.js";
import { required } from "../presentation/util.js";
import {
  distinctDestinations,
  envelopeShapes,
  maximumToken,
} from "./navigation-labels.js";

/** A shared native device establishes location, never actuation or continuity. */
export function planElementNavigation(
  ir: Readonly<ElectricalIr>,
  all: readonly PlacedOccurrence[],
): RepeatPlan {
  const plan: RepeatPlan = { groups: [], annotations: [], reservations: [] };
  const roles = new Map(
    ir.functions.map((f) => {
      const device = ir.devices.find((d) => d.uid === f.id.deviceUid);
      return [
        JSON.stringify(f.id),
        printedFunction(
          f,
          ir.deviceTypes.find((t) => t.id === device?.typeId),
        ),
      ];
    }),
  );
  const power = (o: PlacedOccurrence) =>
    /^(Overload element|Breaker pole|Fuse element)\b/.test(
      roles.get(JSON.stringify(o.source)) ?? "",
    );
  const contact = (o: PlacedOccurrence) =>
    /^(NO|NC) contact\b/.test(roles.get(JSON.stringify(o.source)) ?? "");
  const groups = new Map<
    string,
    {
      owner: PlacedOccurrence;
      targets: PlacedOccurrence[];
      members: PlacedOccurrence[];
    }
  >();
  for (const owner of all) {
    if (owner.role !== "full-function" || (!power(owner) && !contact(owner)))
      continue;
    const targets = all.filter(
      (o) =>
        o.role === "full-function" &&
        o.source.deviceUid === owner.source.deviceUid &&
        !sameFunction(o.source, owner.source) &&
        (power(owner) ? contact(o) : power(o)),
    );
    if (!targets.length) continue;
    const key = JSON.stringify([
      owner.source.deviceUid,
      owner.destination.sheet,
      owner.provenance.view.key,
      targets.map((o) => o.id),
    ]);
    const group = groups.get(key) ?? { owner, targets, members: [] };
    group.members.push(owner);
    groups.set(key, group);
  }
  for (const { owner, targets, members } of groups.values())
    addElementLabel(plan, ir, owner, targets, roles, members);
  return plan;
}
function addElementLabel(
  plan: RepeatPlan,
  ir: Readonly<ElectricalIr>,
  owner: PlacedOccurrence,
  targets: PlacedOccurrence[],
  roles: ReadonlyMap<string, string>,
  members: readonly PlacedOccurrence[],
) {
  const tag = required(
    ir.devices.find((d) => d.uid === owner.source.deviceUid),
    "Missing element device",
  ).designation;
  const byFunction = new Map<string, PlacedOccurrence[]>();
  for (const target of targets) {
    const key = JSON.stringify(target.source);
    byFunction.set(key, [...(byFunction.get(key) ?? []), target]);
  }
  const lines = (maximum: boolean) =>
    [...byFunction]
      .map(
        ([key, members]) =>
          `${roles.get(key)} → ${(maximum ? members.map(() => maximumToken()) : distinctDestinations(members)).join(", ")}`,
      )
      .join("\n");
  const shapes = (["local", "self-located"] as const).flatMap((mode) =>
    envelopeShapes(mode, [
      `${tag}${mode === "local" ? "" : ` (${maximumToken()})`}: ${lines(true)}`,
    ]),
  );
  const first = required(shapes[0], "Missing element envelope");
  const id = `element-location/1/${navigationHash(owner.id)}`;
  plan.reservations.push({
    id,
    ownerAppearance: owner.appearance,
    ownerOccurrence: owner.id,
    profileId: "same-device-elements/1",
    space: "sheet-slot",
    inkMm: first.inkMm,
    maximumForms: first.maximumForms,
    shapes,
  });
  plan.annotations.push({
    id,
    ownerOccurrence: owner.id,
    ownerOccurrences: members.map((o) => o.id),
    role: "element-location",
    targets: targets.map((o) => o.id),
    text: `${tag}: ${lines(false)}`,
    primitiveIds: [`${id}/ink`],
    reservationId: id,
  });
}
