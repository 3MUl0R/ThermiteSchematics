import {
  contactCaptionAudit,
  isContactCaptionField,
  isContactCaptionMediaField,
} from "./contact-role-oracle.mjs";
import { pdfOracleTexts } from "./tranche3-media.mjs";
import { finding } from "./review-geometry.mjs";
const key = (t) =>
  JSON.stringify([
    t.documentId,
    t.row,
    t.columnIndex,
    t.functionKey,
    t.deviceUid,
    t.labelOwnerKey,
  ]);
export function contactCaptionMediaAudit(g, ir) {
  const svg = contactCaptionAudit(g, ir),
    findings = svg.findings.map((f) => ({ ...f, medium: "svg" }));
  const htmlTexts = g.htmlTexts ?? [];
  findings.push(
    ...contactCaptionAudit({ ...g, texts: htmlTexts }, ir).findings.map(
      (f) => ({ ...f, medium: "html" }),
    ),
  );
  const svgExpected = g.texts.filter((t) => isContactCaptionField(t, ir, g));
  if (svgExpected.length) {
    const htmlActual = new Set(
      htmlTexts
        .filter((t) => isContactCaptionField(t, ir, { texts: htmlTexts }))
        .map(key),
    );
    for (const t of svgExpected)
      if (!htmlActual.has(key(t)))
        findings.push(
          finding("contact-caption-medium-unavailable", t, { medium: "html" }),
        );
  }
  const pdfField = (t) => isContactCaptionMediaField(t, ir);
  if (g.texts.some(pdfField)) {
    const pdf = pdfOracleTexts(
      { ...g, pdfTexts: g.tranche3?.pdfTexts ?? [] },
      pdfField,
    );
    findings.push(
      ...pdf.missing,
      ...contactCaptionAudit({ ...g, texts: pdf.texts }, ir).findings.map(
        (f) => ({ ...f, medium: "pdf" }),
      ),
    );
  }
  return { ...svg, findings };
}
