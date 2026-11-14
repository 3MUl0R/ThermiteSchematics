export const DEFAULT_THRESHOLDS = Object.freeze({
  duplicateTokens: 50,
  fileLines: 850,
  functionLines: 70,
});
export const SIZE_CEILINGS = Object.freeze({
  fileLines: 3000,
  functionLines: 300,
});
const sections = [
  "files",
  "functions",
  "nonNullAssertions",
  "skippedTests",
  "duplicates",
];
const sizeKey = (section) =>
  section === "files" ? "fileLines" : "functionLines";
export const sorted = (entries) =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
export function totals(current) {
  return {
    nonNullAssertions: Object.values(current.files).reduce(
      (n, f) => n + (f.nonNullAssertions ?? 0),
      0,
    ),
    skippedTests: Object.values(current.files).reduce(
      (n, f) => n + f.skippedTests,
      0,
    ),
  };
}
function numericMap(map, where, minimum = 1) {
  if (!map || typeof map !== "object" || Array.isArray(map))
    throw Error(`Invalid health budget map: ${where} (expected an object)`);
  for (const [key, n] of Object.entries(map))
    if (!Number.isSafeInteger(n) || n < minimum)
      throw Error(`Invalid health budget value: ${where}.${key}`);
}
export function validateBudget(budget) {
  if (budget.version !== 3)
    throw Error("Unsupported health budget version; expected 3");
  for (const key of Object.keys(DEFAULT_THRESHOLDS))
    if (
      !Number.isSafeInteger(budget.thresholds?.[key]) ||
      budget.thresholds[key] < 1
    )
      throw Error(`Invalid health threshold: ${key}`);
  for (const section of sections) numericMap(budget[section], section);
  numericMap(budget.ceilings, "ceilings", 0);
  for (const key of [
    ...Object.keys(SIZE_CEILINGS),
    "nonNullAssertions",
    "skippedTests",
  ])
    if (!Number.isSafeInteger(budget.ceilings[key]))
      throw Error(`Missing health ceiling: ${key}`);
  for (const [key, n] of Object.entries(SIZE_CEILINGS))
    if (budget.ceilings[key] < 1 || budget.ceilings[key] > n)
      throw Error(`Health ceiling ${key} cannot exceed ${n}`);
  for (const section of ["files", "functions"])
    numericMap(budget.grandfathered?.[section], `grandfathered.${section}`, 0);
  if (!budget.reasons || !budget.moves)
    throw Error("Missing health reasons or moves");
}
export function createBudget(current, thresholds = DEFAULT_THRESHOLDS) {
  const files = Object.entries(current.files);
  const budget = {
    version: 3,
    thresholds: sorted(Object.entries(thresholds)),
    ceilings: sorted(Object.entries({ ...SIZE_CEILINGS, ...totals(current) })),
    files: sorted(
      files
        .filter(([, f]) => f.lines > thresholds.fileLines)
        .map(([p, f]) => [p, f.lines]),
    ),
    functions: sorted(
      Object.entries(current.functions).filter(
        ([, n]) => n > thresholds.functionLines,
      ),
    ),
    nonNullAssertions: sorted(
      files
        .filter(([, f]) => f.nonNullAssertions > 0)
        .map(([p, f]) => [p, f.nonNullAssertions]),
    ),
    skippedTests: sorted(
      files
        .filter(([, f]) => f.skippedTests > 0)
        .map(([p, f]) => [p, f.skippedTests]),
    ),
    duplicates: sorted(
      Object.entries(current.duplicates)
        .filter(([, g]) => g.tokens >= thresholds.duplicateTokens)
        .map(([h, g]) => [h, g.members.length]),
    ),
    grandfathered: {
      files: sorted(
        files
          .filter(([, f]) => f.lines > SIZE_CEILINGS.fileLines)
          .map(([p, f]) => [p, f.lines]),
      ),
      functions: sorted(
        Object.entries(current.functions).filter(
          ([, n]) => n > SIZE_CEILINGS.functionLines,
        ),
      ),
    },
    moves: {},
    reasons: {},
  };
  return sorted(Object.entries(budget));
}
function changes(current, budget) {
  validateBudget(budget);
  const rows = [];
  const check = (section, key, n, fallback, metric) => {
    const oldValue = budget[section][key] ?? fallback;
    if (n > oldValue)
      rows.push({
        section,
        key,
        oldValue,
        newValue: n,
        message: `${key}: ${metric}${budget[section][key] === undefined && ["files", "functions"].includes(section) ? " threshold" : ""} ${oldValue} -> ${n}`,
      });
  };
  for (const [p, f] of Object.entries(current.files)) {
    check("files", p, f.lines ?? 0, budget.thresholds.fileLines, "file lines");
    check(
      "nonNullAssertions",
      p,
      f.nonNullAssertions ?? 0,
      0,
      "non-null assertions",
    );
    check("skippedTests", p, f.skippedTests, 0, "skipped tests");
  }
  for (const [p, n] of Object.entries(current.functions))
    check("functions", p, n, budget.thresholds.functionLines, "function lines");
  for (const [h, g] of Object.entries(current.duplicates))
    if (g.tokens >= budget.thresholds.duplicateTokens) {
      const before = rows.length;
      check("duplicates", h, g.members.length, 1, "duplicate bodies");
      if (rows.length !== before)
        rows.at(-1).message =
          `${g.members.join(", ")} [${h}]: duplicate bodies ${budget.duplicates[h] ?? 1} -> ${g.members.length}`;
    }
  return rows;
}
export function ceilingRegressions(current, budget) {
  validateBudget(budget);
  const errors = [];
  for (const [section, values] of [
    [
      "files",
      Object.fromEntries(
        Object.entries(current.files)
          .filter(([, f]) => f.lines !== undefined)
          .map(([p, f]) => [p, f.lines]),
      ),
    ],
    ["functions", current.functions],
  ])
    for (const [key, value] of Object.entries(values)) {
      const limit =
        budget.grandfathered[section][key] ?? budget.ceilings[sizeKey(section)];
      if (value > limit)
        errors.push(`${key}: ${section} ceiling ${limit} -> ${value}`);
    }
  for (const [key, n] of Object.entries(totals(current)))
    if (n > budget.ceilings[key])
      errors.push(`Global ${key} ceiling ${budget.ceilings[key]} -> ${n}`);
  return errors;
}
export function regressions(current, budget) {
  return [
    ...ceilingRegressions(current, budget),
    ...changes(current, budget).map((c) => c.message),
  ];
}
export function acceptBudget(current, budget, reason) {
  const errors = ceilingRegressions(current, budget);
  if (errors.length) throw Error(errors.join("\n"));
  const rows = changes(current, budget),
    accepted = structuredClone(budget);
  if (rows.length && (typeof reason !== "string" || !reason.trim()))
    throw Error("Every budget raise requires --reason <text>");
  for (const { section, key, newValue } of rows) {
    if (Object.hasOwn(budget.grandfathered[section] ?? {}, key))
      throw Error(`Cannot raise grandfathered ${section}.${key}`);
    accepted[section][key] = newValue;
    accepted.reasons[`${section}:${key}`] = reason.trim();
  }
  for (const section of [...sections, "reasons"])
    accepted[section] = sorted(Object.entries(accepted[section]));
  return accepted;
}
export function lowerBudget(current, budget) {
  const errors = regressions(current, budget);
  if (errors.length) throw Error(regressionMessage(errors));
  const next = createBudget(current, budget.thresholds);
  next.ceilings = sorted(
    Object.entries({ ...budget.ceilings, ...totals(current) }),
  );
  next.moves = budget.moves;
  next.reasons = budget.reasons;
  for (const section of ["files", "functions"]) {
    const values =
      section === "files"
        ? Object.fromEntries(
            Object.entries(current.files).map(([p, f]) => [p, f.lines ?? 0]),
          )
        : current.functions;
    next.grandfathered[section] = sorted(
      Object.entries(budget.grandfathered[section]).map(([key, limit]) => [
        key,
        Math.min(limit, values[key] ?? 0),
      ]),
    );
  }
  return next;
}
export function regressionMessage(errors) {
  return `${errors.join("\n")}\nRaising a budget requires a manual edit or bun run health:accept --reason <text>, only under the global ceilings. List every raise/reason in the PR. --lower only lowers budgets. Moves require {section, from, sha256} in moves[newIdentity].`;
}
function validMove(section, key, budget, base, current) {
  const proof = budget.moves[key];
  const hashes = section === "files" ? "fileHashes" : "bodyHashes";
  return (
    proof?.section === section &&
    typeof proof.from === "string" &&
    proof.from !== key &&
    !Object.hasOwn(current[hashes], proof.from) &&
    proof.sha256 === base[hashes][proof.from] &&
    proof.sha256 === current[hashes][key]
  );
}
function grandfatherHistory(budget, baseBudget, base, current) {
  const errors = [];
  for (const section of ["files", "functions"]) {
    const previous = baseBudget.grandfathered[section],
      next = budget.grandfathered[section];
    for (const [key, limit] of Object.entries(previous))
      if (!Object.hasOwn(next, key) || next[key] > limit)
        errors.push(
          `Grandfathered ${section}.${key} cannot rise or reset by deletion (${limit} -> ${next[key] ?? "deleted"})`,
        );
    for (const [key, limit] of Object.entries(next)) {
      const move = validMove(section, key, budget, base, current),
        from = budget.moves[key]?.from;
      const old = previous[key] ?? (move ? previous[from] : undefined);
      if (old === undefined || limit > old)
        errors.push(`Unproved grandfathered ${section}.${key}: ${limit}`);
      const entry = budget[section][key];
      if (entry !== undefined && entry > limit)
        errors.push(`Grandfathered ${section}.${key} budget exceeds ${limit}`);
    }
  }
  return errors;
}
function itemHistory(budget, baseBudget, base, current) {
  const errors = [];
  for (const section of sections)
    for (const [key, value] of Object.entries(budget[section])) {
      const size = ["files", "functions"].includes(section),
        move = size && validMove(section, key, budget, base, current);
      const fallback = size
        ? budget.thresholds[sizeKey(section)]
        : section === "duplicates"
          ? 1
          : 0;
      const old =
        baseBudget[section][key] ??
        (move ? baseBudget[section][budget.moves[key].from] : undefined) ??
        fallback;
      if (value > old && !budget.reasons[`${section}:${key}`]?.trim())
        errors.push(
          `Budget raise needs a reason: ${section}.${key} ${old} -> ${value}`,
        );
      if (
        size &&
        value > budget.ceilings[sizeKey(section)] &&
        value >
          (baseBudget.grandfathered[section][key] ??
            (move
              ? baseBudget.grandfathered[section][budget.moves[key].from]
              : 0) ??
            0)
      )
        errors.push(`Budget exceeds ceiling: ${section}.${key}`);
    }
  return errors;
}
function moveHistory(budget, baseBudget, base, current) {
  const errors = [];
  for (const [section, hashes] of [
    ["files", "fileHashes"],
    ["functions", "bodyHashes"],
  ]) {
    const retired = new Map(
      Object.entries(base[hashes])
        .filter(
          ([key]) =>
            !Object.hasOwn(current[hashes], key) &&
            Object.hasOwn(baseBudget[section], key),
        )
        .map(([key, hash]) => [hash, key]),
    );
    for (const [key, hash] of Object.entries(current[hashes]))
      if (
        !Object.hasOwn(base[hashes], key) &&
        retired.has(hash) &&
        !validMove(section, key, budget, base, current)
      )
        errors.push(
          `Rename/move needs identity proof: ${section}.${retired.get(hash)} -> ${key}`,
        );
  }
  return errors;
}
export function historyRegressions(current, budget, baseBudget, base) {
  validateBudget(budget);
  validateBudget(baseBudget);
  const errors = [];
  for (const section of ["ceilings", "thresholds"])
    for (const [key, value] of Object.entries(budget[section]))
      if (value > baseBudget[section][key])
        errors.push(
          `${section}.${key} cannot rise: ${baseBudget[section][key]} -> ${value}`,
        );
  return [
    ...errors,
    ...grandfatherHistory(budget, baseBudget, base, current),
    ...itemHistory(budget, baseBudget, base, current),
    ...moveHistory(budget, baseBudget, base, current),
  ];
}
