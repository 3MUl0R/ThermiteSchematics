// Shared DQ-13 physical em floor and existing measurement tolerance.
export function minimumTextEmMm(t) {
  return t.secondaryReference ? 2.3 : 2.5;
}
export function hasLegibleEm(t) {
  return t.fontSize === undefined || t.fontSize >= minimumTextEmMm(t) - 0.03;
}
