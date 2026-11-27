import {
  contactCaptionAudit,
  isContactCaptionField,
  isContactCaptionMediaField,
  isContactCaptionScope,
} from "./contact-role-oracle.mjs";
import {
  pdfOracleTexts,
  pdfRunInBox,
  svgOracleGroupBox,
} from "./tranche3-media.mjs";
import { finding, groupBy, painted } from "./review-geometry.mjs";
const key = (t) =>
  JSON.stringify([
    t.documentId,
    t.row,
    t.columnIndex,
    t.functionKey,
    t.deviceUid,
    t.labelOwnerKey,
  ]);

function unassociatedPdfCaptionRuns(g, pdfRuns, matched) {
  const candidates = pdfRuns.filter(
    (p) => !matched.has(p) && /\b(?:NC|NO)\b/.test(p.text ?? ""),
  );
  if (!candidates.length) return [];
  const otherBoxes = [
    ...groupBy(
      g.texts.filter((t) => painted(t) && !isContactCaptionScope(t)),
      (t) =>
        t.row != null
          ? JSON.stringify([t.documentId, t.row, t.columnIndex])
          : t.element,
    ).values(),
  ]
    .map((ts) => svgOracleGroupBox(g, ts))
    .filter(Boolean);
  return candidates
    .filter((p) => !otherBoxes.some((box) => pdfRunInBox(p, box)))
    .map((p) =>
      finding("contact-caption-pdf-run-unavailable", p, {
        medium: "pdf",
        text: p.text,
      }),
    );
}

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
  const pdfRuns = g.tranche3?.pdfTexts ?? [];
  const hasPdfRuns = pdfRuns.length > 0;
  if (g.texts.some(pdfExpected) || hasPdfRuns) {
    const pdf = pdfOracleTexts(
      { ...g, pdfTexts: pdfRuns },
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
      ...(hasPdfRuns
        ? unassociatedPdfCaptionRuns(g, pdfRuns, pdf.matched)
        : []),
    );
  }
  return { ...svg, findings };
}
