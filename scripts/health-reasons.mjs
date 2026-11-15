import { isDeepStrictEqual } from "node:util";
// v4 accepts legacy single records on read; writers preserve an append-only list.
export const reasonList = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
export const latestReason = (value) => reasonList(value).at(-1);
export function reasonMatches(value, identity, from, to) {
  const record = latestReason(value);
  return (
    record &&
    record.identity === identity &&
    record.from === from &&
    record.to === to &&
    typeof record.reason === "string" &&
    Boolean(record.reason.trim())
  );
}
export function migrateReasonLists(budget) {
  return {
    ...budget,
    reasons: Object.fromEntries(
      Object.entries(budget.reasons).map(([id, value]) => [
        id,
        structuredClone(reasonList(value)),
      ]),
    ),
  };
}
export function appendReason(budget, identity, record) {
  const records = reasonList(budget.reasons[identity]);
  if (!isDeepStrictEqual(records.at(-1), record)) records.push(record);
  budget.reasons[identity] = records;
}
export function reasonHistoryRegressions(budget, base) {
  const errors = [];
  for (const [identity, value] of Object.entries(base.reasons)) {
    const before = reasonList(value),
      after = reasonList(budget.reasons[identity]);
    if (before.some((record, i) => !isDeepStrictEqual(record, after[i])))
      errors.push("Reason history must append without rewriting: " + identity);
  }
  return errors;
}
