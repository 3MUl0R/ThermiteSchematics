import { fallbackOf, valuesOf } from "./health-budget.mjs";
import { lineAdditions } from "./health-continuity.mjs";
import { currentOwners } from "./health-owners.mjs";

// A continuation can be one rename or several parts. Each part must retain
// at least a fifth of the old normalized lines; together they retain four
// fifths. Multiset intersections consume occurrences, including repeated lines.
export const RENAME_PART_SHARE = Object.freeze({
  numerator: 1,
  denominator: 5,
});
export const RENAME_RETAINED_SHARE = Object.freeze({
  numerator: 4,
  denominator: 5,
});
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const covers = (common, total, share) =>
  common * share.denominator >= total * share.numerator;

function continuationRows(section, current, reference) {
  const base = reference.metrics,
    before = reference.budget,
    values = valuesOf(current, section),
    oldValues = valuesOf(base, section),
    field = section === "files" ? "fileLines" : "bodyLines",
    hashes = section === "files" ? "fileHashes" : "bodyHashes",
    newBodies = Object.entries(current[field] ?? {})
      .filter(([key]) => !Object.hasOwn(oldValues, key))
      .sort(([a], [b]) => compare(a, b));
  const rows = [];
  for (const [from, limit] of Object.entries(before[section]).sort(([a], [b]) =>
    compare(a, b),
  )) {
    const old = base[field]?.[from];
    if (Object.hasOwn(values, from) || !old?.length) continue;
    for (const [key, lines] of newBodies) {
      const { common, added } = lineAdditions(old, lines);
      if (covers(common, old.length, RENAME_PART_SHARE))
        rows.push({
          id: from,
          from,
          key,
          limit,
          common,
          added,
          exact: base[hashes][from] === current[hashes][key],
        });
    }
  }
  return rows.sort(
    (a, b) =>
      b.common - a.common ||
      a.added - b.added ||
      Number(b.exact) - Number(a.exact) ||
      compare(a.id, b.id) ||
      compare(a.key, b.key),
  );
}

function contains(current, outer, inner) {
  const a = current.bodyRanges?.[outer],
    b = current.bodyRanges?.[inner];
  return (
    outer !== inner &&
    outer.split("#", 1)[0] === inner.split("#", 1)[0] &&
    a &&
    b &&
    a[0] <= b[0] &&
    a[1] >= b[1]
  );
}

export function sizeContinuations(section, current, reference) {
  if (!reference) return [];
  const rows = continuationRows(section, current, reference),
    owners =
      section === "functions"
        ? currentOwners(rows, current, reference.metrics)
        : new Map(),
    field = section === "files" ? "fileLines" : "bodyLines",
    groups = [];
  for (const from of [...new Set(rows.map((r) => r.from))].sort(compare)) {
    const parts = rows.filter(
      (r) =>
        r.from === from && (!owners.has(r.key) || owners.get(r.key) === from),
    );
    const targets = parts
      .filter(
        (r) =>
          section === "files" ||
          !parts.some((other) => contains(current, other.key, r.key)),
      )
      .map((r) => r.key)
      .sort(compare);
    const old = reference.metrics[field][from],
      retained = lineAdditions(
        old,
        targets.flatMap((key) => current[field][key]),
      );
    if (covers(retained.common, old.length, RENAME_RETAINED_SHARE))
      groups.push({
        section,
        from,
        limit: reference.budget[section][from],
        oldLines: old.length,
        retained: retained.common,
        targets,
      });
  }
  return groups;
}

export function renameRegressions(current, budget, reference) {
  const errors = [];
  for (const section of ["files", "functions"]) {
    const values = valuesOf(current, section);
    for (const group of sizeContinuations(section, current, reference)) {
      // Retained stale source records consume credit too. Every group is
      // checked independently: ambiguous origins cannot pool extra credit.
      const remaining = budget[section][group.from] ?? 0,
        claimed = group.targets.reduce(
          (n, key) =>
            n +
            (budget[section][key] ??
              (values[key] > fallbackOf(budget, section) ? values[key] : 0)),
          remaining,
        );
      if (claimed > group.limit)
        errors.push(
          `Allowance cannot rise through rename: ${section}:${group.from} ${group.limit} -> ${claimed} shared by ${group.targets.join(", ")}${remaining ? " (source allowance retained)" : ""}`,
        );
    }
  }
  return errors;
}
