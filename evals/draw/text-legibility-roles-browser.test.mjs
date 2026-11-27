import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { legibility } from "./checks.mjs";
import { classifyTextGeometry } from "./text-classification.mjs";
import {
  affirmativeTextRole,
  minimumTextEmMm,
  TEXT_LEGIBILITY_ROLES,
} from "./text-legibility.mjs";
import {
  auditPdfTextRoles,
  BASELINE_TOL_MM,
  extentToleranceMm,
} from "./pdf-text-roles.mjs";
import { evaluateSheet } from "./evaluate.mjs";
import { loadPdfBytes, pdfTextMeasurements } from "./pdf.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { packetPdf } from "../../packages/cli/dist/alpha-pdf.js";

const ir = {
  devices: [{ uid: "d1", designation: "M1", typeId: "t1" }],
  deviceTypes: [{ id: "t1", terminals: [{ key: "U1" }] }],
  functions: [],
  nets: [],
};

const svgDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="120mm" viewBox="0 0 200 120">` +
  `<rect x="10" y="10" width="180" height="100" fill="white" stroke="black" stroke-width="0.4"/>` +
  `${body}</svg>`;

const SPLIT_LABEL_TEXT = "Port R1.X06 → 02.B3; Port R1.X07 → 02.C3.";
const SPLIT_LABEL_RUNS = [
  {
    index: 10,
    text: "Port R1.X06",
    emMm: 2.5,
    painted: true,
    bbox: { x: 29, y: 217, w: 14.2, h: 2.5 },
  },
  {
    index: 11,
    text: "→",
    emMm: 2.5,
    painted: true,
    bbox: { x: 43.8, y: 217, w: 2.1, h: 2.5 },
  },
  {
    index: 12,
    text: "02.B3; Port R1.X07",
    emMm: 2.5,
    painted: true,
    bbox: { x: 46.5, y: 217, w: 22.8, h: 2.5 },
  },
  {
    index: 13,
    text: "→",
    emMm: 2.5,
    painted: true,
    bbox: { x: 69.9, y: 217, w: 2.1, h: 2.5 },
  },
  {
    index: 14,
    text: "02.C3.",
    emMm: 2.5,
    painted: true,
    bbox: { x: 72.6, y: 217, w: 7.4, h: 2.5 },
  },
];
const SPLIT_LABEL_BASE = {
  element: "text-153",
  text: SPLIT_LABEL_TEXT,
  painted: true,
  bbox: { x: 29, y: 217, w: 51.0, h: 2.5 },
  advance: 51.0,
};

const mutantBox = (x, y, w = 6, h = 2.5) => ({ x, y, w, h });
const mkSvgMutant = (text, x, y, textRole, w = 6) => ({
  element: `text-${text}-${x}`,
  text,
  textRole,
  bbox: mutantBox(x, y, w),
  fontSize: 2.5,
  advance: w,
  painted: true,
  font: "Thermite Sans",
});
const mkPdfMutant = (text, x, y, w = 6, index = 0, emMm = 2.5) => ({
  index,
  text,
  bbox: mutantBox(x, y, w, emMm),
  fontSize: emMm,
  emMm,
  painted: true,
  fontFamily: "Thermite Sans",
});

function evaluatePdfMutant(texts, runs) {
  const sheet = {
    number: 1,
    view: { format: "documentation-view/0.1", kind: "wiring" },
    references: [],
    continuations: [],
  };
  const g = {
    width: 200,
    height: 120,
    frame: mutantBox(0, 0, 200, 120),
    texts,
    terminals: [],
    devices: [],
    shapes: [],
    catalogs: [],
    reportRows: [],
  };
  const rows = evaluateSheet(
    { id: "mutant", flow: "left-to-right" },
    sheet,
    { sheets: [sheet] },
    g,
    { devices: [], functions: [], nets: [] },
    runs,
    [],
    [],
    [],
    [g],
    undefined,
    {},
    runs,
  );
  return {
    dq02Svg: rows.find((r) => r.id === "mutant/DQ-02/sheet-001"),
    dq02Pdf: rows.find((r) => r.id === "mutant/DQ-02/pdf-1"),
    dq21Audit: rows.find((r) => r.id === "mutant/DQ-21/unmatched-1"),
  };
}

let browser, context, page;
beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("protocol 5.54 affirmative text roles (EM-01/02/07)", () => {
  it("bumps checker protocol to 5.54 while retaining 5.48, 5.49, 5.51, and 5.53 summary readability", () => {
    expect(EVALS_VERSION).toBe("5.54");
    for (const evalsVersion of ["5.48", "5.49", "5.51", "5.53"]) {
      const sample = { evalsVersion, summary: { "DQ-02": { pass: 1 } } };
      expect(readReportSummary(sample)).toEqual(sample.summary);
    }
    expect(TEXT_LEGIBILITY_ROLES).toEqual({
      designation: 2.7,
      body: 2.5,
      secondary: 2.3,
    });
  });

  it("EM-01: measures data-text-role in Chromium, enforces floors, and flags missing or invalid roles", async () => {
    const source = svgDoc(
      '<text x="20" y="25" font-size="2.7" data-text-role="designation">JB1</text>' +
        '<text x="20" y="35" font-size="2.5" data-text-role="body">Same location</text>' +
        '<text x="20" y="45" font-size="2.3" data-text-role="secondary">W-FLD-002 → PX1.1</text>' +
        '<text x="20" y="55" font-size="2.5">Unmapped heading</text>' +
        '<text x="20" y="65" font-size="2.5" data-text-role="bogus">Invalid role</text>' +
        '<text x="20" y="75" font-size="2.5" data-text-role="designation">JB1 — undersized</text>',
    );
    const g = classifyTextGeometry(await openSheet(page, source), ir);
    const byText = new Map(g.texts.map((t) => [t.text, t]));

    expect(affirmativeTextRole(byText.get("JB1"))).toMatchObject({
      role: "designation",
      floorMm: 2.7,
    });
    expect(affirmativeTextRole(byText.get("Same location"))).toMatchObject({
      role: "body",
      floorMm: 2.5,
    });
    expect(affirmativeTextRole(byText.get("W-FLD-002 → PX1.1"))).toMatchObject({
      role: "secondary",
      floorMm: 2.3,
    });
    expect(affirmativeTextRole(byText.get("Unmapped heading"))).toMatchObject({
      role: "unmapped",
      floorMm: null,
    });
    expect(affirmativeTextRole(byText.get("Invalid role"))).toMatchObject({
      role: "unmapped",
      floorMm: null,
      detail: "invalid-text-role",
    });

    const findings = legibility(g);
    expect(findings.map((f) => [f.kind, f.text])).toEqual([
      ["unmapped-text-legibility-role", "Unmapped heading"],
      ["invalid-text-legibility-role", "Invalid role"],
      ["text-below-minimum-em", "JB1 — undersized"],
    ]);
  });

  it("negative control: preserves #206 security invariant so data-text-role cannot downgrade data-tag-field", async () => {
    const source = svgDoc(
      '<g data-device-uid="d1">' +
        '<text x="20" y="30" font-size="2.4" data-tag-owner-uid="d1" data-tag-kind="body" data-tag-block="d1" data-tag-field="description" data-text-role="secondary">Motor body</text>' +
        '<text x="20" y="40" font-size="2.5" data-tag-owner-uid="d1" data-tag-kind="body" data-tag-block="d1" data-tag-field="designation" data-text-role="body">M1</text>' +
        "</g>",
    );
    const g = classifyTextGeometry(await openSheet(page, source), ir);
    const desc = g.texts.find((t) => t.tagField === "description");
    const desig = g.texts.find((t) => t.tagField === "designation");
    expect(minimumTextEmMm(desc)).toBe(2.5);
    expect(minimumTextEmMm(desig)).toBe(2.7);
    expect(affirmativeTextRole(desc).floorMm).toBe(2.5);
    expect(affirmativeTextRole(desig).floorMm).toBe(2.7);
    expect(legibility(g).map((f) => [f.kind, f.text, f.minimumMm])).toEqual([
      ["text-below-minimum-em", "Motor body", 2.5],
      ["text-below-minimum-em", "M1", 2.7],
    ]);
  });

  it("EM-02: rejects permissive body fallback on unattributed witness runs and resolves attributed runs strictly", () => {
    const frame = { x: 10, y: 10, w: 180, h: 100 };
    // Positive control: rm3 s1 text-8 "PLC1" without data-text-role must be unmapped, never body(2.5).
    const unattributedSvg = [
      {
        element: "text-8",
        text: "PLC1",
        painted: true,
        bbox: { x: 28, y: 31, w: 8.407, h: 3.5 },
        advance: 8.407,
      },
    ];
    const pdfRuns = [
      {
        index: 4,
        text: "PLC1",
        emMm: 3.5,
        painted: true,
        bbox: { x: 28, y: 31, w: 8.407, h: 3.5 },
      },
    ];
    const bad = auditPdfTextRoles(pdfRuns, { texts: unattributedSvg, frame });
    expect(bad.byRole.unmapped).toBe(1);
    expect(bad.byRole.body).toBe(0);
    expect(bad.runResults[0]).toMatchObject({
      roleStatus: "unmapped",
      roleCategory: "unmapped",
      passesFloor: false,
    });

    // Fixed witness: explicit affirmative data-text-role="body" passes cleanly.
    const attributedSvg = [{ ...unattributedSvg[0], textRole: "body" }];
    const ok = auditPdfTextRoles(pdfRuns, { texts: attributedSvg, frame });
    expect(ok.byRole).toEqual({
      designation: 0,
      body: 1,
      secondary: 0,
      unmapped: 0,
      ambiguous: 0,
    });
    expect(ok.clean).toBe(true);

    // Ambiguity control: co-located texts with conflicting floors are reported ambiguous.
    const conflictSvg = [
      { ...unattributedSvg[0], element: "text-8", textRole: "designation" },
      { ...unattributedSvg[0], element: "text-9", textRole: "body" },
    ];
    const ambig = auditPdfTextRoles(pdfRuns, { texts: conflictSvg, frame });
    expect(ambig.byRole.ambiguous).toBe(1);
    expect(ambig.clean).toBe(false);
  });

  it("EM-07: reconciles DQ-21 split labels strictly by affirmative role, content, em floor, and 0.17 mm container", () => {
    const frame = { x: 10, y: 10, w: 260, h: 220 };
    // Positive control: unattributed split label fails with unmapped_svg_role.
    const unmapped = auditPdfTextRoles(SPLIT_LABEL_RUNS, {
      texts: [SPLIT_LABEL_BASE],
      frame,
    });
    expect(unmapped.splitLabels[0]).toMatchObject({
      rawStatus: "unmapped_svg_role",
      contentExact: true,
      fitsContainer017Mm: true,
    });
    expect(unmapped.clean).toBe(false);

    // Fixed control: secondary role resolves cleanly.
    const fixed = auditPdfTextRoles(SPLIT_LABEL_RUNS, {
      texts: [{ ...SPLIT_LABEL_BASE, textRole: "secondary" }],
      frame,
    });
    expect(fixed.splitLabels[0]).toMatchObject({
      rawStatus: "reconciled_split_ok",
      roleCategory: "secondary",
      floorMm: 2.3,
      contentExact: true,
      emOk: true,
      fitsContainer017Mm: true,
    });
    expect(fixed.clean).toBe(true);

    // Negative controls: undersized piece and container overflow still fail.
    const smallRuns = SPLIT_LABEL_RUNS.map((r, i) =>
      i === 1 ? { ...r, emMm: 2.2 } : r,
    );
    const small = auditPdfTextRoles(smallRuns, {
      texts: [{ ...SPLIT_LABEL_BASE, textRole: "secondary" }],
      frame,
    });
    expect(small.splitLabels[0].rawStatus).toBe("below_role_em_floor");

    const tightFrame = { x: 10, y: 10, w: 60, h: 220 };
    const overflow = auditPdfTextRoles(SPLIT_LABEL_RUNS, {
      texts: [{ ...SPLIT_LABEL_BASE, textRole: "secondary" }],
      frame: tightFrame,
    });
    expect(overflow.splitLabels[0].rawStatus).toBe("container_overflow_0.17mm");
  });

  it("enforces role presence unconditionally on stripped sheets and tagged designations (#206 floor only)", async () => {
    const stripped = svgDoc(
      '<text x="20" y="25" font-size="2.7">M1</text>' +
        '<text x="20" y="35" font-size="2.5">Caption</text>',
    );
    const gStripped = classifyTextGeometry(await openSheet(page, stripped), ir);
    expect(legibility(gStripped).map((f) => [f.kind, f.text])).toEqual([
      ["unmapped-text-legibility-role", "M1"],
      ["unmapped-text-legibility-role", "Caption"],
    ]);

    const untaggedRole = svgDoc(
      '<g data-device-uid="d1">' +
        '<text x="20" y="30" font-size="2.5" data-tag-owner-uid="d1" data-tag-kind="body" data-tag-block="d1" data-tag-field="designation">M1</text>' +
        "</g>",
    );
    const gTag = classifyTextGeometry(await openSheet(page, untaggedRole), ir);
    const desig = gTag.texts.find((t) => t.tagField === "designation");
    expect(affirmativeTextRole(desig)).toMatchObject({
      role: "unmapped",
      floorMm: null,
      detail: "missing-text-role",
    });
    expect(minimumTextEmMm(desig)).toBe(2.7);
    expect(legibility(gTag).map((f) => [f.kind, f.text])).toEqual([
      ["unmapped-text-legibility-role", "M1"],
      ["text-below-minimum-em", "M1"],
    ]);
  });

  it("wires strict PDF role audit into evaluateSheet() and kills orphan, missing, displaced, and stripped mutants", () => {
    expect(BASELINE_TOL_MM).toBe(0.17);
    expect(extentToleranceMm(6)).toBe(0.17);

    const orphan = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body")],
      [mkPdfMutant("AB", 20, 20), mkPdfMutant("ZZ", 100, 80, 6, 1)],
    );
    expect(orphan.dq02Pdf.status).toBe("fail");
    expect(orphan.dq21Audit.status).toBe("fail");

    const dupMissing = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body"), mkSvgMutant("AB", 100, 80, "body")],
      [mkPdfMutant("AB", 20, 20)],
    );
    expect(dupMissing.dq21Audit.status).toBe("fail");
    expect(dupMissing.dq21Audit.evidence.findings.map((f) => f.kind)).toContain(
      "dq21-split-missing-pdf-run",
    );

    const displaced = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body"), mkSvgMutant("CD", 50, 50, "body")],
      [
        mkPdfMutant("AB", 100, 80),
        mkPdfMutant("C", 50, 50, 3, 1),
        mkPdfMutant("D", 53, 50, 3, 2),
      ],
    );
    expect(displaced.dq02Pdf.status).toBe("fail");
    expect(displaced.dq21Audit.status).toBe("fail");

    const stripped = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, undefined)],
      [mkPdfMutant("AB", 20, 20)],
    );
    expect(stripped.dq02Svg.status).toBe("fail");
    expect(stripped.dq02Pdf.status).toBe("fail");
    expect(stripped.dq21Audit.status).toBe("fail");
  });

  it("enforces physical baseline, extent, ordered-character, and em-floor rules on splits via evaluateSheet()", () => {
    const goodSplit = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body")],
      [mkPdfMutant("A", 20, 20, 3, 1), mkPdfMutant("B", 23, 20, 3, 2)],
    );
    expect(goodSplit.dq02Svg.status).toBe("pass");
    expect(goodSplit.dq02Pdf.status).toBe("pass");
    expect(goodSplit.dq21Audit.status).toBe("pass");

    const badSplit = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body")],
      [mkPdfMutant("A", 20, 17, 2, 1), mkPdfMutant("B", 24, 23, 2, 2)],
    );
    expect(badSplit.dq02Pdf.status).toBe("fail");
    expect(badSplit.dq21Audit.status).toBe("fail");

    const bogusChar = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body")],
      [mkPdfMutant("X", 20, 20, 3, 1), mkPdfMutant("B", 23, 20, 3, 2)],
    );
    expect(bogusChar.dq02Pdf.status).toBe("fail");
    expect(bogusChar.dq21Audit.status).toBe("fail");

    const reversed = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "body")],
      [mkPdfMutant("B", 20, 20, 3, 1), mkPdfMutant("A", 23, 20, 3, 2)],
    );
    expect(reversed.dq21Audit.status).toBe("fail");

    const smallSplit = evaluatePdfMutant(
      [mkSvgMutant("AB", 20, 20, "designation")],
      [
        mkPdfMutant("A", 20, 20, 3, 1, 2.5),
        mkPdfMutant("B", 23, 20, 3, 2, 2.5),
      ],
    );
    expect(smallSplit.dq02Pdf.status).toBe("fail");
    expect(smallSplit.dq21Audit.status).toBe("fail");
  });

  async function evaluateNativePdfPair(id, svgBody, pdfBody) {
    const wrap = (body) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="120mm" viewBox="0 0 200 120" font-family="Thermite Sans, Thermite Math, sans-serif">` +
      `<rect x="5" y="5" width="190" height="110" fill="white" stroke="black"/>${body}</svg>`;
    const svg = wrap(svgBody);
    const pdfSvg = wrap(pdfBody);
    const g = await openSheet(page, embedPrintableFont(svg));
    const sheet = {
      number: 1,
      view: { format: "documentation-view/0.1", kind: "wiring" },
      references: [],
      continuations: [],
      svg,
    };
    const bytes = await packetPdf(
      {
        page: { widthMm: 200, heightMm: 120 },
        sheets: [{ number: 1, svg: pdfSvg }],
      },
      id,
    );
    const doc = await loadPdfBytes(bytes);
    try {
      const native = await pdfTextMeasurements(
        await doc.getPage(1),
        doc.fontFamilies,
        doc.fontCaps,
      );
      const audit = auditPdfTextRoles(native.text, g, native.metrics);
      const rows = evaluateSheet(
        { id, flow: "left-to-right" },
        sheet,
        { sheets: [sheet] },
        g,
        { devices: [], functions: [], nets: [] },
        native.text,
        [],
        [],
        [],
        [g],
        undefined,
        {},
        native.metrics,
      );
      return {
        audit,
        dq02Pdf: rows.find((r) => r.id === `${id}/DQ-02/pdf-1`),
        dq21Audit: rows.find((r) => r.id === `${id}/DQ-21/unmatched-1`),
        g,
        sheet,
      };
    } finally {
      await doc.loadingTask.destroy();
    }
  }

  it("enforces per-character split positions and rotated direction/baseline on native PDFs", async () => {
    const txt = (s, x = 20, y = 30, extra = "") =>
      `<text data-text-role="body" x="${x}" y="${y}" font-size="2.5" ${extra}>${s}</text>`;
    const short = txt("A → B");
    const spaced = txt(
      "A        →        B",
      20,
      30,
      'xml:space="preserve" style="white-space:pre"',
    );
    const rot = txt("AB", 25, 40, 'transform="rotate(-90 25 40)"');

    for (const [id, s, p] of [
      ["r3-split-ok", short, short],
      ["r3-spaced-ok", spaced, spaced],
      ["r3-rot-ok", rot, rot],
    ]) {
      const res = await evaluateNativePdfPair(id, s, p);
      expect(res.audit.clean).toBe(true);
      expect(res.dq02Pdf.status).toBe("pass");
      expect(res.dq21Audit.status).toBe("pass");
    }

    for (const [id, s, p] of [
      ["r3-collapsed-spaces", spaced, short],
      [
        "r3-displaced-arrow",
        spaced,
        txt("A", 20, 30) + txt("→", 22.25, 30) + txt("B", 33.9825, 30),
      ],
      [
        "r3-rot-right",
        rot,
        txt("AB", 27.5, 40, 'transform="rotate(-90 27.5 40)"'),
      ],
      [
        "r3-rot-left",
        rot,
        txt("AB", 21.7775, 40, 'transform="rotate(-90 21.7775 40)"'),
      ],
      ["r3-rot-horiz", rot, txt("AB", 25, 40)],
    ]) {
      const res = await evaluateNativePdfPair(id, s, p);
      expect(res.audit.clean).toBe(false);
      expect(res.dq02Pdf.status).toBe("fail");
      expect(res.dq21Audit.status).toBe("fail");
    }
  });

  it("distinguishes measured zero-run PDFs (FAIL) from unavailable PDF measurement (not-implemented)", async () => {
    const short =
      '<text data-text-role="body" x="20" y="30" font-size="2.5">A → B</text>';
    const blankPdf = await evaluateNativePdfPair("r3-blank-pdf", short, "");
    expect(blankPdf.audit.clean).toBe(false);
    expect(blankPdf.dq02Pdf.status).toBe("fail");
    expect(blankPdf.dq21Audit.status).toBe("fail");

    const blankBoth = await evaluateNativePdfPair("r3-blank-both", "", "");
    expect(blankBoth.audit.clean).toBe(true);
    expect(blankBoth.dq02Pdf.status).toBe("pass");
    expect(blankBoth.dq21Audit.status).toBe("pass");

    const sheet = {
      number: 1,
      view: { format: "documentation-view/0.1", kind: "wiring" },
      references: [],
      continuations: [],
    };
    const unmeasured = evaluateSheet(
      { id: "r3-unmeasured", flow: "left-to-right" },
      sheet,
      { sheets: [sheet] },
      {
        width: 200,
        height: 120,
        frame: mutantBox(0, 0, 200, 120),
        texts: [mkSvgMutant("AB", 20, 20, "body")],
        terminals: [],
        devices: [],
        shapes: [],
        catalogs: [],
        reportRows: [],
      },
      { devices: [], functions: [], nets: [] },
      [],
      [],
      [],
    );
    expect(
      unmeasured.find((r) => r.id === "r3-unmeasured/DQ-21/unmatched-1").status,
    ).toBe("not-implemented");
  });
});
