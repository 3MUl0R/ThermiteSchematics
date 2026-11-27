/**
 * Affirmative print-legibility role taxonomy (designation 2.7 mm, body 2.5 mm,
 * secondary 2.3 mm). Every emitted SVG <text> element declares its role
 * explicitly at the emitter; no blanket body default is permitted.
 */
export type TextLegibilityRole = "designation" | "body" | "secondary";

export function textRoleAttribute(role: TextLegibilityRole): string {
  return `data-text-role="${role}"`;
}
