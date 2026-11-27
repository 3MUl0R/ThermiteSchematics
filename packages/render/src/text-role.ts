/**
 * Affirmative print-legibility role taxonomy (designation 2.7 mm, body 2.5 mm,
 * secondary 2.3 mm). Every emitted SVG <text> element declares its role
 * explicitly at the emitter; no blanket body default is permitted.
 */
export type TextLegibilityRole = "designation" | "body" | "secondary";

/** Local font size in topology space so designations stay >= 2.7 mm at minimum 2.5/2.7 scale. */
export const TOPOLOGY_DESIGNATION_EM_MM = Number(
  ((2.7 * 2.7) / 2.5).toFixed(3),
);

const VALID_TEXT_ROLES: ReadonlySet<string> = new Set<TextLegibilityRole>([
  "designation",
  "body",
  "secondary",
]);

export function isTextLegibilityRole(
  value: unknown,
): value is TextLegibilityRole {
  return typeof value === "string" && VALID_TEXT_ROLES.has(value);
}

export function textRoleAttribute(role: TextLegibilityRole): string {
  return `data-text-role="${role}"`;
}
