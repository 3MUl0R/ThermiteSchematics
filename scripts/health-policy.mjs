import {
  DEFAULT_THRESHOLDS,
  SIZE_CEILINGS,
  SECTIONS,
  sizeKey,
  sorted,
  totals,
  valuesOf,
  fallbackOf,
  createBudget,
  validateBudget,
} from "./health-budget.mjs";
import {
  allowanceMatches,
  allowanceLimit,
  exactMove,
  moveRegressions,
} from "./health-continuity.mjs";
export {
  DEFAULT_THRESHOLDS,
  SIZE_CEILINGS,
  createBudget,
  validateBudget,
} from "./health-budget.mjs";
function referenceValue(section, key, budget, reference) {
  if (!reference) return budget[section][key] ?? fallbackOf(budget, section);
  const from = exactMove(
    section,
    key,
    budget,
    reference.metrics,
    reference.current,
  )
    ? budget.moves[key].from
    : key;
  const inherited = ["files", "functions"].includes(section)
    ? Object.entries(reference.budget.locations[section]).find(
        ([, key]) => key === from,
      )?.[0]
    : undefined;
  return (
    reference.budget[section][from] ??
    (inherited
      ? reference.budget.grandfathered[section][inherited]
      : undefined) ??
    fallbackOf(reference.budget, section)
  );
}
function changes(current, budget, reference) {
  validateBudget(budget);
  if (reference?.target === "release") return [];
  const rows = [],
    matches = allowanceMatches(current, budget, reference);
  for (const section of SECTIONS)
    for (const [key, n] of Object.entries(valuesOf(current, section))) {
      const size = ["files", "functions"].includes(section);
      if (size && n > budget.ceilings[sizeKey(section)]) continue;
      if (
        section === "duplicates" &&
        current.duplicates[key].tokens < budget.thresholds.duplicateTokens
      )
        continue;
      const matched = size && matches[section][key];
      const oldValue =
        budget[section][key] ??
        (matched
          ? allowanceLimit(matched, budget, section)
          : fallbackOf(budget, section));
      if (n <= oldValue) continue;
      const metric = {
        files: "file lines",
        functions: "function lines",
        nonNullAssertions: "non-null assertions",
        skippedTests: "skipped tests",
        duplicates: "duplicate bodies",
      }[section];
      const label =
        section === "duplicates"
          ? `${current.duplicates[key].members.join(", ")} [${key}]`
          : key;
      rows.push({
        section,
        key,
        oldValue,
        newValue: n,
        message: `${label}: ${metric}${size && budget[section][key] === undefined && !matched ? " threshold" : ""} ${oldValue} -> ${n}`,
      });
    }
  return rows;
}
export function ceilingRegressions(current, budget, reference) {
  validateBudget(budget);
  const errors = [],
    matches = allowanceMatches(current, budget, reference);
  for (const section of ["files", "functions"])
    for (const [key, value] of Object.entries(valuesOf(current, section))) {
      const limit = allowanceLimit(matches[section][key], budget, section);
      if (value > limit)
        errors.push(
          `${key}: ${section} ceiling ${limit} -> ${value}${!matches[section][key] && value > budget.ceilings[sizeKey(section)] ? " (new or unmatched content)" : ""}`,
        );
    }
  for (const [key, n] of Object.entries(totals(current)))
    if (n > budget.ceilings[key])
      errors.push(`Global ${key} ceiling ${budget.ceilings[key]} -> ${n}`);
  return errors;
}
export function regressions(current, budget, reference) {
  return [
    ...ceilingRegressions(current, budget, reference),
    ...changes(current, budget, reference).map((c) => c.message),
  ];
}
function reasonMatches(record, identity, from, to) {
  return (
    record &&
    record.identity === identity &&
    record.from === from &&
    record.to === to &&
    typeof record.reason === "string" &&
    Boolean(record.reason.trim())
  );
}
function authorizationRows(current, budget, reference) {
  const result = [];
  if (!reference || reference.target === "release") return result;
  for (const section of SECTIONS)
    for (const [key, to] of Object.entries(budget[section])) {
      const from = referenceValue(section, key, budget, {
        ...reference,
        current,
      });
      if (to > from)
        result.push({
          section,
          key,
          from,
          to,
          actual: valuesOf(current, section)[key] ?? 0,
        });
    }
  return result;
}
export function acceptBudget(current, budget, reason, reference) {
  const errors = ceilingRegressions(current, budget, reference);
  if (errors.length) throw Error(errors.join("\n"));
  const accepted = structuredClone(budget);
  // Rebase reductions need no authorization. Bank them before finding raises,
  // so an allowance above both actual and base cannot deadlock accept/lower.
  for (const section of SECTIONS) {
    const values = valuesOf(current, section);
    for (const [key, limit] of Object.entries(accepted[section])) {
      const value = values[key] ?? 0;
      if (value >= limit) continue;
      if (value <= fallbackOf(accepted, section)) delete accepted[section][key];
      else accepted[section][key] = value;
    }
  }
  bankReasons(current, budget, accepted, reference);
  const rows = changes(current, accepted, reference);
  const pending = authorizationRows(current, accepted, reference).filter(
    (r) =>
      !reasonMatches(
        accepted.reasons[`${r.section}:${r.key}`],
        `${r.section}:${r.key}`,
        r.from,
        r.actual,
      ),
  );
  if (
    (rows.length || pending.length) &&
    (typeof reason !== "string" || !reason.trim())
  )
    throw Error("Every budget raise requires --reason <text>");
  for (const { section, key, newValue } of rows)
    accepted[section][key] = newValue;
  for (const { section, key } of [...rows, ...pending]) {
    const identity = `${section}:${key}`,
      to = valuesOf(current, section)[key];
    if (accepted[section][key] !== to)
      throw Error(
        `Raise must equal current value: ${identity}; run health:lower`,
      );
    const from = referenceValue(
      section,
      key,
      budget,
      reference ? { ...reference, current } : undefined,
    );
    if (to > from)
      accepted.reasons[identity] = {
        identity,
        from,
        to,
        reason: reason.trim(),
      };
  }
  bankGrandfathers(current, budget, accepted, reference);
  for (const section of [...SECTIONS, "reasons"])
    accepted[section] = sorted(Object.entries(accepted[section]));
  return accepted;
}
function bankReasons(current, previous, next, reference) {
  next.reasons = structuredClone(previous.reasons);
  if (!reference) return;
  for (const r of authorizationRows(current, next, reference)) {
    const identity = `${r.section}:${r.key}`,
      old = previous.reasons[identity];
    if (
      reasonMatches(old, identity, r.from, previous[r.section][r.key]) &&
      r.to <= old.to
    )
      next.reasons[identity] = { ...old, to: r.to };
  }
}
function bankGrandfathers(current, previous, next, reference) {
  const matches = allowanceMatches(current, previous, reference);
  for (const section of ["files", "functions"]) {
    next.grandfathered[section] = {};
    next.locations[section] = {};
    next.fingerprints[section] = {};
    const values = valuesOf(current, section),
      hashes = section === "files" ? current.fileHashes : current.bodyHashes;
    for (const [key, row] of Object.entries(matches[section])) {
      const value = values[key],
        cap = next.ceilings[sizeKey(section)];
      if (value <= cap) {
        if (
          value > next.thresholds[sizeKey(section)] &&
          next[section][key] === undefined
        )
          next[section][key] = value;
        continue;
      }
      next.grandfathered[section][row.id] = Math.min(
        value,
        allowanceLimit(row, previous, section),
      );
      next.locations[section][row.id] = key;
      next.fingerprints[section][row.id] = hashes[key];
    }
    for (const field of ["grandfathered", "locations", "fingerprints"])
      next[field][section] = sorted(Object.entries(next[field][section]));
    next[section] = sorted(Object.entries(next[section]));
  }
}
export function lowerBudget(current, budget, reference) {
  const errors = regressions(current, budget, reference);
  if (errors.length) throw Error(regressionMessage(errors));
  const next = createBudget(current, budget.thresholds);
  next.ceilings = sorted(
    Object.entries({ ...budget.ceilings, ...totals(current) }),
  );
  next.moves = budget.moves;
  bankReasons(current, budget, next, reference);
  bankGrandfathers(current, budget, next, reference);
  return next;
}
export function regressionMessage(errors) {
  return `${errors.join("\n")}\nRaising a budget requires a manual edit or bun run health:accept --reason <text>, only under the global ceilings. Against dev, each authorization must match {identity, from: base value, to: current value, reason}. Release targets compare grandfathered values without cumulative content continuity or composing dev reasons. Both --accept and --lower bank reductions and retire sub-cap/deleted records. Dev continuity allows at most 70 added lines per PR. Cross-file moves require {section, from, sha256} in moves[newIdentity] and an absent source identity.`;
}
function grandfatherHistory(current, budget, reference) {
  const errors = [],
    matches = allowanceMatches(current, budget, reference);
  for (const section of ["files", "functions"]) {
    for (const [id, value] of Object.entries(budget.grandfathered[section])) {
      if (value <= budget.ceilings[sizeKey(section)]) {
        errors.push(`Retire sub-cap grandfathered ${section}.${id}`);
        continue;
      }
      if (
        !Object.entries(matches[section]).some(
          ([key, row]) =>
            row.id === id &&
            valuesOf(current, section)[key] > budget.ceilings[sizeKey(section)],
        )
      )
        errors.push(
          `Retire unmatched or sub-cap grandfathered ${section}.${id}`,
        );
      const before = reference.budget.grandfathered[section][id];
      if (before === undefined || value > before)
        errors.push(
          `Grandfathered ${section}.${id} cannot rise or be forged (${before ?? "new"} -> ${value})`,
        );
    }
    // Locations are descriptive; content matching, not a mutable pointer, grants caps.
    for (const [key, row] of Object.entries(matches[section]))
      if (
        valuesOf(current, section)[key] > budget.ceilings[sizeKey(section)] &&
        !Object.hasOwn(budget.grandfathered[section], row.id)
      )
        errors.push(
          `Missing active grandfathered ${section}.${row.id}; ${key} still over cap`,
        );
  }
  for (const section of ["files", "functions"])
    for (const [key, row] of Object.entries(matches[section])) {
      if (valuesOf(current, section)[key] <= budget.ceilings[sizeKey(section)])
        continue;
      const hashes =
        section === "files" ? current.fileHashes : current.bodyHashes;
      const location = budget.locations[section][row.id];
      if (budget.fingerprints[section][row.id] !== hashes[key])
        errors.push(
          `Refresh grandfathered content fingerprint with health:lower: ${row.id}`,
        );
      if (
        section === "files"
          ? location !== key
          : location?.split("#", 1)[0] !== key.split("#", 1)[0]
      )
        errors.push(
          `Grandfathered location must follow matched content: ${row.id}`,
        );
    }
  return errors;
}
function itemHistory(current, budget, reference) {
  const errors = [];
  for (const section of ["files", "functions"])
    for (const [key, n] of Object.entries(budget[section]))
      if (n > budget.ceilings[sizeKey(section)])
        errors.push(`Regular budget exceeds ceiling: ${section}.${key}`);
  for (const r of authorizationRows(current, budget, reference)) {
    const identity = `${r.section}:${r.key}`;
    if (
      r.to !== r.actual ||
      !reasonMatches(budget.reasons[identity], identity, r.from, r.actual)
    )
      errors.push(
        `Budget raise needs exact reason: ${identity} ${r.from} -> ${r.actual} (budget ${r.to})`,
      );
  }
  return errors;
}
export function historyRegressions(
  current,
  budget,
  baseBudget,
  base,
  target = "dev",
) {
  validateBudget(budget);
  validateBudget(baseBudget);
  const reference = { budget: baseBudget, metrics: base, target },
    errors = [];
  for (const section of ["ceilings", "thresholds"])
    for (const [key, value] of Object.entries(budget[section]))
      if (value > baseBudget[section][key])
        errors.push(
          `${section}.${key} cannot rise: ${baseBudget[section][key]} -> ${value}`,
        );
  return [
    ...errors,
    ...ceilingRegressions(current, budget, reference),
    ...grandfatherHistory(current, budget, reference),
    ...itemHistory(current, budget, reference),
    ...moveRegressions(current, budget, reference),
  ];
}
