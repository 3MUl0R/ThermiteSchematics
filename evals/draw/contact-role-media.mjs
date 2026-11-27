import {
  contactCaptionAudit,
  isContactCaptionField,
  isContactCaptionMediaField,
  isContactCaptionScope,
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
  const pdfExpected = (t) => isContactCaptionMediaField(t, ir);
  const pdfScope = (t) => isContactCaptionScope(t);
  const hasPdfRuns = (g.tranche3?.pdfTexts ?? []).length > 0;
  if (g.texts.some(pdfExpected) || (hasPdfRuns && g.texts.some(pdfScope))) {
    const pdf = pdfOracleTexts(
      { ...g, pdfTexts: g.tranche3?.pdfTexts ?? [] },
      hasPdfRuns ? pdfScope : pdfExpected,
    );
    const expectedElements = new Set(
      g.texts.filter(pdfExpected).map((t) => t.element),
    );
    findings.push(
      ...pdf.missing.filter((m) => expectedElements.has(m.element)),
      ...contactCaptionAudit({ ...g, texts: pdf.texts }, ir).findings.map(
        (f) => ({ ...f, medium: "pdf" }),
      ),
    );
  }
  return { ...svg, findings };
}
