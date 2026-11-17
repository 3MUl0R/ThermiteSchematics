import { expect, it } from "vitest";
import { compileProject } from "@thermite/compiler";
import { parseHTML } from "linkedom";
import { renderSchematicSheets } from "../src/sheets.js";

it("nests XT-HMI bridge spans and separates wire leaders without strip growth", async () => {
  const c = await compileProject("examples/operator-console");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  const r = await renderSchematicSheets(
    c.ir,
    {
      format: "documentation-view-request/0.1",
      kind: "terminals",
      device: "XT-HMI",
    },
    undefined,
    { size: "a3", orientation: "portrait" },
  );
  if (!r.ok) throw Error(JSON.stringify(r.error));
  const strips = r.value.sheets.filter((s) => s.view.kind === "terminal-strip");
  expect(strips).toHaveLength(1);
  const doc = parseHTML(strips[0]!.svg).document;
  const bridges = [
    ...doc.querySelectorAll("[data-strip-jumper]:not([data-strip-jumper-end])"),
  ].map((g) => {
    const numbers = g
      .querySelector("path")!
      .getAttribute("d")!
      .match(/-?[\d.]+/gu)!
      .map(Number);
    return {
      uid: g.getAttribute("data-strip-jumper"),
      top: Math.min(numbers[1]!, numbers[3]!),
      bottom: Math.max(numbers[1]!, numbers[3]!),
      lane: numbers[2]!,
      token: g.querySelector("text")!.textContent,
    };
  });
  for (const outer of bridges)
    for (const inner of bridges)
      if (outer.top < inner.top && outer.bottom > inner.bottom)
        expect(outer.lane).toBeGreaterThan(inner.lane);
  for (const terminal of doc.querySelectorAll("[data-strip-terminal]")) {
    const key = terminal.getAttribute("data-strip-terminal");
    const rect = terminal.querySelector("rect")!;
    const centre =
      Number(rect.getAttribute("y")) + Number(rect.getAttribute("height")) / 2;
    const paths = [...doc.querySelectorAll("[data-strip-incidence]")]
      .filter((g) => g.getAttribute("data-strip-at") === key)
      .map((g) =>
        g
          .querySelector("path")!
          .getAttribute("d")!
          .match(/-?[\d.]+/gu)!
          .map(Number),
      );
    const starts = paths.map((n) => `${n[0]},${n[1]}`);
    expect(new Set(starts).size).toBe(starts.length);
    for (const p of paths)
      expect(Math.abs(p[1]! - centre)).toBeGreaterThan(0.5);
    const perSide = new Map<number, number[]>();
    for (const p of paths) {
      const a = perSide.get(p[0]!) ?? [];
      a.push(p[2]!);
      perSide.set(p[0]!, a);
    }
    for (const elbows of perSide.values())
      expect(new Set(elbows).size).toBe(elbows.length);
  }
});
