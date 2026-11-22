import { expect, it } from "vitest";
import { textInZoneGutter } from "./zone-gutter.mjs";

const text = (value, extra = {}) => ({
  element: `text-${value}`,
  text: value,
  bbox: { x: 20, y: 30, w: 10, h: 3 },
  font: "Noto Sans",
  fontSize: 2.6,
  role: "",
  ...extra,
});

it("DQ-02 kills non-zone text in the zone gutter while passing field text and zone marks", () => {
  const frame = { x: 10, y: 10, w: 259, h: 195 };
  const headerRule = { y: 18 };
  const titleBlock = { x: 160, y: 185, w: 109, h: 20 };
  const zoneNums = [1, 2, 3, 4, 5, 6].map((n, i) =>
    text(String(n), {
      element: `zn-${n}`,
      sheetText: true,
      anchor: { x: 46 + i * 36, y: 24 },
      bbox: { x: 45 + i * 36, y: 21, w: 2, h: 2.5 },
    }),
  );
  const zoneLetters = ["A", "B", "C", "D"].map((l, i) =>
    text(l, {
      element: `zl-${l}`,
      sheetText: true,
      anchor: { x: 13.5, y: 50 + i * 36 },
      bbox: { x: 12.5, y: 48 + i * 36, w: 2, h: 2.5 },
    }),
  );
  const fieldText = text("T1/R1", {
    element: "field-1",
    bbox: { x: 29.4, y: 50, w: 7.2, h: 2.2 },
  });
  const gutterText = text("T1/R1", {
    element: "gutter-1",
    bbox: { x: 19.0, y: 50, w: 7.2, h: 2.2 },
  });
  const base = { width: 279, height: 215, frame, headerRule, titleBlock };
  expect(
    textInZoneGutter({ ...base, texts: [...zoneNums, ...zoneLetters, fieldText] }),
  ).toEqual([]);
  const findings = textInZoneGutter({
    ...base,
    texts: [...zoneNums, ...zoneLetters, gutterText],
  });
  expect(findings.map((f) => f.kind)).toEqual(["text-in-zone-gutter"]);
  expect(findings[0].intrusionMm).toBeCloseTo(9.0, 2);
});
