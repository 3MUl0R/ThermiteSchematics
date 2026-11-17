import { beforeAll, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { mirrorFixture } from "./packet-mirror-fixture.js";
import { finalizeNavigation } from "../src/packet/navigation-finalize.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { parseSvg } from "./off-view-fixtures.js";

let ir: ElectricalIr, uid: string;
beforeAll(async () => {
  const c = await compileProject("examples/conveyor-line");
  if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
  ir = c.ir;
  uid = ir.devices.find((d) => d.designation === "OL1")?.uid ?? "";
  expect(uid).not.toBe("");
});
const placement = (key: string, x: number) => ({ uid, key, x, y: 100 });
function finish(
  pages = [
    [placement("pole1", 40), placement("pole2", 130), placement("pole3", 220)],
    [placement("aux95", 160)],
  ],
) {
  const f = mirrorFixture(ir, pages);
  const result = finalizeNavigation(f.ir, f.drafts, f.sheets);
  if (!result.ok) throw Error(JSON.stringify(result.error));
  return { ...result.value, fixture: f };
}
it("locates all three power elements reciprocally from the native 95–96 contact without implying actuation", () => {
  const r = finish(),
    annotations = r.navigation.annotations.filter(
      (a) => a.role === "element-location",
    );
  expect(annotations).toHaveLength(2);
  expect(annotations.flatMap((a) => a.ownerOccurrences)).toHaveLength(4);
  for (const owner of r.navigation.occurrences) {
    const a = annotations.find((a) => a.ownerOccurrences.includes(owner.id));
    expect(a).toBeDefined();
    const targets = a?.targets.map((id) =>
      r.navigation.occurrences.find((o) => o.id === id),
    );
    expect(targets?.every((o) => o?.source.deviceUid === uid)).toBe(true);
    const aux = owner.source.functionKey === "aux95";
    expect(targets?.map((o) => o?.source.functionKey).sort()).toEqual(
      aux ? ["pole1", "pole2", "pole3"] : ["aux95"],
    );
    expect(a?.text).toContain(aux ? "Overload element" : "NC contact 95–96");
    expect(a?.text).not.toMatch(/actuat|coil|thermal|electronic/i);
    if (aux)
      for (const pair of ["1/L1–2/T1", "3/L2–4/T2", "5/L3–6/T3"])
        expect(a?.text).toContain(pair);
    for (const target of targets ?? []) {
      expect(a?.text).toContain(
        `${String(target?.destination.sheet).padStart(2, "0")}.${target?.destination.zone}`,
      );
      expect(
        annotations.find((b) => b.ownerOccurrences.includes(target?.id ?? ""))
          ?.targets,
      ).toContain(owner.id);
    }
    const doc = parseSvg(r.sheets[owner.destination.sheet - 1]?.svg ?? "");
    const ink = doc.querySelector(`[data-navigation-annotation="${a?.id}"]`);
    expect(ink?.textContent).toBe(a?.text.replaceAll("\n", ""));
  }
  expect(
    r.navigation.annotations.some((a) => ["mirror", "return"].includes(a.role)),
  ).toBe(false);
});
it("does not invent an undrawn auxiliary or connect a similarly tagged different UID", () => {
  const r = finish([[placement("pole1", 40)]]);
  expect(
    r.navigation.annotations.filter((a) => a.role === "element-location"),
  ).toEqual([]);
  const c = structuredClone(ir),
    foreign = c.functions.find(
      (f) => f.id.deviceUid !== uid && f.id.functionKey === "aux95",
    );
  expect(foreign).toBeDefined();
  const f = mirrorFixture(c, [
    [placement("pole1", 40)],
    [{ uid: foreign?.id.deviceUid ?? "", key: "aux95", x: 160, y: 100 }],
  ]);
  const result = finalizeNavigation(f.ir, f.drafts, f.sheets);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(
      result.value.navigation.annotations.filter(
        (a) => a.role === "element-location",
      ),
    ).toEqual([]);
});
it("keeps every repeated power destination and ignores hidden full targets", () => {
  const r = finish([
    [placement("pole1", 40)],
    [placement("aux95", 160)],
    [placement("pole1", 220)],
  ]);
  const aux = r.navigation.occurrences.find(
    (o) => o.source.functionKey === "aux95",
  );
  const a = r.navigation.annotations.find(
    (a) => a.role === "element-location" && a.ownerOccurrence === aux?.id,
  );
  expect(a?.targets).toHaveLength(2);
  expect(a?.text).toContain("01.");
  expect(a?.text).toContain("03.");
  const f = mirrorFixture(ir, [
    [placement("pole1", 40)],
    [placement("aux95", 160)],
  ]);
  const hidden = f.sheets.at(1);
  if (!hidden) throw Error("Missing hidden-target plate");
  f.sheets[1] = {
    ...hidden,
    svg: hidden.svg.replace('class="symbol', 'display="none" class="symbol'),
  };
  const result = finalizeNavigation(f.ir, f.drafts, f.sheets);
  expect(result.ok).toBe(false);
});
it.each(["left-to-right", "top-to-bottom"] as const)(
  "adds native element locations in issued conveyor output (%s)",
  async (flow) => {
    const request = {
      format: "schematic-packet-request/0.1",
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow,
        },
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "K1" },
          family: "control",
          flow,
        },
      ],
    } as const;
    const before = JSON.stringify(ir),
      result = await renderSchematicPacket(ir, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const annotations =
      result.value.navigation?.annotations.filter(
        (a) => a.role === "element-location",
      ) ?? [];
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations.map((a) => a.text).join(" ")).toContain("95–96");
    expect(JSON.stringify(ir)).toBe(before);
  },
);
