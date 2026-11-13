import type { ElectricalIr } from "@thermite/compiler";
import type { Rect } from "../device-legend/geometry.js";
import type { DocumentDependency, IssuedDocument } from "./document-types.js";
import type { RenderedSheet } from "./types.js";
import { allocateNavigationSlots } from "./navigation-slots.js";
import { documentCaptionReservation } from "./document-caption-ink.js";
import { documentCaptionTokens } from "./document-caption-text.js";
import { compactDocumentCaption } from "./document-caption-compact.js";
import { DocumentDependencyError } from "./document-error.js";
import { required } from "../presentation/util.js";

export function placeDocumentCaption(
  ir: Readonly<ElectricalIr>,
  need: DocumentDependency,
  documents: readonly IssuedDocument[],
  field: Rect,
  sheet: RenderedSheet,
  claims: readonly Rect[],
  standalone: boolean,
) {
  const place = (tokens: readonly string[]) =>
    required(
      allocateNavigationSlots(
        [
          {
            reservation: documentCaptionReservation(need, tokens, field.w),
            owner: field,
          },
        ],
        field,
        sheet.svg,
        sheet.number,
        claims,
      )[0],
      "Missing document caption slot",
    );
  try {
    return {
      slot: place(documentCaptionTokens(need, documents, standalone)),
      form: "identities" as const,
    };
  } catch (fullError) {
    try {
      if (standalone)
        throw Error("Standalone captions have no issued target to compact");
      const compact = compactDocumentCaption(ir, need, documents);
      return {
        slot: place(compact.tokens),
        form: "compact" as const,
        groups: compact.groups,
      };
    } catch (compactError) {
      throw new DocumentDependencyError(
        `Required companion captions at sheet ${sheet.number} (${need.subject}): identity and compact forms cannot fit: ${String(compactError)}`,
        [need],
        {
          sheet: sheet.number,
          profile: "document-caption/1",
          availableMm: field,
          identityFormError: String(fullError),
          compactFormError: String(compactError),
        },
      );
    }
  }
}
