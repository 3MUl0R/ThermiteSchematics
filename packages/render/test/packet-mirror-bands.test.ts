import { expect, it } from "vitest";
import { navigationPlacementFamily } from "../src/packet/navigation-placement.js";
import {
  allocateNavigationSlots,
  NavigationSlotFailure,
  type SheetSlotRequest,
} from "../src/packet/navigation-slots.js";
const field = { x: 0, y: 0, w: 360, h: 240 },
  owner = { x: 100, y: 100, w: 20, h: 20 };
const locality = {
  anchorMm: { x: 110, y: 110 },
  frameMm: owner,
  framesMm: [],
  ownerLocation: { sheet: 1, zone: "B2" },
};
it.each([
  [{ x: 125, y: 100, w: 55, h: 25 }, "beside"],
  [{ x: 100, y: 125, w: 55, h: 25 }, "below"],
  [{ x: 125, y: 125, w: 55, h: 25 }, "below-right"],
  [{ x: 0, y: 100, w: 35, h: 25 }, "zone-column"],
  [{ x: 100, y: 0, w: 55, h: 25 }, "margin-band"],
] as const)("classifies literal measured box %j as %s", (box, family) => {
  expect(navigationPlacementFamily(box, field, owner, locality)).toBe(family);
});
const request = (): SheetSlotRequest => ({
  owner,
  locality,
  preferBesideBelow: true,
  reservation: {
    id: "literal",
    ownerAppearance: "literal",
    ownerOccurrence: "literal",
    profileId: "literal",
    space: "sheet-slot",
    inkMm: { x: 0, y: 0, w: 55, h: 25 },
    maximumForms: ["literal"],
  },
});
it.each(["zone-column", "margin-band"] as const)(
  "exports the %s band family independently of locality",
  (family) => {
    const r = request();
    r.families = [family];
    const result = allocateNavigationSlots(
      [r],
      field,
      '<svg viewBox="0 0 360 240"><rect x="100" y="100" width="20" height="20" fill="black"/></svg>',
      1,
    )[0]!;
    expect(result.allocatedMm).toMatchObject({
      family,
      familyRule: "approach-or-outer-zone-row/1",
    });
  },
);
it("reports measured blocked vacancy for every approved family without relaxing a slot", () => {
  const r = request();
  r.locality = undefined;
  try {
    allocateNavigationSlots(
      [r],
      { x: 0, y: 0, w: 60, h: 60 },
      '<svg viewBox="0 0 60 60"><rect width="30" height="60" fill="black"/></svg>',
      1,
    );
    throw Error("unexpected fit");
  } catch (error) {
    expect(error).toBeInstanceOf(NavigationSlotFailure);
    const search = (error as NavigationSlotFailure).search as {
      families: {
        family: string;
        maximumClearWidthAtRequiredHeightMm: number;
      }[];
    };
    expect(search.families.map((r) => r.family)).toEqual([
      "beside",
      "below",
      "below-right",
      "zone-column",
      "margin-band",
    ]);
    expect(
      Math.max(
        ...search.families.map((r) => r.maximumClearWidthAtRequiredHeightMm),
      ),
    ).toBeGreaterThan(28.49);
    expect(
      Math.max(
        ...search.families.map((r) => r.maximumClearWidthAtRequiredHeightMm),
      ),
    ).toBeLessThanOrEqual(28.5);
  }
});
