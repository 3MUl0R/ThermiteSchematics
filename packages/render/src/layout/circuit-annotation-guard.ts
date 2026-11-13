import type { NavigationAnnotation } from "../packet/navigation-types.js";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const textContent = (s: string) => s.trim().replace(/\s+/gu, " ");
const notFarther = (a: number, b: number) =>
  Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && a <= b + 1e-7;

/** Destinations and located headings follow NAV's final pagination. Source
 * rows, their identities and their electrical facts must remain unchanged. */
function facts(a: NavigationAnnotation) {
  return [
    a.role,
    a.ownerOccurrence,
    a.ownerOccurrences,
    a.targets,
    a.primitiveIds,
    a.gangId,
    a.sourceOrigins,
    a.mirror && {
      coil: a.mirror.coil,
      part: a.mirror.part,
      parts: a.mirror.parts,
      rows: a.mirror.rows.map(({ destinations, ...row }) => row),
    },
  ];
}

function returnDistances(a: NavigationAnnotation, b: NavigationAnnotation) {
  const before = b.returnLocality,
    after = a.returnLocality;
  if (!before || !after || !Number.isInteger(after.sheet) || after.sheet < 1)
    return false;
  const owners = new Map(before.owners.map((o) => [o.occurrenceId, o]));
  const ids = after.owners.map((o) => o.occurrenceId);
  if (
    owners.size !== before.owners.length ||
    new Set(ids).size !== ids.length ||
    !same([...owners.keys()].sort(), [...b.ownerOccurrences].sort()) ||
    !same([...ids].sort(), [...a.ownerOccurrences].sort())
  )
    return false;
  return after.owners.every((o) => {
    const old = owners.get(o.occurrenceId);
    return !!old && notFarther(o.distanceMm, old.distanceMm);
  });
}

/** Consume NAV's issued, final measurements, never allocator families or boxes.
 * The printed-ink nearest-frame margin remains entirely NAV's policy. */
export function circuitAnnotationGuard(
  candidate: NavigationAnnotation,
  original: NavigationAnnotation,
) {
  if (!same(facts(candidate), facts(original))) return false;
  const a = candidate.locality,
    b = original.locality;
  if (!!a !== !!b) return false;
  if (
    a &&
    b &&
    ((b.mode === "local" && a.mode !== "local") ||
      !notFarther(a.distanceMm, b.distanceMm))
  )
    return false;
  if (candidate.role === "return") return returnDistances(candidate, original);
  if (candidate.returnLocality || original.returnLocality) return false;
  if (["mirror", "canonical", "repeat", "mixed"].includes(candidate.role))
    return !!a && !!b;
  if (["contact-notice", "association-unspecified"].includes(candidate.role))
    return textContent(candidate.text) === textContent(original.text);
  return a ? true : same(candidate, original);
}
