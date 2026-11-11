import { beforeAll, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { addDeviceLegend } from "../src/device-legend.js";
import { planDeviceTag } from "../src/device-tags.js";
import { placeLegend, legendColumns } from "../src/device-legend/placement.js";
import { generatedSvgInk } from "../src/device-legend/svg-ink.js";
import { renderSchematic } from "../src/renderer.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { parseHTML } from "linkedom";
let ir: ElectricalIr;
beforeAll(async () => {
  const c = await compileProject("examples/motor-starter");
  if (!c.ok) throw c;
  ir = c.ir;
});
const view = {
  format: "schematic-view-request/0.1" as const,
  root: { by: "designation" as const, value: "M1" },
  family: "power" as const,
  flow: "top-to-bottom" as const,
};
function tag() {
  const d = ir.devices.find((d) => d.designation === "M1")!,
    p = planDeviceTag(
      d,
      ir.deviceTypes.find((t) => t.id === d.typeId)!,
      50,
    );
  if (!p.ok) throw p;
  return p.value;
}
const area = { x: 10, y: 10, w: 180, h: 180 };
function source(obstacle = "") {
  const t = tag();
  return `<svg viewBox="0 0 200 200"><g class="device-group" data-device-uid="${t.ownerUid}"><rect class="device-frame" x="20" y="20" width="20" height="20" fill="white" stroke="black"/><text x="22" y="25" font-size="2.5" data-tag-owner-uid="${t.ownerUid}" data-tag-kind="body" data-tag-key="M1">M1</text></g>${obstacle}</svg>`;
}
it("prefers top-right, then bottom-right and reserves 3 mm around the frame", () => {
  const first = placeLegend([tag()], area, [], [])!;
  expect(first.box.x + first.box.w).toBe(190);
  expect(first.box.y).toBe(10);
  const blocker = { x: 130, y: 5, w: 70, h: 50 },
    second = placeLegend([tag()], area, [blocker], [])!;
  expect(second.box.y + second.box.h).toBe(190);
  expect(second.box.x + second.box.w).toBe(190);
  expect(
    placeLegend([tag()], area, [{ x: 0, y: 0, w: 210, h: 210 }], []),
  ).toBeUndefined();
});
it("protects actual location borders, routes, symbols, cards and gangs through final clipped ink", () => {
  for (const obstacle of [
    '<path d="M 0 100 H 200" stroke="black" fill="none"/>',
    '<rect class="location-frame" x="0" y="0" width="100" height="200" fill="#f7f8fa" stroke="black"/>',
    '<g class="off-view-annotation"><rect x="100" y="0" width="100" height="200" fill="none" stroke="black"/><text x="40" y="80">card</text></g>',
    '<line data-mechanical-association="ganged" x1="0" y1="100" x2="200" y2="100" stroke="black"/>',
  ]) {
    const measured = generatedSvgInk(source(obstacle));
    expect(measured.ink.length).toBeGreaterThan(1);
    const size = legendColumns([tag()], 1).box;
    const b = {
      x: 100 - (size.w + 5) / 2,
      y: 100 - (size.h + 5) / 2,
      w: size.w + 5,
      h: size.h + 5,
    };
    expect(placeLegend([tag()], b, [], [])).not.toBeUndefined();
    expect(
      placeLegend([tag()], b, measured.ink, measured.regions),
    ).toBeUndefined();
  }
  // A hidden copy outside its fold viewport is not physical ink on this sheet.
  const hidden = generatedSvgInk(
    '<svg viewBox="0 0 200 200"><svg x="0" y="0" width="20" height="20" viewBox="0 0 20 20"><rect x="80" y="80" width="20" height="20" fill="black"/></svg></svg>',
  );
  expect(hidden.ink).toEqual([]);
});
it("protects blank card interiors as well as their painted borders and captions", () => {
  const card = generatedSvgInk(
    source(
      '<g class="off-view-annotation" data-off-view-terminal="PS1.+"><rect x="60" y="60" width="135" height="135" fill="none" stroke="black"/><text x="63" y="67" font-size="2.5">Off-view at PS1.+</text></g>',
    ),
  );
  const blank = { x: 100, y: 100, w: 85, h: 85 };
  expect(placeLegend([tag()], blank, [], [])).not.toBeUndefined();
  expect(placeLegend([tag()], blank, card.ink, card.regions)).toBeUndefined();
});
it("emits one complete owned legend per local UID with the exact body key in both flows", async () => {
  for (const flow of ["left-to-right", "top-to-bottom"] as const) {
    const r = await renderSchematicPacket(ir, {
      format: "schematic-packet-request/0.1",
      layout: "compact",
      page: { size: "letter", orientation: "portrait" },
      views: [{ ...view, flow }],
    });
    if (!r.ok) throw r;
    for (const s of r.value.sheets) {
      const doc = parseHTML(s.svg).document,
        entries = [...doc.querySelectorAll("[data-device-legend-entry]")],
        uids = entries.map((e) => e.getAttribute("data-tag-owner-uid"));
      expect(new Set(uids).size).toBe(uids.length);
      for (const e of entries) {
        const uid = e.getAttribute("data-tag-owner-uid"),
          d = ir.devices.find((d) => d.uid === uid)!,
          t = ir.deviceTypes.find((t) => t.id === d.typeId)!;
        expect(
          doc.querySelector(
            `text[data-tag-kind="body"][data-tag-owner-uid="${uid}"]`,
          )!.textContent,
        ).toBe(d.designation);
        for (const [field, value] of Object.entries({
          designation: d.designation,
          description: d.description ?? t.description,
          part: t.catalog?.orderNumber,
        })) {
          const texts = [
            ...e.querySelectorAll(`text[data-tag-field="${field}"]`),
          ];
          expect(
            texts
              .map((t) => t.textContent)
              .join("")
              .trim(),
          ).toBe((value ?? "").trim());
          for (const row of texts) {
            expect(
              Number(row.getAttribute("font-size")),
            ).toBeGreaterThanOrEqual(field === "designation" ? 2.7 : 2.5);
            expect(row.hasAttribute("textLength")).toBe(false);
          }
        }
      }
    }
  }
});
it("uses the same complete legend in continuous SVG without changing prepared geometry", async () => {
  const r = await renderSchematic(ir, view);
  if (!r.ok) throw r;
  const doc = parseHTML(r.value.svg).document;
  expect(doc.querySelector("[data-device-legend]")).not.toBeNull();
  expect(
    doc
      .querySelector('text[data-tag-kind="body"]')!
      .getAttribute("data-tag-field"),
  ).toBeNull();
});
it("keeps long Unicode descriptions and unbroken part numbers literal, or refuses dimensionally", () => {
  const input = structuredClone(ir),
    d = input.devices.find((d) => d.designation === "M1")!,
    t = input.deviceTypes.find((t) => t.id === d.typeId)!;
  d.description = "Δοκιμή λειτουργίας ".repeat(10).trim();
  t.catalog = { ...t.catalog, orderNumber: "PN" + "X".repeat(100) };
  const r = addDeviceLegend(input, source(), area);
  if (!r.ok) throw r;
  const doc = parseHTML(r.value).document;
  expect(
    [...doc.querySelectorAll('text[data-tag-field="description"]')]
      .map((t) => t.textContent)
      .join("")
      .trim(),
  ).toBe(d.description);
  expect(
    [...doc.querySelectorAll('text[data-tag-field="part"]')]
      .map((t) => t.textContent)
      .join(""),
  ).toBe(t.catalog.orderNumber);
  d.description = "Unavoidably long authored description ".repeat(1000);
  const refused = addDeviceLegend(input, source(), {
    x: 0,
    y: 0,
    w: 60,
    h: 60,
  });
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.code).toBe("R006");
    expect(refused.error.message).toMatch(
      /M1.*description.*requires.*available.*mm/,
    );
  }
});
it("returns R006 for a blocked sheet instead of dropping an entry", () => {
  const r = addDeviceLegend(
    ir,
    source('<rect x="0" y="0" width="200" height="200" fill="black"/>'),
    area,
  );
  expect(r.ok).toBe(false);
  if (!r.ok)
    expect(r.error.message).toMatch(/M1.*description.*requires.*available/);
});
