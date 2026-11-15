import { expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { viewportSize } from "../src/packet/viewport-size.js";
import { legacyFooterNote } from "../src/packet/legacy-footer.js";
import { printableTextMetrics } from "../src/symbols/printable-font.js";

it("cannot lose planned em through a rounded viewport dimension", () => {
  for (const span of [100.001, 100.003, 651.721, 1543.387]) {
    const scale = 0.25,
      viewBox = Number(span.toFixed(3));
    const old = Number((span * scale).toFixed(3));
    expect(viewportSize(span, scale)).toBeGreaterThanOrEqual(old);
    expect((viewportSize(span, scale) / viewBox) * 10).toBeGreaterThanOrEqual(
      2.5,
    );
  }
  expect((Number((100.001 * 0.25).toFixed(3)) / 100.001) * 10).toBeLessThan(
    2.5,
  );
});
it("wraps the complete footer into its measured pre-reserved band", () => {
  const note =
    "Whole wires; repeated symbols and terminal IDs describe the same physical equipment. P = group part, S = packet sheet.";
  const rows = legacyFooterNote(note, 14, 119.9, 269.4, 250);
  expect(rows).toHaveLength(2);
  const nodes = [
    ...parseHTML(`<svg>${rows.join("")}</svg>`).document.querySelectorAll(
      "text",
    ),
  ];
  expect(nodes.map((n) => n.textContent).join("")).toBe(note);
  for (const n of nodes) {
    expect(n.getAttribute("font-size")).toBe("2.5");
    expect(
      printableTextMetrics(n.textContent ?? "", 2.5).right,
    ).toBeLessThanOrEqual(119.9);
    expect(Number(n.getAttribute("y"))).toBeGreaterThan(250);
  }
});
