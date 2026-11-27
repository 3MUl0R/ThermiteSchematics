// Shared DQ-13 physical em floor, affirmative role taxonomy, and tolerance.
export const TEXT_LEGIBILITY_ROLES = Object.freeze({
  designation: 2.7,
  body: 2.5,
  secondary: 2.3,
});
export function isTextLegibilityRole(value) {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TEXT_LEGIBILITY_ROLES, value)
  );
}
export function affirmativeTextRole(t) {
  if (t.textRole == null)
    return {
      role: "unmapped",
      floorMm: null,
      detail: "missing-text-role",
    };
  if (!isTextLegibilityRole(t.textRole))
    return { role: "unmapped", floorMm: null, detail: "invalid-text-role" };
  if (t.nativeReference)
    return {
      role: "secondary",
      floorMm: TEXT_LEGIBILITY_ROLES.secondary,
      detail: "native-reference",
    };
  if (t.tagField != null)
    return t.tagField === "designation"
      ? {
          role: "designation",
          floorMm: TEXT_LEGIBILITY_ROLES.designation,
          detail: "tag-designation",
        }
      : {
          role: "body",
          floorMm: TEXT_LEGIBILITY_ROLES.body,
          detail: `tag-${t.tagField}`,
        };
  return {
    role: t.textRole,
    floorMm: TEXT_LEGIBILITY_ROLES[t.textRole],
    detail: `text-role-${t.textRole}`,
  };
}
export function roleLegibilityIssues(t, issue) {
  if (t.textRole == null)
    return [
      issue("unmapped-text-legibility-role", t, {
        text: t.text,
        role: t.role,
        font: t.font,
      }),
    ];
  if (!isTextLegibilityRole(t.textRole))
    return [
      issue("invalid-text-legibility-role", t, {
        text: t.text,
        textRole: t.textRole,
        role: t.role,
        font: t.font,
      }),
    ];
  return [];
}
export function minimumTextEmMm(t) {
  if (t.nativeReference) return 2.3;
  if (t.tagField != null) return t.tagField === "designation" ? 2.7 : 2.5;
  if (isTextLegibilityRole(t.textRole))
    return TEXT_LEGIBILITY_ROLES[t.textRole];
  return t.secondaryReference ? 2.3 : 2.5;
}
// SVG native text lengths and CTMs pass through browser floating-point
// projections. One part per million is numerical allowance, not a fit budget.
export const TEXT_FACTOR_EPS = 1e-6;
export const MIN_TEXT_HORIZONTAL_FACTOR = 1 / 1.1;
export function hasLegibleEm(t) {
  const factor = t.tagHorizontalFactor;
  return (
    (t.fontSize === undefined || t.fontSize >= minimumTextEmMm(t) - 0.03) &&
    (factor === undefined ||
      (typeof factor === "number" &&
        Number.isFinite(factor) &&
        factor >= MIN_TEXT_HORIZONTAL_FACTOR - TEXT_FACTOR_EPS &&
        factor <= 1 + TEXT_FACTOR_EPS))
  );
}
