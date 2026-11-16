import type { ElectricalIr } from "@thermite/compiler";
import type { Rect } from "../device-legend/geometry.js";
import type { DocumentDependency, IssuedDocument } from "./document-types.js";
import type { RenderedSheet } from "./types.js";
import { documentCaptionTokens } from "./document-caption-text.js";
import { compactDocumentCaption } from "./document-caption-compact.js";
import { DocumentDependencyError } from "./document-error.js";
import { documentCaptionOwner } from "./document-caption-owner.js";
import { documentCaptionSlot } from "./document-caption-slot.js";

export function placeDocumentCaption(
  ir: Readonly<ElectricalIr>,
  need: DocumentDependency,
  documents: readonly IssuedDocument[],
  field: Rect,
  sheet: RenderedSheet,
  claims: readonly Rect[],
  standalone: boolean,
) {
  const owner = documentCaptionOwner(need, sheet, field);
  const forms = [
    () => ({
      tokens: documentCaptionTokens(need, documents, standalone),
      form: "identities" as const,
    }),
    () => {
      if (standalone)
        throw Error("Standalone captions have no issued target to compact");
      return {
        ...compactDocumentCaption(ir, need, documents),
        form: "compact" as const,
      };
    },
  ];
  const errors: unknown[] = [];
  for (const mode of owner
    ? (["local", "self-located"] as const)
    : (["self-located"] as const)) {
    for (const form of forms) {
      try {
        const { tokens, ...metadata } = form();
        return {
          ...metadata,
          slot: documentCaptionSlot(
            need,
            tokens,
            field,
            sheet,
            claims,
            mode,
            owner,
          ),
        };
      } catch (error) {
        errors.push(error);
      }
    }
  }
  throw new DocumentDependencyError(
    `Required companion captions at sheet ${sheet.number} (${need.subject}): identity and compact forms cannot fit: ${String(errors.at(-1))}`,
    [need],
    {
      sheet: sheet.number,
      profile: "document-caption/1",
      availableMm: field,
      identityFormError: String(errors[0]),
      compactFormError: String(errors.at(-1)),
    },
  );
}
