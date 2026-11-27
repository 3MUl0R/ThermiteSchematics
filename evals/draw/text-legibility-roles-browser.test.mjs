import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, openSheet } from "./browser.mjs";
import { legibility } from "./checks.mjs";
import { classifyTextGeometry } from "./text-classification.mjs";
import {
  affirmativeTextRole,
  minimumTextEmMm,
  TEXT_LEGIBILITY_ROLES,
} from "./text-legibility.mjs";
import { auditPdfTextRoles } from "./pdf-text-roles.mjs";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";

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

let browser, context, page;
beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext({
    offline: true,
    javaScriptEnabled: false,
  });
  page = await context.newPage();
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("protocol 5.50 affirmative text roles (EM-01/02/07)", () => {
  it("bumps checker protocol to 5.50 while retaining 5.48 and 5.49 summary readability", () => {
    expect(EVALS_VERSION).toBe("5.50");
    for (const evalsVersion of ["5.48", "5.49"]) {
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
});
