import { describe, expect, it } from "vitest";
import {
  headingClearanceFindings,
  legendOutsideLocationFindings,
  locationFragmentCaptionFindings,
} from "./headings-and-locations.mjs";
import { wirePlacement } from "./checks.mjs";

const text = (value, bbox, extra = {}) => ({
  element: `text-${value}`,
  text: value,
  bbox,
  font: "Noto Sans",
  fontSize: 2.5,
  painted: true,
  ...extra,
});

describe("V5-CLEAR headings, locations, legend and ownership checks", () => {
  it("kills CONTINUED LOCATION header gaps below 1.5 mm and passes >= 1.5 mm", () => {
    const header = text("CONTINUED LOCATION: MAIN-PANEL", {
      x: 28,
      y: 36.2,
      w: 44,
      h: 1.84,
    });
    const tightCont = text("1A", { x: 40, y: 39.06, w: 6, h: 1.8 });
    const clearCont = text("1A", { x: 40, y: 39.8, w: 6, h: 1.8 });
    expect(headingClearanceFindings({ texts: [header, clearCont] })).toEqual(
      [],
    );
    const bad = headingClearanceFindings({ texts: [header, tightCont] });
    expect(bad.map((f) => f.kind)).toEqual(["heading-clearance-violation"]);
    expect(bad[0].gapMm).toBeCloseTo(1.02, 2);
  });

  it("kills inline document heading crowding against assembly label plates", () => {
    const plate = {
      element: "plate-1",
      bbox: { x: 70, y: 62.7, w: 34, h: 15.4 },
    };
    const tightHeading = text(
      "assembly inventory",
      { x: 28, y: 78.67, w: 38, h: 3.1 },
      { documentId: "doc-1", fontSize: 4 },
    );
    // Horizontally overlapping plate at x=70..104:
    const overlappingTight = {
      ...tightHeading,
      bbox: { x: 60, y: 78.67, w: 38, h: 3.1 },
    };
    const overlappingClear = {
      ...tightHeading,
      bbox: { x: 60, y: 80.06, w: 38, h: 3.1 },
    };
    expect(
      headingClearanceFindings({
        texts: [overlappingClear],
        assemblyLabelPlates: [plate],
      }),
    ).toEqual([]);
    const bad = headingClearanceFindings({
      texts: [overlappingTight],
      assemblyLabelPlates: [plate],
    });
    expect(bad.map((f) => f.kind)).toEqual(["heading-clearance-violation"]);
    expect(bad[0].gapMm).toBeCloseTo(0.57, 2);
  });

  it("kills a device legend overlapping a location-frame and passes exterior placement", () => {
    const loc = {
      element: "loc-1",
      bbox: { x: 30, y: 40, w: 120, h: 100 },
      occupied: true,
      hasLocalCaption: true,
    };
    const insideLegend = {
      element: "leg-1",
      bbox: { x: 100, y: 60, w: 40, h: 30 },
    };
    const outsideLegend = {
      element: "leg-1",
      bbox: { x: 160, y: 60, w: 40, h: 30 },
    };
    expect(
      legendOutsideLocationFindings({
        legendBoxes: [outsideLegend],
        locationFrames: [loc],
      }),
    ).toEqual([]);
    expect(
      legendOutsideLocationFindings({
        legendBoxes: [insideLegend],
        locationFrames: [loc],
      }).map((f) => f.kind),
    ).toEqual(["legend-inside-location-frame"]);
  });

  it("kills an occupied clipped location fragment without a local caption", () => {
    const unlabeled = {
      element: "loc-1",
      bbox: { x: 30, y: 40, w: 80, h: 60 },
      occupied: true,
      hasLocalCaption: false,
    };
    const labeled = { ...unlabeled, hasLocalCaption: true };
    const unoccupied = { ...unlabeled, occupied: false };
    expect(
      locationFragmentCaptionFindings({
        locationFrames: [labeled, unoccupied],
      }),
    ).toEqual([]);
    expect(
      locationFragmentCaptionFindings({ locationFrames: [unlabeled] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["unlabeled-location-fragment"]);
  });

  it("kills ambiguous wire/jumper caption ownership near a foreign junction (Murr 28501 FIXED2)", () => {
    const shapes = [
      {
        element: "w4",
        conductor: true,
        wire: "W4",
        stroke: 0.32,
        points: [
          { x: 44, y: 61.106 },
          { x: 85.765, y: 61.106 },
        ],
      },
      {
        element: "fixed2",
        conductor: true,
        wire: "FIXED2",
        stroke: 0.55,
        points: [
          { x: 85.765, y: 61.106 },
          { x: 74.01, y: 61.106 },
          { x: 74.01, y: 77.106 },
          { x: 85.765, y: 77.106 },
        ],
      },
    ];
    // Old-engine placement: 0.50 mm from FIXED2 vertical leg, 0.585 mm under W4.
    const ambiguous = text(
      "FIXED2",
      { x: 64.853, y: 61.851, w: 8.382, h: 2.31 },
      { wire: "FIXED2" },
    );
    // New-engine placement: centered along FIXED2 vertical leg, far from W4.
    const unambiguous = text(
      "FIXED2",
      { x: 64.853, y: 67.95, w: 8.382, h: 2.31 },
      { wire: "FIXED2" },
    );
    expect(wirePlacement({ shapes, texts: [unambiguous] })).toEqual([]);
    const bad = wirePlacement({ shapes, texts: [ambiguous] });
    expect(bad.map((f) => [f.kind, f.reason])).toEqual([
      ["ambiguous-wire-label", "foreign-wire-ownership-margin"],
    ]);
  });
});
