export const CI_CONFLICT_PAIRS = 20;
export const CONFLICT_BARRIER_PREFIX = "guard/two-process-barrier/";
export const OUTSIDE_SENTINEL_RELATIVE_PATH = "outside/sentinel.txt";
export const OUTSIDE_SENTINEL_CONTENT = "SYNTHETIC OUTSIDE SENTINEL\n";

export function expectedConflictRowIds(conflicts = CI_CONFLICT_PAIRS) {
  if (!Number.isInteger(conflicts) || conflicts < 1 || conflicts > 1000) {
    throw new RangeError(
      `Expected integer conflict pair count between 1 and 1000, got ${conflicts}`,
    );
  }
  return Array.from(
    { length: conflicts },
    (_, index) => `${CONFLICT_BARRIER_PREFIX}${index + 1}`,
  );
}
