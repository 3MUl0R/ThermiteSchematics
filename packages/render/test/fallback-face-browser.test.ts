import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileProject,
  lockProject,
  type ElectricalIr,
} from "@thermite/compiler";
import { embedPrintableFont } from "../../cli/src/printable-font.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { bounds, frame, normalizePaperPage } from "../src/packet/page.js";
import { continuationInkFailure } from "../src/packet/continuation-fit.js";
import {
  continuationHeaderWidth,
  continuationLabel,
} from "../src/packet/continuation-label.js";
import {
  drawingContextOptions,
  launch,
  openSheet,
} from "../../../evals/draw/browser.mjs";
import {
  overlap,
  textBounds,
  textInZoneGutter,
} from "../../../evals/draw/checks.mjs";
import type { Draft, Link } from "../src/packet/types.js";
import type { NormalizedSchematicView } from "../src/types.js";

let browser: Awaited<ReturnType<typeof launch>>;
let context: Awaited<
  ReturnType<Awaited<ReturnType<typeof launch>>["newContext"]>
>;
let page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>["newPage"]>>;
let baseIr: ElectricalIr;

beforeAll(async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  baseIr = compiled.ir;
  // Accurate Canvas bounds for small-font gutter and edge checks (crbug.com/479240778).
  browser = await launch([
    "--enable-blink-features=CanvasTextMetricsPreciseBounds",
  ]);
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

async function measureSheet(svg: string) {
  return openSheet(page, embedPrintableFont(svg));
}

function assertPreciseBounds(g: Awaited<ReturnType<typeof openSheet>>) {
  if (process.platform !== "darwin") return;
  // Linux and Windows CI may report whole-unit Canvas bounds (#594).
  expect(textBounds(g)).toEqual([]);
}

function cableRequest(marginMm = 10) {
  return {
    format: "schematic-packet-request/0.1" as const,
    index: false,
    page: {
      size: "letter" as const,
      orientation: "portrait" as const,
      marginMm,
    },
    views: [
      {
        format: "schematic-view-request/0.2" as const,
        root: { by: "designation" as const, value: "CBL1" },
        intent: { kind: "conductors" as const },
        flow: "left-to-right" as const,
      },
    ],
  };
}

async function renderCableEndB(toLocation: string, marginMm = 10) {
  const ir = structuredClone(baseIr);
  ir.cables.find((c) => c.designation === "CBL1")!.toLocation = toLocation;
  return renderSchematicPacket(ir, cableRequest(marginMm));
}

async function compileEmojiEndBCableIr() {
  const dir = await mkdtemp(join(tmpdir(), "thermite-fb-cable-"));
  await cp("examples/motor-starter", dir, { recursive: true });
  const endBDes = "B" + "🌐".repeat(8);
  const walk = async (root: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const next = join(root, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(next)));
      else if (entry.name.endsWith(".json")) out.push(next);
    }
    return out;
  };
  for (const file of await walk(dir)) {
    const raw = await readFile(file, "utf8");
    const next = raw.replaceAll('"JB1"', JSON.stringify(endBDes));
    if (next !== raw) await writeFile(file, next);
  }
  const locked = await lockProject(dir);
  if (!locked.ok) throw Error(JSON.stringify(locked));
  const compiled = await compileProject(dir);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const cableType = compiled.ir.cableTypes.find(
    (t) => t.conductors.length > 0,
  )!;
  cableType.conductors[0]!.color = "BN " + "🌐".repeat(12);
  return {
    ir: compiled.ir,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

function makeLetterPortrait() {
  const normalized = normalizePaperPage({
    size: "letter",
    orientation: "portrait",
    marginMm: 10,
  });
  if (!normalized.ok) throw Error(normalized.error.message);
  return normalized.value;
}

function makeCircuitRequest(title: string, notes?: readonly string[]) {
  return {
    format: "schematic-packet-request/0.1" as const,
    index: false,
    page: {
      size: "tabloid" as const,
      orientation: "landscape" as const,
      marginMm: 10,
    },
    views: [
      {
        format: "circuit-view-request/0.1" as const,
        title,
        ...(notes ? { notes } : {}),
        flow: "left-to-right" as const,
        groups: [
          {
            id: "g1",
            label: "Field permissive",
            functions: [
              {
                device: { by: "designation" as const, value: "JB1" },
                key: "terminal1",
              },
              {
                device: { by: "designation" as const, value: "LS1" },
                key: "contact13",
              },
              {
                device: { by: "designation" as const, value: "JB1" },
                key: "terminal2",
              },
            ],
            conductors: ["W-FLD-001", "W-FLD-002"],
          },
        ],
      },
    ],
  };
}

describe("fallback-face browser regressions (#555, #556)", () => {
  it("keeps leading '🌐 test' and partial cluster 'A⃝ test' out of the left gutter with negative control (#555)", async () => {
    const packet = await renderSchematicPacket(
      baseIr,
      makeCircuitRequest("Field-left fallback probe", ["🌐 test"]),
    );
    expect(packet.ok, JSON.stringify(packet.ok ? null : packet.error)).toBe(
      true,
    );
    if (!packet.ok) return;
    const svg = packet.value.sheets[0]!.svg;
    const g = await measureSheet(svg);
    expect(textInZoneGutter(g)).toEqual([]);
    assertPreciseBounds(g);
    const note = g.texts.find((t) => t.text === "🌐 test");
    expect(note).toBeDefined();
    expect(note!.bbox.x).toBeGreaterThanOrEqual(28.0);
    expect(note!.bbox.x + note!.bbox.w).toBeLessThanOrEqual(403.8);

    // Negative control: a note anchored 0.5 mm inside the gutter fails DQ-02.
    // At x="28" the result depends on the platform emoji face's left bearing
    // (Apple Color Emoji crosses; the Linux and Windows CI faces do not), so
    // the control starts past the field edge on every platform.
    const uninset = svg.replace(
      /(<text\b[^>]*\bx=")29\.43("[^>]*>🌐 test<\/text>)/u,
      "$127.5$2",
    );
    expect(uninset).not.toBe(svg);
    const bad = await measureSheet(uninset);
    expect(textInZoneGutter(bad)).toContainEqual(
      expect.objectContaining({
        kind: "text-in-zone-gutter",
        text: "🌐 test",
        reason: "non-continuation-in-gutter",
      }),
    );

    // Partial-coverage leading cluster "A⃝" reserves 0.5 em at cluster start.
    const ir = structuredClone(baseIr);
    const cable = ir.cables.find((c) => c.designation === "CBL1")!;
    cable.fromLocation = "🌐 test";
    const cType = ir.cableTypes.find((t) => t.id === cable.typeId)!;
    cType.description = "A\u20DD test";
    const cablePacket = await renderSchematicPacket(ir, cableRequest(10));
    expect(cablePacket.ok).toBe(true);
    if (!cablePacket.ok) return;
    const cg = await measureSheet(cablePacket.value.sheets[0]!.svg);
    expect(textInZoneGutter(cg)).toEqual([]);
    assertPreciseBounds(cg);
    for (const label of ["🌐 test", "A\u20DD test"]) {
      const item = cg.texts.find((t) => t.text === label);
      expect(item, label).toBeDefined();
      expect(item!.bbox.x).toBeGreaterThanOrEqual(28.0);
      expect(item!.bbox.x + item!.bbox.w).toBeLessThanOrEqual(187.9);
      expect(item!.anchor.x).toBeGreaterThan(28.0);
    }
  });

  it("issues ignorable-selector End B byte-identically to plain bundled text and bounds 'Field 🌐' / 'Field ⚡' inside both edges", async () => {
    const plain = await renderCableEndB("a".repeat(24));
    const withVs = await renderCableEndB("a".repeat(24) + "\uFE0F");
    expect(plain.ok && withVs.ok).toBe(true);
    if (!plain.ok || !withVs.ok) return;
    expect(withVs.value.sheets[0]!.svg.replaceAll("\uFE0F", "")).toBe(
      plain.value.sheets[0]!.svg,
    );
    const gVs = await measureSheet(withVs.value.sheets[0]!.svg);
    expect(textInZoneGutter(gVs)).toEqual([]);
    assertPreciseBounds(gVs);

    const fieldRight = 187.9;
    const jacketR = 131.935;
    for (const heading of ["Field 🌐", "Field ⚡", "🌐"]) {
      const issued = await renderCableEndB(heading);
      expect(
        issued.ok,
        `${heading}: ${JSON.stringify(issued.ok ? null : issued.error)}`,
      ).toBe(true);
      if (!issued.ok) continue;
      const g = await measureSheet(issued.value.sheets[0]!.svg);
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g);
      const item = g.texts.find((t) => t.text === heading);
      expect(item, heading).toBeDefined();
      expect(item!.bbox.x).toBeGreaterThanOrEqual(jacketR);
      expect(item!.bbox.x + item!.bbox.w).toBeLessThanOrEqual(fieldRight);
    }

    const refused = await renderCableEndB("Field " + "🌐".repeat(19));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("R006");
  });

  it("prevents table-known fallback End A/End B heading overlaps and keeps fitting headings inside their cells (#556)", async () => {
    const doubleIr = structuredClone(baseIr);
    const cable = doubleIr.cables.find((c) => c.designation === "CBL1")!;
    cable.fromLocation = "⚡".repeat(21);
    cable.toLocation = "⚡".repeat(21);
    const doublePacket = await renderSchematicPacket(
      doubleIr,
      cableRequest(10),
    );
    if (!doublePacket.ok) {
      expect(doublePacket.error.code).toBe("R006");
    } else {
      const g = await measureSheet(doublePacket.value.sheets[0]!.svg);
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g);
      const headings = g.texts.filter((t) => t.text === "⚡".repeat(21));
      expect(headings.length).toBe(2);
      if (process.platform === "darwin") {
        expect(headings[0]!.bbox.x).toBeGreaterThanOrEqual(28.0);
        expect(headings[0]!.bbox.x + headings[0]!.bbox.w).toBeLessThanOrEqual(
          83.965,
        );
        expect(headings[1]!.bbox.x).toBeGreaterThanOrEqual(131.935);
        expect(headings[1]!.bbox.x + headings[1]!.bbox.w).toBeLessThanOrEqual(
          187.9,
        );
        expect(overlap(headings[0]!.bbox, headings[1]!.bbox, 0)).toBe(false);
      }
    }

    // Fitting repeated-⚡ double heading issues cleanly inside both End A and End B lanes.
    const fitIr = structuredClone(baseIr);
    const fitCable = fitIr.cables.find((c) => c.designation === "CBL1")!;
    fitCable.fromLocation = "⚡".repeat(9);
    fitCable.toLocation = "⚡".repeat(9);
    const fitPacket = await renderSchematicPacket(fitIr, cableRequest(10));
    expect(
      fitPacket.ok,
      JSON.stringify(fitPacket.ok ? null : fitPacket.error),
    ).toBe(true);
    if (fitPacket.ok) {
      const fg = await measureSheet(fitPacket.value.sheets[0]!.svg);
      expect(textInZoneGutter(fg)).toEqual([]);
      assertPreciseBounds(fg);
      const headings = fg.texts.filter((t) => t.text === "⚡".repeat(9));
      expect(headings.length).toBe(2);
      const tol = process.platform === "darwin" ? 0 : 0.5;
      expect(headings[0]!.bbox.x).toBeGreaterThanOrEqual(28.0 - tol);
      expect(headings[0]!.bbox.x + headings[0]!.bbox.w).toBeLessThanOrEqual(
        83.965 + tol,
      );
      expect(headings[1]!.bbox.x).toBeGreaterThanOrEqual(131.935 - tol);
      expect(headings[1]!.bbox.x + headings[1]!.bbox.w).toBeLessThanOrEqual(
        187.9 + tol,
      );
      expect(overlap(headings[0]!.bbox, headings[1]!.bbox, 0)).toBe(false);
    }
  });

  it("keeps margin-22 16×⚡ End B heading inside its lane or returns clean R006 (#556)", async () => {
    const endB16 = await renderCableEndB("⚡".repeat(16), 22);
    if (!endB16.ok) {
      expect(endB16.error.code).toBe("R006");
    } else {
      const g = await measureSheet(endB16.value.sheets[0]!.svg);
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g);
      const item = g.texts.find((t) => t.text === "⚡".repeat(16));
      expect(item).toBeDefined();
      const tol = process.platform === "darwin" ? 0 : 0.5;
      expect(item!.bbox.x).toBeGreaterThanOrEqual(128.335 - tol);
      expect(item!.bbox.x + item!.bbox.w).toBeLessThanOrEqual(175.9 + tol);
    }
  });

  it.each(["BN " + "⚡".repeat(12), "BN " + "❤️".repeat(12)])(
    "keeps centered table-known fallback core rows %s inside the margin-22 jacket (#556)",
    async (color) => {
      const ir = structuredClone(baseIr);
      const cable = ir.cables.find((c) => c.designation === "CBL1")!;
      ir.cableTypes.find((t) => t.id === cable.typeId)!.conductors[0]!.color =
        color;
      const packet = await renderSchematicPacket(ir, cableRequest(22));
      if (!packet.ok) {
        expect(packet.error.code).toBe("R006");
        return;
      }
      const g = await measureSheet(packet.value.sheets[0]!.svg);
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g);
      const rows = g.texts.filter((t) => /⚡|❤️/u.test(t.text));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const tol = process.platform === "darwin" ? 0 : 0.5;
      for (const row of rows) {
        expect(row.anchor.x).toBeCloseTo(107.95, 1);
        expect(row.bbox.x).toBeGreaterThanOrEqual(87.565 - tol);
        expect(row.bbox.x + row.bbox.w).toBeLessThanOrEqual(128.335 + tol);
      }
    },
  );

  it("wraps margin-22 End B rows and centered core rows inside both edges with zero text-bounds findings (#556)", async () => {
    const variant = await compileEmojiEndBCableIr();
    try {
      const marginMm = 22;
      const packet = await renderSchematicPacket(
        variant.ir,
        cableRequest(marginMm),
      );
      expect(packet.ok, JSON.stringify(packet.ok ? null : packet.error)).toBe(
        true,
      );
      if (!packet.ok) return;
      const g = await measureSheet(packet.value.sheets[0]!.svg);
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g);

      const fieldLeft = marginMm + 18;
      const fieldRight = 215.9 - marginMm - 18;
      const fieldW = fieldRight - fieldLeft;
      const jacketL = fieldLeft + fieldW * 0.35;
      const jacketR = fieldRight - fieldW * 0.35;
      const coreRows = g.texts.filter(
        (t) =>
          t.text.includes("BN ") ||
          t.text.startsWith("🌐🌐") ||
          t.text.includes("/ 18AWG"),
      );
      expect(coreRows.length).toBeGreaterThanOrEqual(3);
      for (const row of coreRows) {
        expect(row.bbox.x).toBeGreaterThanOrEqual(jacketL);
        expect(row.bbox.x + row.bbox.w).toBeLessThanOrEqual(jacketR);
      }
      const endBRows = g.texts.filter(
        (t) =>
          (t.text.startsWith("B🌐") || t.text === "X1.1") &&
          !t.text.includes("Off-view") &&
          t.anchor.y > 100,
      );
      expect(endBRows.length).toBeGreaterThanOrEqual(2);
      for (const row of endBRows) {
        expect(row.bbox.x).toBeGreaterThanOrEqual(jacketR);
        expect(row.bbox.x + row.bbox.w).toBeLessThanOrEqual(fieldRight);
      }
    } finally {
      await variant.dispose();
    }
  });

  it.each([20, 40, 60])(
    "places CBL1 + %i×🌐 rooted notice cleanly inside field bounds with zero text-bounds findings (#556)",
    async (count) => {
      const paper = makeLetterPortrait();
      const view: NormalizedSchematicView = {
        format: "schematic-view/0.1",
        root: { deviceUid: "cbl-1", designation: "CBL1" + "🌐".repeat(count) },
        family: "control",
        flow: "top-to-bottom",
      };
      const title = {
        projectName: "Rooted Notice Probe",
        revision: "A",
        toolVersion: "test",
        lines: [],
      };
      const b = bounds(title, paper, view);
      const link: Link = {
        id: "C001",
        to: 2,
        toZone: "A1",
        conductor: "W1",
        netId: "N1",
        x: 90,
        y: b.y,
        side: "top",
      };
      link.label = continuationLabel(
        link,
        18,
        continuationHeaderWidth(1),
        false,
      );
      const draft: Draft = {
        view,
        title,
        content: "",
        links: [link],
        references: [],
        note: "Rooted notice fallback probe.",
        drawingBounds: b,
      };
      expect(continuationInkFailure(draft, paper)).toBeUndefined();
      const g = await measureSheet(frame(draft, paper, 1, 2));
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g);
      const notices = g.texts.filter(
        (t) =>
          t.anchor.y < 100 &&
          (t.text.includes("SELECTED") ||
            t.text.includes("CBL1") ||
            t.text.includes("🌐") ||
            t.text.includes("Selected path")),
      );
      const conts = g.texts.filter(
        (t) => t.text === "C001 / 02.A1" || t.text === "W1",
      );
      expect(notices.length).toBeGreaterThanOrEqual(2);
      expect(conts.length).toBe(2);
      for (const notice of notices) {
        expect(notice.bbox.x).toBeGreaterThanOrEqual(28.0);
        expect(notice.bbox.x + notice.bbox.w).toBeLessThanOrEqual(187.9);
        for (const cont of conts)
          expect(overlap(notice.bbox, cont.bbox, 0)).toBe(false);
      }
    },
  );

  it("wraps W-FLD-001 nine-globe circuit wire detail with zero unfiltered text-bounds findings (#556)", async () => {
    const ir = structuredClone(baseIr);
    const wire = ir.wires.find((w) => w.designation === "W-FLD-001")!;
    wire.properties = {
      ...(wire.properties ?? {}),
      color: "Review " + "🌐".repeat(9),
    };
    const packet = await renderSchematicPacket(
      ir,
      makeCircuitRequest("Circuit fallback detail probe"),
    );
    expect(packet.ok, JSON.stringify(packet.ok ? null : packet.error)).toBe(
      true,
    );
    if (!packet.ok) return;
    const g = await measureSheet(packet.value.sheets[0]!.svg);
    expect(textInZoneGutter(g)).toEqual([]);
    assertPreciseBounds(g);
    const wrapped = g.texts.filter(
      (t) => t.text.includes("Review") || t.text.includes("🌐"),
    );
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
    for (const row of wrapped) {
      expect(row.bbox.x).toBeGreaterThanOrEqual(28.0);
      expect(row.bbox.x + row.bbox.w).toBeLessThanOrEqual(403.8);
    }
  });
});
