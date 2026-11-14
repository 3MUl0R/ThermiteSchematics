import { sizeKey, valuesOf } from "./health-budget.mjs";
export const CONTINUITY_MAX_ADDED = 70;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fileOf = (key) => key.split("#", 1)[0];
// Count added substantive AST lines. Repeated lines consume base occurrences,
// so copying one retained line hundreds of times does not establish continuity.
export function lineAdditions(a, b) {
  if (!a || !b) return { added: Infinity, common: 0 };
  const counts = new Map();
  for (const hash of a) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  let common = 0;
  for (const hash of b)
    if (counts.get(hash)) {
      common++;
      counts.set(hash, counts.get(hash) - 1);
    }
  return { added: b.length - common, common };
}
export function exactMove(section, key, budget, base, current) {
  const proof = budget.moves[key],
    hashes = section === "files" ? "fileHashes" : "bodyHashes";
  return (
    proof?.section === section &&
    typeof proof.from === "string" &&
    typeof proof.sha256 === "string" &&
    proof.from !== key &&
    Object.hasOwn(base[hashes], proof.from) &&
    Object.hasOwn(current[hashes], key) &&
    !Object.hasOwn(current[hashes], proof.from) &&
    proof.sha256 === base[hashes][proof.from] &&
    proof.sha256 === current[hashes][key]
  );
}
function sourceBody(section, id, before, base) {
  const hashes = section === "files" ? base.fileHashes : base.bodyHashes;
  const key = before.locations[section][id],
    hash = before.fingerprints[section][id];
  if (hashes[key] === hash) return key;
  // A positional insertion can leave the display locator stale. Its fingerprint
  // still resolves the original content, within that file, without name authority.
  if (section === "functions")
    return Object.keys(hashes).find(
      (k) => fileOf(k) === fileOf(key) && hashes[k] === hash,
    );
}
function candidates(section, current, budget, reference) {
  const { budget: before, metrics: base } = reference;
  const values = valuesOf(current, section),
    cap = budget.ceilings[sizeKey(section)],
    rows = [];
  const lines = section === "files" ? "fileLines" : "bodyLines",
    hashes = section === "files" ? "fileHashes" : "bodyHashes";
  for (const [id, limit] of Object.entries(before.grandfathered[section])) {
    if (limit <= cap) continue;
    const from = sourceBody(section, id, before, base);
    if (!from || !Object.hasOwn(base[hashes], from)) continue;
    for (const [key, size] of Object.entries(values)) {
      if (size <= budget.thresholds[sizeKey(section)]) continue;
      const moved =
        exactMove(section, key, budget, base, current) &&
        budget.moves[key].from === from;
      if (
        !moved &&
        (section === "files" ? key !== from : fileOf(key) !== fileOf(from))
      )
        continue;
      const exact = base[hashes][from] === current[hashes][key];
      const { added, common } = exact
        ? { added: 0, common: current[lines]?.[key]?.length ?? 0 }
        : lineAdditions(base[lines]?.[from], current[lines]?.[key]);
      if (added <= CONTINUITY_MAX_ADDED)
        rows.push({ key, id, from, limit, added, common, exact });
    }
  }
  return rows.sort(
    (a, b) =>
      b.common - a.common ||
      a.added - b.added ||
      Number(b.exact) - Number(a.exact) ||
      Number(b.key === b.from) - Number(a.key === a.from) ||
      compare(a.id, b.id) ||
      compare(a.key, b.key),
  );
}
function nestedCandidate(row, other, current) {
  if (other.id !== row.id || other.key === row.key) return false;
  const inner = current.bodyRanges?.[row.key],
    outer = current.bodyRanges?.[other.key];
  return (
    fileOf(row.key) === fileOf(other.key) &&
    inner &&
    outer &&
    outer[0] <= inner[0] &&
    outer[1] >= inner[1]
  );
}
function releaseMatches(section, current, budget, reference) {
  const result = {},
    values = valuesOf(current, section),
    before = reference.budget;
  for (const [id, limit] of Object.entries(before.grandfathered[section])) {
    const key = budget.locations[section][id],
      from = before.locations[section][id];
    if (
      limit <= budget.ceilings[sizeKey(section)] ||
      !Object.hasOwn(budget.grandfathered[section], id) ||
      !Object.hasOwn(values, key) ||
      result[key]
    )
      continue;
    // Release compares the admitted entry's value, not cumulative dev edits.
    // Moving that entry across files still requires the existing exact proof.
    if (
      (section === "files" ? key !== from : fileOf(key) !== fileOf(from)) &&
      !(
        exactMove(section, key, budget, reference.metrics, current) &&
        budget.moves[key].from === from
      )
    )
      continue;
    result[key] = { id, key, from, limit };
  }
  return result;
}
export function allowanceMatches(current, budget, reference) {
  const result = { files: {}, functions: {} };
  for (const section of ["files", "functions"]) {
    if (!reference) {
      // Only pure unit calls / the explicitly opted-in synthetic CLI path can
      // lack authenticated source. Real checkouts must resolve history first.
      for (const [id, limit] of Object.entries(budget.grandfathered[section]))
        if (limit > budget.ceilings[sizeKey(section)])
          result[section][budget.locations[section][id]] = {
            id,
            from: budget.locations[section][id],
            limit,
          };
      continue;
    }
    if (reference.target === "release") {
      result[section] = releaseMatches(section, current, budget, reference);
      continue;
    }
    const used = new Set(),
      rows = candidates(section, current, budget, reference);
    for (const row of rows) {
      if (used.has(row.id) || result[section][row.key]) continue;
      // Already consumed bodies are no longer candidates. This preserves a
      // grandfathered inner body's own row once its outer body is matched.
      if (
        section === "functions" &&
        rows.some(
          (other) =>
            !result[section][other.key] && nestedCandidate(row, other, current),
        )
      )
        continue;
      used.add(row.id);
      result[section][row.key] = row;
    }
  }
  return result;
}
export function allowanceLimit(match, budget, section) {
  if (!match) return budget.ceilings[sizeKey(section)];
  const value = budget.grandfathered[section][match.id];
  return value > budget.ceilings[sizeKey(section)]
    ? Math.min(match.limit, value)
    : budget.ceilings[sizeKey(section)];
}
export function moveRegressions(current, budget, reference) {
  if (!reference) return [];
  const errors = [],
    { metrics: base, budget: before } = reference;
  const matches = allowanceMatches(current, budget, reference);
  for (const [section, hashes] of [
    ["files", "fileHashes"],
    ["functions", "bodyHashes"],
  ]) {
    const used = new Set(),
      retired = new Map(
        Object.entries(base[hashes])
          .filter(
            ([k]) =>
              !Object.hasOwn(current[hashes], k) &&
              (Object.hasOwn(before[section], k) ||
                Object.values(before.locations[section]).includes(k)),
          )
          .map(([k, h]) => [h, k]),
      );
    for (const [key, hash] of Object.entries(current[hashes])) {
      const proof = budget.moves[key];
      if (
        proof?.section === section &&
        !Object.hasOwn(base[hashes], key) &&
        Object.hasOwn(base[hashes], proof.from) &&
        Object.hasOwn(current[hashes], proof.from)
      )
        errors.push(
          `Move proof requires absent source: ${section}.${proof.from} -> ${key}`,
        );
      if (exactMove(section, key, budget, base, current)) {
        const from = budget.moves[key].from;
        if (used.has(from))
          errors.push(
            `Move identity consumed more than once: ${section}.${from}`,
          );
        used.add(from);
      } else if (
        !Object.hasOwn(base[hashes], key) &&
        retired.has(hash) &&
        matches[section][key]?.from !== retired.get(hash)
      )
        errors.push(
          `Rename/move needs identity proof: ${section}.${retired.get(hash)} -> ${key}`,
        );
    }
  }
  return errors;
}
