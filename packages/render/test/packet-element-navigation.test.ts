import { beforeAll, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { mirrorFixture } from "./packet-mirror-fixture.js";
import { finalizeNavigation } from "../src/packet/navigation-finalize.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { parseSvg } from "./off-view-fixtures.js";
import { printedFunction } from "../src/print-projection.js";
import { readFile } from "node:fs/promises";
import { printedElementInk } from "./packet-element-print-fixture.js";
import {
  anchorDistance,
  boxDistance,
} from "../src/packet/navigation-symbols.js";
import { navigationPlacementFamily } from "../src/packet/navigation-placement.js";

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
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(JSON.stringify(result.error));
  return { ...result.value, fixture: f };
}
it.each([
  {
    tag: "K1",
    keys: ["pole1", "pole2", "pole3"],
    roles: [
      "NO contact 1/L1–2/T1",
      "NO contact 3/L2–4/T2",
      "NO contact 5/L3–6/T3",
    ],
    locators: 0,
  },
  {
    tag: "OL1",
    keys: ["pole1", "aux95"],
    roles: ["Overload element 1/L1–2/T1", "NC contact 95–96"],
    locators: 2,
  },
])(
  "distinguishes contactor main contacts from protection elements ($tag)",
  ({ tag, keys, roles, locators }) => {
    const device = ir.devices.find((d) => d.designation === tag);
    expect(device).toBeDefined();
    if (!device) throw Error("Missing native role-boundary fixture device");
    const type = ir.deviceTypes.find((t) => t.id === device.typeId);
    expect(
      keys.map((key) => {
        const fn = ir.functions.find(
          (f) => f.id.deviceUid === device.uid && f.id.functionKey === key,
        );
        if (!fn) throw Error("Missing native role-boundary fixture function");
        return printedFunction(fn, type);
      }),
    ).toEqual(roles);
    const r = finish(
      keys.map((key) => [{ uid: device.uid, key, x: 160, y: 100 }]),
    );
    expect(r.navigation.occurrences).toHaveLength(keys.length);
    expect(
      r.navigation.occurrences.every((o) => o.role === "full-function"),
    ).toBe(true);
    expect(
      r.navigation.annotations.filter((a) => a.role === "element-location"),
    ).toHaveLength(locators);
  },
);
it("locates all three power elements reciprocally from the native 95–96 contact without implying actuation", () => {
  const r = finish(),
    annotations = r.navigation.annotations.filter(
      (a) => a.role === "element-location",
    );
  // These three fixture functions have separate drawn bodies, so each owns a locator.
  expect(annotations).toHaveLength(4);
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
it("prints each multi-element role once while retaining every native terminal set and destination", () => {
  const r = finish([
    [placement("pole1", 40)],
    [placement("pole2", 130)],
    [placement("pole3", 220)],
    [placement("aux95", 160)],
  ]);
  const aux = r.navigation.occurrences.find(
    (o) => o.source.functionKey === "aux95",
  );
  const locator = r.navigation.annotations.find(
    (a) => a.role === "element-location" && a.ownerOccurrence === aux?.id,
  );
  expect(locator).toBeDefined();
  expect(locator?.text.match(/Overload element/g)).toHaveLength(1);
  expect(locator?.text.replaceAll("\n", " ")).toBe(
    "OL1: Overload element 1/L1–2/T1 → 01.B1 3/L2–4/T2 → 02.B3 5/L3–6/T3 → 03.B4",
  );
  expect(locator?.targets).toHaveLength(3);
  const reservation = r.navigation.reservations.find(
    (s) => s.id === locator?.reservationId,
  );
  expect(reservation?.shapes?.length).toBeGreaterThan(0);
  for (const shape of reservation?.shapes ?? [])
    for (const form of shape.maximumForms)
      expect(
        form.replaceAll("\n", " ").match(/Overload element/g),
      ).toHaveLength(1);
});
it("keeps a shared native locator within 60 mm of every overload pole, not just their centroid", async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const request = JSON.parse(
    await readFile("examples/alpha/motor-starter.packet.json", "utf8"),
  );
  const result = await renderSchematicPacket(compiled.ir, request);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.sheets).toHaveLength(7);
  const navigation = result.value.navigation;
  if (!navigation) throw Error("Missing native navigation");
  const device = compiled.ir.devices.find((d) => d.designation === "OL1");
  const poles = navigation.occurrences.filter(
    (o) =>
      o.source.deviceUid === device?.uid && /^pole/.test(o.source.functionKey),
  );
  expect(poles).toHaveLength(3);
  const locatorIds = new Set<string>();
  for (const pole of poles) {
    const locator = navigation.annotations.find(
      (a) =>
        a.role === "element-location" && a.ownerOccurrences.includes(pole.id),
    );
    expect(locator).toBeDefined();
    const box = navigation.reservations.find(
      (r) => r.id === locator?.reservationId,
    )?.allocatedMm?.rect;
    if (!locator || !box) throw Error("Missing element locator ink");
    locatorIds.add(locator.id);
    expect(
      anchorDistance(
        pole.destination.anchorMm,
        printedElementInk(
          result.value.sheets[pole.destination.sheet - 1]?.svg ?? "",
          locator.id,
          box,
        ).ink,
      ),
    ).toBeLessThanOrEqual(60);
  }
  expect(locatorIds.size).toBe(1);
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

function elementLocator(
  value: {
    navigation: {
      occurrences: readonly { id: string; source: { functionKey: string } }[];
      annotations: readonly {
        id: string;
        role: string;
        ownerOccurrence: string;
        reservationId: string;
        text: string;
        locality?: { frameMm: { x: number; y: number; w: number; h: number } };
      }[];
      reservations: readonly {
        id: string;
        allocatedMm?: {
          placement?: string;
          rect: { x: number; y: number; w: number; h: number };
        };
      }[];
    };
  },
  key: string,
) {
  const occ = value.navigation.occurrences.find(
    (o) => o.source.functionKey === key,
  );
  const ann = value.navigation.annotations.find(
    (a) => a.role === "element-location" && a.ownerOccurrence === occ?.id,
  );
  const res = value.navigation.reservations.find(
    (r) => r.id === ann?.reservationId,
  );
  return { occ, ann, res };
}

function circuitAttachmentSvg(m1Uid: string, k1Uid: string) {
  const plcFrame = { x: 30, y: 63, w: 48, h: 14 };
  const ol1Glyph = { x: 123, y: 67.5, w: 8, h: 3 };
  const k1Glyph = { x: 229, y: 66.5, w: 8, h: 4.5 };
  const body = [
    `<g data-device-uid="${m1Uid}"><rect class="circuit-device-frame" x="${plcFrame.x}" y="${plcFrame.y}" width="${plcFrame.w}" height="${plcFrame.h}" fill="white" stroke="#667085"/></g>`,
    `<g id="scope-ol1" transform="translate(114 67)">`,
    `<g id="native-0" data-navigation-native="native-0" data-device-uid="${uid}" data-function-key="aux95">`,
    `<g data-circuit-mark="contact-nc" stroke="#17212b" stroke-width="0.4" fill="none"><rect x="9" y="0.5" width="8" height="3"/></g>`,
    `<g data-terminal-attachment="[&quot;ol&quot;,&quot;95&quot;]"><path d="M 0 2 L 9 2" stroke="#17212b" stroke-width="0.32"/></g>`,
    `<g data-terminal-attachment="[&quot;ol&quot;,&quot;96&quot;]"><path d="M 26 2 L 17 2" stroke="#17212b" stroke-width="0.32"/></g>`,
    `</g>`,
    `<circle id="native-0-pin-0" data-device-uid="${uid}" data-terminal-key="95" cx="0" cy="2" r="0.7"/>`,
    `<circle id="native-0-pin-1" data-device-uid="${uid}" data-terminal-key="96" cx="26" cy="2" r="0.7"/>`,
    `</g>`,
    `<g id="scope-k1" transform="translate(192 66)">`,
    `<g id="native-1" data-navigation-native="native-1" data-device-uid="${k1Uid}" data-function-key="coil">`,
    `<g data-circuit-mark="coil" stroke="#17212b" stroke-width="0.4" fill="none"><rect x="37" y="0.5" width="8" height="4.5"/></g>`,
    `<g data-terminal-attachment="[&quot;k1&quot;,&quot;A1&quot;]"><path d="M 0 2.5 L 37 2.5" stroke="#17212b" stroke-width="0.32"/></g>`,
    `<g data-terminal-attachment="[&quot;k1&quot;,&quot;A2&quot;]"><path d="M 82 2.5 L 45 2.5" stroke="#17212b" stroke-width="0.32"/></g>`,
    `</g>`,
    `<circle id="native-1-pin-0" data-device-uid="${k1Uid}" data-terminal-key="A1" cx="0" cy="2.5" r="0.7"/>`,
    `<circle id="native-1-pin-1" data-device-uid="${k1Uid}" data-terminal-key="A2" cx="82" cy="2.5" r="0.7"/>`,
    `</g>`,
    `<rect x="0" y="0" width="360" height="31" fill="black"/>`,
    `<rect x="30" y="32" width="118" height="30" fill="black"/>`,
    `<rect x="193" y="32" width="160" height="30" fill="black"/>`,
    `<rect x="112" y="74" width="160" height="55" fill="black"/>`,
    `<rect x="30" y="122" width="160" height="25" fill="black"/>`,
  ].join("");
  return {
    svg: `<svg width="360mm" height="240mm" viewBox="0 0 360 240"><g data-navigation-view="view-1">${body}</g></svg>`,
    plcFrame,
    ol1Glyph,
    k1Glyph,
  };
}

function circuitAttachmentFixture() {
  const k1 = ir.devices.find((d) => d.designation === "K1");
  const m1 = ir.devices.find((d) => d.designation === "M1");
  if (!k1 || !m1) throw Error("Missing circuit fixture devices");
  const f = mirrorFixture(ir, [
    [placement("pole1", 40), placement("pole2", 130), placement("pole3", 220)],
    [
      { uid, key: "aux95", x: 114, y: 67 },
      { uid: k1.uid, key: "coil", x: 192, y: 66 },
    ],
  ]);
  f.drafts[1]!.navigationSeeds = f.drafts[1]!.navigationSeeds!.map((seed) =>
    seed.source.deviceUid === uid
      ? {
          ...seed,
          representation: "circuit",
          terminalScopeId: "scope-ol1",
          body: { x: 0, y: 0, w: 26, h: 3 },
          terminals: [
            { key: "95", primitiveId: "native-0-pin-0" },
            { key: "96", primitiveId: "native-0-pin-1" },
          ],
        }
      : {
          ...seed,
          representation: "circuit",
          terminalScopeId: "scope-k1",
          body: { x: 0, y: 0, w: 82, h: 5 },
          terminals: [
            { key: "A1", primitiveId: "native-1-pin-0" },
            { key: "A2", primitiveId: "native-1-pin-1" },
          ],
        },
  );
  const { svg, plcFrame, ol1Glyph, k1Glyph } = circuitAttachmentSvg(
    m1.uid,
    k1.uid,
  );
  f.sheets[1] = { ...f.sheets[1]!, svg };
  return { f, plcFrame, ol1Glyph, k1Glyph };
}

it("falls back to zone-column self-located placement when local space around a single element is blocked, while unblocked control stays local", () => {
  const pages = [
    [placement("pole1", 40), placement("pole2", 130), placement("pole3", 220)],
    [{ uid, key: "aux95", x: 114, y: 74 }],
  ];
  const controlFixture = mirrorFixture(ir, pages);
  const control = finalizeNavigation(
    controlFixture.ir,
    controlFixture.drafts,
    controlFixture.sheets,
  );
  expect(control.ok).toBe(true);
  if (!control.ok) return;
  const ctrl = elementLocator(control.value, "aux95");
  expect(ctrl.res?.allocatedMm?.placement).toBe("local");
  expect(ctrl.ann?.text.startsWith("OL1: Overload element")).toBe(true);
  expect(ctrl.res?.allocatedMm?.rect).toEqual({
    x: 72.913376,
    y: 86.98452,
    w: 39.941,
    h: 20.2,
  });

  const blocked = mirrorFixture(ir, pages);
  const blockers = [
    { x: 40, y: 8, w: 170, h: 62 },
    { x: 40, y: 70, w: 72, h: 20 },
    { x: 136, y: 70, w: 74, h: 20 },
    { x: 40, y: 90, w: 170, h: 66 },
  ];
  const blockerSvg = blockers
    .map(
      (b) =>
        `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="black"/>`,
    )
    .join("");
  blocked.sheets[1] = {
    ...blocked.sheets[1]!,
    svg: blocked.sheets[1]!.svg.replace("</svg>", `${blockerSvg}</svg>`),
  };

  const result = finalizeNavigation(blocked.ir, blocked.drafts, blocked.sheets);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { ann, res } = elementLocator(result.value, "aux95");
  expect(res?.allocatedMm?.placement).toBe("self-located");
  expect(ann?.text).toMatch(/^OL1 \(02\.[A-D][1-6]\): Overload element/);
  for (const pair of ["1/L1–2/T1", "3/L2–4/T2", "5/L3–6/T3"])
    expect(ann?.text).toContain(pair);
  const box = res?.allocatedMm?.rect;
  if (!box || !ann?.locality) throw Error("Missing fallback element box");
  const family = navigationPlacementFamily(
    box,
    blocked.drafts[1]!.drawingBounds!,
    ann.locality.frameMm,
  );
  expect(["zone-column", "margin-band"]).toContain(family);
  for (const b of blockers)
    expect(boxDistance(box, b)).toBeGreaterThanOrEqual(1.5);
});

it("excludes circuit terminal attachment leads from frameless element-location nearest-owner bounds", () => {
  const { f, plcFrame, ol1Glyph, k1Glyph } = circuitAttachmentFixture();
  const result = finalizeNavigation(f.ir, f.drafts, f.sheets);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { ann, res } = elementLocator(result.value, "aux95");
  expect(res?.allocatedMm?.placement).toBe("local");
  const printed = printedElementInk(
    result.value.sheets[1]!.svg,
    ann!.id,
    res!.allocatedMm!.rect,
  ).ink;
  expect(boxDistance(printed, ol1Glyph)).toBeLessThan(
    boxDistance(printed, plcFrame),
  );
  expect(boxDistance(printed, ol1Glyph)).toBeLessThan(
    boxDistance(printed, k1Glyph),
  );
});
