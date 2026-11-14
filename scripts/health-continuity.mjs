import { sizeKey, valuesOf } from "./health-budget.mjs";
export const CONTINUITY_THRESHOLD = 0.5;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fileOf = (key) => key.split("#", 1)[0];
// Multiset Dice overlap of trivia-free, substantive AST-line hashes. Repeated
// lines count only up to their frequency in the other body, not as a set union.
export function lineSimilarity(a, b) {
  if (!a?.length || !b?.length) return 0;
  const counts = new Map();
  for (const hash of a) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  let common = 0;
  for (const hash of b)
    if (counts.get(hash)) {
      common++;
      counts.set(hash, counts.get(hash) - 1);
    }
  return (2 * common) / (a.length + b.length);
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
    (section === "files"
      ? !Object.hasOwn(current[hashes], proof.from)
      : current[hashes][proof.from] !== base[hashes][proof.from]) &&
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
      const similarity =
        base[hashes][from] === current[hashes][key]
          ? 1
          : lineSimilarity(base[lines]?.[from], current[lines]?.[key]);
      if (similarity >= CONTINUITY_THRESHOLD)
        rows.push({ key, id, from, limit, similarity });
    }
  }
  return rows.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      Number(b.key === b.from) - Number(a.key === a.from) ||
      compare(a.id, b.id) ||
      compare(a.key, b.key),
  );
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
    const used = new Set();
    for (const row of candidates(section, current, budget, reference)) {
      if (used.has(row.id) || result[section][row.key]) continue;
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
