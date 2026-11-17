export const identifierErrorPattern =
  "Identifier measurement|Report column has no independently measurable SVG cell rectangle|Report text lacks an independently measured cell bbox";
export const isIdentifierError = (error) =>
  new RegExp(identifierErrorPattern).test(error?.message ?? String(error));
export function identifierContext(error, sheet, medium) {
  if (isIdentifierError(error))
    Object.assign(error, { sheet, medium, instrumentation: "identifier" });
  return error;
}
