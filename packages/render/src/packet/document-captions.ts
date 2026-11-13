import type {
  ElectricalIr,
  CompiledProjectPresentation,
} from "@thermite/compiler";
import type { Draft, PaperPage, RenderedSheet } from "./types.js";
import type { DocumentDependency, IssuedDocument } from "./document-types.js";
import type { IssuedNavigation } from "./navigation-types.js";
import { documentDependencies } from "./document-companions.js";
import {
  issuedDocuments,
  missingDocumentFacts,
  resolveDocumentNeed,
} from "./document-registry.js";
import { bounds } from "./page.js";
import { required } from "../presentation/util.js";
import { DocumentDependencyError } from "./document-error.js";
import { documentCaptionInk } from "./document-caption-ink.js";
import { placeDocumentCaption } from "./document-caption-place.js";
function captionSheet(
  ir: Readonly<ElectricalIr>,
  sheet: RenderedSheet,
  draft: Draft,
  needs: readonly DocumentDependency[],
  documents: readonly IssuedDocument[],
  page: PaperPage,
  navigation: IssuedNavigation,
  standalone: boolean,
): RenderedSheet {
  const result = {
    ...sheet,
    svg: sheet.svg.replace(
      /<text\b([^>]*data-document-note-replacement="([^"]*)"[^>]*)>[^<]*<\/text>/g,
      (_, attributes: string, value: string) =>
        `<text${attributes}>${value}</text>`,
    ),
  };
  if (!needs.length) return result;
  const field = draft.drawingBounds ?? bounds(draft.title, page);
  const claims = navigation.reservations
    .filter((r) => r.allocatedMm?.sheet === sheet.number)
    .map((r) => required(r.allocatedMm, "Missing navigation claim").rect);
  const ink = needs
    .map((need) => {
      if (!standalone && missingDocumentFacts(need, documents).length)
        throw new DocumentDependencyError(
          `Unresolved document promise at sheet ${need.owner.sheet}: ${need.subject}`,
          [need],
        );
      need.resolution = standalone ? [] : resolveDocumentNeed(need, documents);
      const placed = placeDocumentCaption(
        ir,
        need,
        documents,
        field,
        result,
        claims,
        standalone,
      );
      claims.push(
        required(placed.slot.allocatedMm, "Missing document caption slot").rect,
      );
      return documentCaptionInk(need, placed.slot, {
        form: placed.form,
        ...(placed.groups ? { groups: placed.groups } : {}),
      });
    })
    .join("");
  result.svg = result.svg.replace(/<\/svg>(\s*)$/, `${ink}</svg>$1`);
  return result;
}
/** Extension of NAV's pure finalization: never reroutes or repaginates drawings. */
export function finalizeDocuments(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  page: PaperPage,
  navigation: IssuedNavigation,
  standalone: boolean,
  presentation?: CompiledProjectPresentation,
): { sheets: RenderedSheet[]; navigation: IssuedNavigation } {
  const documents = issuedDocuments(ir, drafts, sheets, page, presentation),
    dependencies = documentDependencies(ir, drafts, presentation);
  const result = sheets.map((sheet, i) =>
    captionSheet(
      ir,
      sheet,
      required(drafts[i], "Missing document draft"),
      dependencies.filter((d) => d.owner.sheet === sheet.number),
      documents,
      page,
      navigation,
      standalone,
    ),
  );
  return {
    sheets: result,
    navigation: {
      ...navigation,
      documentFormat: "issued-documents/1",
      documents,
      dependencies,
      autoDocuments: documents
        .filter((d) => d.autoOrigin)
        .map((d) => ({
          documentId: d.id,
          dependencyIds: required(d.autoOrigin, "Missing auto origin")
            .dependencyIds,
          sheets: [...new Set(d.rows.map((r) => r.sheet))],
        })),
    },
  };
}
