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

function assertPreciseBounds(
  g: Awaited<ReturnType<typeof openSheet>>,
  allowEmojiLineOverlap = false,
) {
  if (process.platform !== "darwin") return;
  // Linux and Windows CI may report whole-unit Canvas bounds (#594).
  const findings = allowEmojiLineOverlap
    ? textBounds(g).filter((f) => f.kind !== "text-text-overlap")
    : textBounds(g);
  expect(findings).toEqual([]);
}

async function compileEmojiEndBCableIr() {
  const dir = await mkdtemp(join(tmpdir(), "thermite-fb-cable-"));
  await cp("examples/motor-starter", dir, { recursive: true });
  const endADes = "TB1WWWW🌐🌐🌐";
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
    const next = raw
      .replaceAll('"TB1"', JSON.stringify(endADes))
      .replaceAll('"JB1"', JSON.stringify(endBDes));
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

describe("fallback-face browser regressions (#555, #556)", () => {
  it("keeps leading fallback cluster '🌐 test' out of the left zone gutter with negative control (#555)", async () => {
    const packet = await renderSchematicPacket(baseIr, {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
      views: [
        {
          format: "wiring-view-request/0.1",
          title: "🌐 test",
          notes: ["🌐 test"],
          conductors: ["W-FLD-001", "W-FLD-002"],
        },
      ],
    });
    expect(packet.ok, JSON.stringify(packet.ok ? null : packet.error)).toBe(
      true,
    );
    if (!packet.ok) return;
    const svg = packet.value.sheets[0]!.svg;
    const g = await measureSheet(svg);
    expect(textInZoneGutter(g)).toEqual([]);
    assertPreciseBounds(g, true);
    const fieldTexts = g.texts.filter(
      (t) => t.text === "🌐 test" && t.anchor.y < 200,
    );
    expect(fieldTexts.length).toBe(2);
    for (const item of fieldTexts) {
      expect(item.bbox.x).toBeGreaterThanOrEqual(28.0);
    }

    // Negative control: moving the 2.5 mm note back to uninset x="28" fails DQ-02.
    const uninset = svg.replace(
      /(<text\b[^>]*\bx=")29\.43("[^>]*>🌐 test<\/text>)/u,
      "$128$2",
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
  });

  it("refuses overflowing cable End B heading with R006 while issuing bundled control (#556)", async () => {
    const renderEndB = async (toLocation: string) => {
      const ir = structuredClone(baseIr);
      ir.cables.find((c) => c.designation === "CBL1")!.toLocation = toLocation;
      return renderSchematicPacket(ir, {
        format: "schematic-packet-request/0.1",
        index: false,
        page: { size: "letter", orientation: "portrait", marginMm: 10 },
        views: [
          {
            format: "schematic-view-request/0.2",
            root: { by: "designation", value: "CBL1" },
            intent: { kind: "conductors" },
            flow: "left-to-right",
          },
        ],
      });
    };

    const refused = await renderEndB("Field " + "🌐".repeat(19));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("R006");

    const issued = await renderEndB("Field Panel");
    expect(issued.ok, JSON.stringify(issued.ok ? null : issued.error)).toBe(
      true,
    );
    if (!issued.ok) return;
    const g = await measureSheet(issued.value.sheets[0]!.svg);
    expect(textInZoneGutter(g)).toEqual([]);
    assertPreciseBounds(g);
  });

  it("wraps cable End B endpoint rows and centered core rows inside their boundaries (#556)", async () => {
    const variant = await compileEmojiEndBCableIr();
    try {
      const marginMm = 22;
      const packet = await renderSchematicPacket(variant.ir, {
        format: "schematic-packet-request/0.1",
        index: false,
        page: { size: "letter", orientation: "portrait", marginMm },
        views: [
          {
            format: "schematic-view-request/0.2",
            root: { by: "designation", value: "CBL1" },
            intent: { kind: "conductors" },
            flow: "left-to-right",
          },
        ],
      });
      expect(packet.ok, JSON.stringify(packet.ok ? null : packet.error)).toBe(
        true,
      );
      if (!packet.ok) return;
      const g = await measureSheet(packet.value.sheets[0]!.svg);
      expect(textInZoneGutter(g)).toEqual([]);
      assertPreciseBounds(g, true);

      const fieldLeft = marginMm + 18;
      const fieldRight = 215.9 - marginMm - 18;
      const fieldW = fieldRight - fieldLeft;
      const jacketL = fieldLeft + fieldW * 0.35;
      const jacketR = fieldRight - fieldW * 0.35;
      const coreRows = g.texts.filter(
        (t) => t.text.includes("BN ") || t.text.includes("/ 18AWG"),
      );
      expect(coreRows.length).toBeGreaterThanOrEqual(2);
      for (const row of coreRows) {
        expect(row.bbox.x).toBeGreaterThanOrEqual(jacketL);
        expect(row.bbox.x + row.bbox.w).toBeLessThanOrEqual(jacketR);
      }
      const endBRows = g.texts.filter(
        (t) =>
          (t.text.startsWith("B🌐") || t.text.endsWith(".X1.1")) &&
          !t.text.includes("Off-view") &&
          t.anchor.y > 100,
      );
      expect(endBRows.length).toBeGreaterThanOrEqual(2);
      for (const row of endBRows) {
        expect(row.bbox.x).toBeGreaterThanOrEqual(jacketR);
      }
    } finally {
      await variant.dispose();
    }
  });

  it("keeps top continuations clear of a CBL1 + 20×🌐 rooted notice in Chromium (#556)", async () => {
    const paper = makeLetterPortrait();
    const view: NormalizedSchematicView = {
      format: "schematic-view/0.1",
      root: { deviceUid: "cbl-1", designation: "CBL1" + "🌐".repeat(20) },
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
    link.label = continuationLabel(link, 18, continuationHeaderWidth(1), false);
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
    assertPreciseBounds(g, true);
    const notices = g.texts.filter(
      (t) =>
        t.text.includes("SELECTED") ||
        t.text.includes("CBL1") ||
        t.text.includes("🌐") ||
        t.text.includes("Selected path"),
    );
    const conts = g.texts.filter(
      (t) => t.text === "C001 / 02.A1" || t.text === "W1",
    );
    expect(notices.length).toBeGreaterThanOrEqual(3);
    expect(conts.length).toBe(2);
    for (const notice of notices)
      for (const cont of conts)
        expect(overlap(notice.bbox, cont.bbox, 0)).toBe(false);
  });

  it("wraps circuit wire details containing fallback clusters via circuitTextLines (#556)", async () => {
    const ir = structuredClone(baseIr);
    const wire = ir.wires.find((w) => w.designation === "W-FLD-001")!;
    wire.properties = {
      ...(wire.properties ?? {}),
      color: "Review 🌐🌐🌐🌐🌐🌐🌐🌐🌐",
    };
    const packet = await renderSchematicPacket(ir, {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
      views: [
        {
          format: "circuit-view-request/0.1",
          title: "Circuit fallback detail probe",
          flow: "left-to-right",
          groups: [
            {
              id: "g1",
              label: "Field permissive",
              functions: [
                {
                  device: { by: "designation", value: "JB1" },
                  key: "terminal1",
                },
                {
                  device: { by: "designation", value: "LS1" },
                  key: "contact13",
                },
                {
                  device: { by: "designation", value: "JB1" },
                  key: "terminal2",
                },
              ],
              conductors: ["W-FLD-001", "W-FLD-002"],
            },
          ],
        },
      ],
    });
    expect(packet.ok, JSON.stringify(packet.ok ? null : packet.error)).toBe(
      true,
    );
    if (!packet.ok) return;
    const g = await measureSheet(packet.value.sheets[0]!.svg);
    expect(textInZoneGutter(g)).toEqual([]);
    assertPreciseBounds(g, true);
    const wrapped = g.texts.filter(
      (t) => t.text.includes("Review") || t.text.includes("🌐"),
    );
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
  });
});
