import { describe, expect, it } from "vitest";
import { textInZoneGutter, zoneGutterAudit } from "./zone-gutter.mjs";

const text = (value, extra = {}) => ({
  element: `text-${value}`,
  text: value,
  renderedString: value,
  bbox: { x: 20, y: 30, w: 10, h: 3 },
  font: "Noto Sans",
  fontSize: 2.5,
  role: "",
  ...extra,
});

function baseSheetFixture(fieldLeft = 36) {
  const frame = { x: 10, y: 10, w: 411.8, h: 259.4 };
  const headerRule = { y: 18 };
  const titleBlock = { x: 340, y: 241, w: 81.8, h: 28 };
  const colW = (400 - fieldLeft) / 6;
  const zoneNums = [1, 2, 3, 4, 5, 6].map((n, i) =>
    text(String(n), {
      element: `zn-${n}`,
      sheetText: true,
      anchor: { x: fieldLeft + (i + 0.5) * colW, y: 22 },
      bbox: { x: fieldLeft + (i + 0.5) * colW - 1, y: 20, w: 2, h: 2.2 },
    }),
  );
  const zoneLetters = ["A", "B", "C", "D"].map((l, i) =>
    text(l, {
      element: `zl-${l}`,
      sheetText: true,
      anchor: { x: 13.0, y: 60 + i * 44 },
      bbox: { x: 13.0, y: 58.2 + i * 44, w: 1.675, h: 1.85 },
    }),
  );
  // zoneLetterRight = 14.675; with optional inner rule at x=15.0 (right=15.2)
  return {
    width: 431.8,
    height: 279.4,
    frame,
    headerRule,
    titleBlock,
    zoneNums,
    zoneLetters,
    fieldLeft,
    letterRight: 14.675,
  };
}

function continuationModelContext(g, overrides) {
  const c = {
    id: "C009",
    toSheet: 4,
    conductor: "K1-A2-0V",
    netId: "net-1",
    sourceElement: { kind: "wire", uid: "w-uid-1" },
  };
  const sheet = {
    number: 4,
    continuations: overrides.sheetContinuations ?? [{ ...c }, { ...c }],
  };
  const ir = {
    wires: [
      {
        uid: "w-uid-1",
        designation: "K1-A2-0V",
        properties: { label: "K1-A2-0V" },
      },
    ],
    jumpers: [],
    cableConductors: [],
    cables: [],
  };
  return { sheet, packet: { sheets: [sheet] }, geometries: [g], ir };
}

function validLeftContinuationScenario(overrides = {}) {
  const f = baseSheetFixture(36);
  const anchorY = 106.5;
  const labelLeft = overrides.labelLeft ?? 16.35;
  const labelY = overrides.labelY ?? anchorY - 2.6;
  const side = overrides.side ?? "left";
  const anchor = overrides.anchor ?? { x: f.fieldLeft, y: anchorY };
  const stubEnd =
    overrides.stubEnd ??
    (side === "left"
      ? { x: f.fieldLeft - 2, y: anchorY }
      : { x: f.fieldLeft, y: anchorY - 2 });
  const row1 = text(overrides.headerText ?? "C009 / 04.A6", {
    element: "cont-row-1",
    continuation: true,
    continuationLink: "a-left-1",
    anchor: { x: labelLeft, y: labelY + 1.8 },
    bbox: { x: labelLeft, y: labelY, w: 14.3, h: 1.85 },
  });
  const row2 = text(overrides.bodyText ?? "K1-A2-0V", {
    element: "cont-row-2",
    continuation: true,
    continuationLink: "a-left-1",
    anchor: { x: labelLeft + 4, y: labelY + 5.3 },
    bbox: { x: labelLeft + 4, y: labelY + 3.5, w: 10.3, h: 1.85 },
  });
  const connectors = [
    {
      id: "C009",
      element: "a-right-1",
      toSheet: 4,
      anchor: { x: 398, y: 58 },
      stubEnd: { x: 400, y: 58 },
      side: "right",
    },
    { id: "C009", element: "a-left-1", toSheet: 4, anchor, stubEnd, side },
  ];
  const conductorShape = {
    element: "path-w1",
    conductor: true,
    painted: true,
    wire: overrides.shapeWire ?? "w-uid-1",
    net: "net-1",
    points: overrides.conductorPoints ?? [
      { x: f.fieldLeft, y: anchorY },
      { x: f.fieldLeft + 40, y: anchorY },
    ],
    bbox: { x: f.fieldLeft, y: anchorY - 0.2, w: 40, h: 0.4 },
  };
  const g = {
    width: f.width,
    height: f.height,
    frame: f.frame,
    headerRule: f.headerRule,
    titleBlock: f.titleBlock,
    texts: [
      ...f.zoneNums,
      ...f.zoneLetters,
      row1,
      row2,
      ...(overrides.extraTexts ?? []),
    ],
    connectors,
    shapes: overrides.shapes ?? [conductorShape],
    ...(overrides.zoneColumnRules
      ? { zoneColumnRules: overrides.zoneColumnRules }
      : {}),
  };
  return { g, context: continuationModelContext(g, overrides), fixture: f };
}

describe("DQ-02 zone-gutter check and bounded left-continuation contract", () => {
  it("kills non-continuation elements in the gutter (strip key, legend, notice, peer note) and passes field text", () => {
    const f = baseSheetFixture(28);
    const base = {
      width: f.width,
      height: f.height,
      frame: f.frame,
      headerRule: f.headerRule,
      titleBlock: f.titleBlock,
    };
    const fieldText = text("T1/R1", {
      element: "field-1",
      bbox: { x: 29.4, y: 50, w: 7.2, h: 2.2 },
    });
    expect(
      textInZoneGutter({
        ...base,
        texts: [...f.zoneNums, ...f.zoneLetters, fieldText],
      }),
    ).toEqual([]);

    const nonContinuationMutants = [
      text("T1/R1", {
        element: "strip-key",
        bbox: { x: 19.0, y: 50, w: 7.2, h: 2.2 },
      }),
      text("Devices on this sheet", {
        element: "legend-1",
        tagKind: "legend",
        inDeviceLegend: true,
        bbox: { x: 27.8, y: 50, w: 28, h: 2.2 },
      }),
      text("SELECTED PATH VIEW", {
        element: "notice-1",
        bbox: { x: 27.8, y: 25, w: 30, h: 2.2 },
      }),
      text("W1 -> TB1.1 02.A1", {
        element: "peer-1",
        peerReference: "conductor-peer",
        bbox: { x: 22.0, y: 60, w: 20, h: 2.2 },
      }),
    ];
    for (const mutant of nonContinuationMutants) {
      const hit = textInZoneGutter({
        ...base,
        texts: [...f.zoneNums, ...f.zoneLetters, mutant],
      });
      expect(hit.map((x) => [x.kind, x.reason])).toEqual([
        ["text-in-zone-gutter", "non-continuation-in-gutter"],
      ]);
    }
  });

  it("admits and counts a model-verified left-edge continuation >= 1.5 mm right of the zone-letter column rule", () => {
    const { g, context } = validLeftContinuationScenario();
    const audit = zoneGutterAudit(g, context);
    expect(audit.findings).toEqual([]);
    expect(audit.contracted).toHaveLength(1);
    expect(audit.contracted[0]).toMatchObject({
      id: "C009",
      conductor: "K1-A2-0V",
      toSheet: 4,
      destinationZone: "A6",
    });
    expect(audit.contracted[0].clearanceMm).toBeCloseTo(1.675, 2);
    expect(audit.contracted[0].verticalOffsetMm).toBeLessThan(0.5);
  });

  it("kills a continuation 0.2 mm into the zone-letter column", () => {
    const { g, context } = validLeftContinuationScenario({
      labelLeft: 14.675 - 0.2,
    });
    const audit = zoneGutterAudit(g, context);
    expect(audit.contracted).toEqual([]);
    expect(audit.findings.length).toBeGreaterThanOrEqual(1);
    expect(audit.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-in-zone-letter-column",
    });
  });

  it("kills a continuation 1.4 mm right of the zone-letter column rule (both letter edge and drawn inner rule)", () => {
    // 1.40 mm from zone-letter right edge (14.675 + 1.40 = 16.075)
    const { g: g1, context: ctx1 } = validLeftContinuationScenario({
      labelLeft: 14.675 + 1.4,
    });
    const a1 = zoneGutterAudit(g1, ctx1);
    expect(a1.contracted).toEqual([]);
    expect(a1.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-rule-clearance",
    });
    // 1.40 mm from an explicit drawn vertical inner rule at right = 15.20 (15.20 + 1.40 = 16.60)
    const { g: g2, context: ctx2 } = validLeftContinuationScenario({
      labelLeft: 16.6,
      zoneColumnRules: [
        { element: "line-rule", x: 15.0, right: 15.2, y: 20, h: 200 },
      ],
    });
    const a2 = zoneGutterAudit(g2, ctx2);
    expect(a2.contracted).toEqual([]);
    expect(a2.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-rule-clearance",
    });
    // Control: 1.52 mm from that drawn inner rule (15.20 + 1.52 = 16.72) passes and is counted
    const { g: g3, context: ctx3 } = validLeftContinuationScenario({
      labelLeft: 16.72,
      zoneColumnRules: [
        { element: "line-rule", x: 15.0, right: 15.2, y: 20, h: 200 },
      ],
    });
    const a3 = zoneGutterAudit(g3, ctx3);
    expect(a3.findings).toEqual([]);
    expect(a3.contracted).toHaveLength(1);
  });

  it("kills a left continuation vertically misaligned from its own conductor", () => {
    const { g, context } = validLeftContinuationScenario({
      labelY: 106.5 + 6.0, // > 3.5 mm vertical misalignment
    });
    const audit = zoneGutterAudit(g, context);
    expect(audit.contracted).toEqual([]);
    expect(audit.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-vertical-misalignment",
    });
  });

  it("kills a top or bottom continuation overhanging x < field.x", () => {
    const { g, context } = validLeftContinuationScenario({
      side: "top",
      labelLeft: 24.0,
      anchor: { x: 29.0, y: 40 },
      stubEnd: { x: 29.0, y: 38 },
      labelY: 32,
    });
    const audit = zoneGutterAudit(g, context);
    expect(audit.contracted).toEqual([]);
    expect(audit.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-not-left-edge",
    });
  });

  it("kills an element falsely marked as a continuation or with an unreal conductor/destination", () => {
    // 1. Plain element falsely marked continuation: true (not in sheet.continuations)
    const { g: gFake, context: ctxFake } = validLeftContinuationScenario({
      extraTexts: [
        text("FAKE / 01.A1", {
          element: "fake-cont",
          continuation: true,
          bbox: { x: 18.0, y: 150, w: 14, h: 2.0 },
        }),
      ],
    });
    const aFake = zoneGutterAudit(gFake, ctxFake);
    expect(aFake.findings).toContainEqual(
      expect.objectContaining({
        kind: "text-in-zone-gutter",
        element: "fake-cont",
        reason: "false-continuation-marker",
      }),
    );

    // 2. Continuation whose conductor does not actually leave at the left edge
    const { g: gNoCond, context: ctxNoCond } = validLeftContinuationScenario({
      shapes: [],
    });
    const aNoCond = zoneGutterAudit(gNoCond, ctxNoCond);
    expect(aNoCond.contracted).toEqual([]);
    expect(aNoCond.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-no-edge-conductor",
    });

    // 3. Continuation whose printed destination zone is false (A1 instead of real A6)
    const { g: gBadDest, context: ctxBadDest } = validLeftContinuationScenario({
      headerText: "C009 / 04.A1",
    });
    const aBadDest = zoneGutterAudit(gBadDest, ctxBadDest);
    expect(aBadDest.contracted).toEqual([]);
    expect(aBadDest.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-unverified-destination",
    });
  });

  it("verifies textOnly HTML geometry against paired SVG shapes without weakening HTML text checks", () => {
    const { g: svgG, context } = validLeftContinuationScenario();
    const htmlG = { ...svgG, shapes: [] };
    const passAudit = zoneGutterAudit(htmlG, {
      ...context,
      geometries: [htmlG],
      shapeGeometry: svgG,
    });
    expect(passAudit.findings).toEqual([]);
    expect(passAudit.contracted).toHaveLength(1);

    const { g: shiftedHtml } = validLeftContinuationScenario({
      labelLeft: 14.675 + 1.4,
      shapes: [],
    });
    const shiftedAudit = zoneGutterAudit(shiftedHtml, {
      ...context,
      geometries: [shiftedHtml],
      shapeGeometry: svgG,
    });
    expect(shiftedAudit.contracted).toEqual([]);
    expect(shiftedAudit.findings[0]).toMatchObject({
      kind: "text-in-zone-gutter",
      reason: "continuation-rule-clearance",
    });
  });
});
