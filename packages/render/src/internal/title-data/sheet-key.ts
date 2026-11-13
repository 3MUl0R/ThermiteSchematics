import { createHash } from "node:crypto";
import type { FinalSheet, SheetIdentity } from "./model.js";
/** A tagged tuple avoids collisions across native producers and field order. */
function identityTuple(identity: SheetIdentity): readonly string[] {
  switch (identity.kind) {
    case "view":
      return [identity.kind, identity.viewKey];
    case "document":
    case "companion":
      return [identity.kind, identity.documentId];
    case "index":
    case "references":
      return [identity.kind];
  }
}
export function sheetKey(
  sheet: Pick<FinalSheet, "identity" | "partIndex" | "partTotal">,
): string {
  const tuple = [
    identityTuple(sheet.identity),
    sheet.partIndex,
    sheet.partTotal,
  ];
  return `sheet/1/${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}
