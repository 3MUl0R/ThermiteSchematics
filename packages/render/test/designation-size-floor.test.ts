import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import { compileProject, lockProject } from "@thermite/compiler";

import { createTerminalIr } from "../../query/test/fixtures.js";
import { renderSchematicPacket } from "../src/index.js";
import type { SchematicPacketRequest } from "../src/packet/types.js";
import { printableTextMetrics } from "../src/text-metrics.js";

const DESIGNATION_FLOOR_MM = 2.7;
const TOL_MM = 0.03;

function repoPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url));
}

function ancestorScale(el: Element): number {
  let scale = 1;
  let cur: Element | null = el;
  while (cur) {
    const transform = cur.getAttribute("transform");
    if (transform) {
      const m = /scale\(([^,)\s]+)/u.exec(transform);
      if (m) {
        const s = Number(m[1]);
        if (Number.isFinite(s) && s > 0) scale *= s;
      }
    }
    if (cur.tagName.toLowerCase() === "svg") {
      const vb = cur.getAttribute("viewBox");
      const wAttr = cur.getAttribute("width");
      if (vb && wAttr && !wAttr.endsWith("%")) {
        const parts = vb
          .trim()
          .split(/[\s,]+/u)
          .map(Number);
        const w = Number(wAttr.replace(/mm$/u, ""));
        if (parts.length === 4 && parts[2]! > 0 && Number.isFinite(w) && w > 0)
          scale *= w / parts[2]!;
      }
    }
    cur = cur.parentElement;
  }
  return scale;
}

interface EffectiveText {
  text: string;
  role: string | null;
  className: string;
  rawFontSize: number;
  effectiveEmMm: number;
  tagField: string | null;
}

function measureSheetTexts(svg: string): EffectiveText[] {
  const { document } = parseHTML(svg);
  return [...document.querySelectorAll("text")]
    .filter((el) => (el.textContent ?? "").trim().length > 0)
    .map((el) => {
      const rawFontSize = Number(el.getAttribute("font-size"));
      const scale = ancestorScale(el);
      return {
        text: (el.textContent ?? "").replace(/\s+/gu, " ").trim(),
        role: el.getAttribute("data-text-role"),
        className: el.getAttribute("class") ?? "",
        rawFontSize,
        effectiveEmMm: Number((rawFontSize * scale).toFixed(4)),
        tagField: el.getAttribute("data-tag-field"),
      };
    });
}

async function renderExample(
  projectRel: string,
  requestRel: string,
  override?: (req: SchematicPacketRequest) => SchematicPacketRequest,
) {
  const compiled = await compileProject(repoPath(projectRel));
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const base: SchematicPacketRequest = JSON.parse(
    readFileSync(repoPath(requestRel), "utf8"),
  );
  const req = override ? override(base) : base;
  const rendered = await renderSchematicPacket(
    compiled.ir,
    req,
    compiled.presentation,
  );
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
  return rendered.value;
}

function assertStripFragmentClearances(frag: Element): void {
  const headings = [
    ...frag.querySelectorAll('text[data-text-role="designation"]'),
  ];
  expect(headings.length).toBeGreaterThanOrEqual(1);
  for (const [i, heading] of headings.entries()) {
    expect(Number(heading.getAttribute("font-size"))).toBe(2.7);
    if (i > 0) {
      const prev = headings[i - 1]!;
      const prevBottom =
        Number(prev.getAttribute("y")) -
        printableTextMetrics(prev.textContent ?? "", 2.7, true).bottom;
      const curTop =
        Number(heading.getAttribute("y")) -
        printableTextMetrics(heading.textContent ?? "", 2.7, true).top;
      expect(curTop - prevBottom).toBeGreaterThanOrEqual(0.95);
    }
  }
  const lastHeading = headings.at(-1)!;
  const headingBottom =
    Number(lastHeading.getAttribute("y")) -
    printableTextMetrics(lastHeading.textContent ?? "", 2.7, true).bottom;
  const sideHeadings = [
    ...frag.querySelectorAll('text[data-text-role="body"]'),
  ].filter((el) => !/^[123]$/u.test((el.textContent ?? "").trim()));
  const firstSideTop = Math.min(
    ...sideHeadings.map(
      (el) =>
        Number(el.getAttribute("y")) -
        printableTextMetrics(el.textContent ?? "", 2.5).top,
    ),
  );
  expect(firstSideTop - headingBottom).toBeGreaterThanOrEqual(2.0);
  const lastSideBottom = Math.max(
    ...sideHeadings.map(
      (el) =>
        Number(el.getAttribute("y")) -
        printableTextMetrics(el.textContent ?? "", 2.5).bottom,
    ),
  );
  const firstRectY = Number(frag.querySelector("rect")!.getAttribute("y"));
  expect(firstRectY - lastSideBottom).toBeGreaterThanOrEqual(4.4);
}

describe("RL2 designation-size floor (#643)", () => {
  it("EM-04: device-owning terminal-strip headings print at >= 2.7 mm while body/secondary strip text stays at 2.5 mm", async () => {
    const packet = await renderExample(
      "examples/machine-demo",
      "examples/machine-demo/packet.request.json",
    );
    const stripSheets = packet.sheets.filter(
      (s) => s.view.kind === "terminal-strip",
    );
    expect(stripSheets.length).toBeGreaterThan(0);
    const texts = stripSheets.flatMap((s) => measureSheetTexts(s.svg));
    const designations = texts.filter((t) => t.role === "designation");
    expect(designations.length).toBeGreaterThanOrEqual(2);
    for (const d of designations)
      expect(d.effectiveEmMm).toBeGreaterThanOrEqual(
        DESIGNATION_FLOOR_MM - TOL_MM,
      );
    // Negative/positive control: side headings and incidence rows remain 2.5 mm.
    const sideHeading = texts.find(
      (t) => t.role === "body" && t.text === "Same location",
    );
    expect(sideHeading?.effectiveEmMm).toBe(2.5);
    const incidence = texts.find(
      (t) => t.role === "secondary" && t.text.includes("→"),
    );
    expect(incidence?.effectiveEmMm).toBe(2.5);
  });

  it("EM-04 narrow-strip boundary: keeps Letter portrait 13.5 mm margin packet at 4 sheets (1 graphical strip sheet) with 2.7 mm headings and preserved clearances", async () => {
    const ir = createTerminalIr(
      [1, 2, 3, 4, 5].map((index) => ({
        uid: `79000000-0000-4000-8000-00000000000${index}`,
        designation: `XT-0${index}WWWWWWWWWWWW`,
        terminalKeys: ["1", "2", "3"],
      })),
    );
    ir.deviceTypes[0]!.category = "terminal-strip";
    ir.deviceTypes[0]!.terminalOrder = ["2", "1", "3"];
    for (const device of ir.devices) device.location = "Main";
    const rendered = await renderSchematicPacket(ir, {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "letter", orientation: "portrait", marginMm: 13.5 },
      views: [{ format: "documentation-view-request/0.1", kind: "terminals" }],
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
    const { sheets } = rendered.value;
    const stripSheets = sheets.filter((s) => s.view.kind === "terminal-strip");
    expect(sheets).toHaveLength(4);
    expect(stripSheets).toHaveLength(1);
    const { document } = parseHTML(stripSheets[0]!.svg);
    const fragments = [...document.querySelectorAll("g[data-terminal-strip]")];
    expect(fragments).toHaveLength(5);
    for (const frag of fragments) assertStripFragmentClearances(frag);
  });

  it("EM-03: compacted tagged off-view designations print at >= 2.7 mm while secondary rows keep compact floor and stay inside card bounds", async () => {
    const packet = await renderExample(
      "examples/machine-demo",
      "examples/machine-demo/packet.request.json",
    );
    const allTexts = packet.sheets.flatMap((s) => measureSheetTexts(s.svg));
    const headings = allTexts.filter((t) =>
      t.className.includes("off-view-heading"),
    );
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) {
      expect(h.role).toBe("designation");
      expect(h.effectiveEmMm).toBeGreaterThanOrEqual(
        DESIGNATION_FLOOR_MM - TOL_MM,
      );
    }
    const compactedHeading = headings.find((h) =>
      h.text.includes("Off-view at SRC1.PE"),
    );
    expect(compactedHeading).toBeDefined();
    expect(compactedHeading!.effectiveEmMm).toBeGreaterThanOrEqual(
      DESIGNATION_FLOOR_MM - TOL_MM,
    );
    // Positive control: compacted secondary rows remain at compact floor (~2.52 mm), not resized up.
    const compactRows = allTexts.filter(
      (t) =>
        t.className.includes("off-view-row") &&
        t.role === "secondary" &&
        t.effectiveEmMm < 2.6,
    );
    expect(compactRows.length).toBeGreaterThan(0);
    for (const r of compactRows)
      expect(r.effectiveEmMm).toBeGreaterThanOrEqual(2.5);
    // Geometry check: compacted card heading & rows stay strictly inside card rect.
    const { document } = parseHTML(packet.sheets[2]!.svg);
    const card = [...document.querySelectorAll("g.off-view-annotation")].find(
      (g) => g.textContent?.includes("Off-view at SRC1.PE"),
    );
    expect(card).toBeDefined();
    const rect = card!.querySelector("rect.off-view-card")!;
    const rx = Number(rect.getAttribute("x"));
    const ry = Number(rect.getAttribute("y"));
    const rw = Number(rect.getAttribute("width"));
    const rh = Number(rect.getAttribute("height"));
    const hEl = card!.querySelector("text.off-view-heading")!;
    const hSize = Number(hEl.getAttribute("font-size"));
    const hM = printableTextMetrics(hEl.textContent ?? "", hSize, true);
    const hx = Number(hEl.getAttribute("x"));
    const hy = Number(hEl.getAttribute("y"));
    expect(hx + hM.left).toBeGreaterThanOrEqual(rx - 0.01);
    expect(hx + Math.max(hM.advance, hM.right)).toBeLessThanOrEqual(
      rx + rw + 0.01,
    );
    expect(hy - hM.top).toBeGreaterThanOrEqual(ry - 0.01);
    expect(hy - hM.bottom).toBeLessThanOrEqual(ry + rh + 0.01);
  });

  it("EM-05: topology-scaled owning assembly identifiers (CBL1, CAP-X01..08) print at >= 2.7 mm while body lines may scale", async () => {
    for (const rel of [
      "examples/assembly-note-bounds",
      "examples/cap-pagination",
    ]) {
      const packet = await renderExample(rel, `${rel}/packet.json`);
      const texts = packet.sheets.flatMap((s) => measureSheetTexts(s.svg));
      const designations = texts.filter((t) => t.role === "designation");
      expect(designations.length).toBeGreaterThan(0);
      for (const d of designations)
        expect(d.effectiveEmMm).toBeGreaterThanOrEqual(
          DESIGNATION_FLOOR_MM - TOL_MM,
        );
      // Body lines in scaled assembly views remain scaled (< 2.7 mm, >= 2.5 mm).
      const scaledBody = texts.filter(
        (t) =>
          t.role === "body" &&
          t.text.includes("Pin mapping:") &&
          t.effectiveEmMm < 2.7,
      );
      expect(scaledBody.length).toBeGreaterThan(0);
      for (const b of scaledBody)
        expect(b.effectiveEmMm).toBeGreaterThanOrEqual(2.5 - TOL_MM);
    }
  });

  it("EM-06: topology-scaled communication-link identities (BR1..3, NET01) print at >= 2.7 mm while port labels may scale", async () => {
    const packet = await renderExample(
      "examples/network-pagination",
      "examples/network-pagination/packet.json",
    );
    const commSheets = packet.sheets.filter(
      (s) => s.view.kind === "communication",
    );
    expect(commSheets.length).toBeGreaterThan(1);
    const texts = commSheets.flatMap((s) => measureSheetTexts(s.svg));
    const linkNames = new Set(["BR1", "BR2", "BR3", "NET01"]);
    const linkLabels = texts.filter(
      (t) => t.role === "designation" && linkNames.has(t.text),
    );
    expect(linkLabels.length).toBeGreaterThanOrEqual(4);
    for (const l of linkLabels)
      expect(l.effectiveEmMm).toBeGreaterThanOrEqual(
        DESIGNATION_FLOOR_MM - TOL_MM,
      );
    // All designations on communication sheets satisfy the floor.
    for (const d of texts.filter((t) => t.role === "designation"))
      expect(d.effectiveEmMm).toBeGreaterThanOrEqual(
        DESIGNATION_FLOOR_MM - TOL_MM,
      );
  });

  it("RL1-promoted rail device tags (PS1) print at >= 2.7 mm at minimum 0.25x rooted scale", async () => {
    const packet = await renderExample(
      "examples/motor-starter",
      "examples/alpha/motor-starter.packet.json",
    );
    const railTags = packet.sheets
      .flatMap((s) => measureSheetTexts(s.svg))
      .filter((t) => t.className.includes("rail-device-tag"));
    expect(railTags.length).toBeGreaterThan(0);
    for (const rt of railTags) {
      expect(rt.role).toBe("designation");
      expect(rt.effectiveEmMm).toBeGreaterThanOrEqual(
        DESIGNATION_FLOOR_MM - TOL_MM,
      );
    }
  });

  it("negative control: undesignated assembly endpoint pair stays secondary at 2.7 local (not upsized)", async () => {
    const compiled = await compileProject(
      repoPath("examples/assembly-note-bounds"),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const cloned = structuredClone(compiled.ir);
    const assembly = cloned.relations.find((r) => r.assembly);
    expect(assembly).toBeDefined();
    Reflect.deleteProperty(assembly!, "designation");
    const rendered = await renderSchematicPacket(
      cloned,
      {
        format: "schematic-packet-request/0.1",
        views: [
          {
            format: "connector-assembly-view-request/0.1",
            title: "Undesignated assembly control",
            assemblies: [assembly!.uid],
          },
        ],
      },
      compiled.presentation,
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
    const { document } = parseHTML(rendered.value.sheets[0]!.svg);
    const first = document.querySelector(
      `g[data-assembly-label="${assembly!.uid}"] text`,
    );
    expect(first?.getAttribute("data-text-role")).toBe("secondary");
    expect(first?.getAttribute("font-size")).toBe("2.7");
  });

  it("EM-05 signal-loop: cable-assembly designation CB1 reserves 2.916 mm local font (>= 2.7 mm at minimum topology scale) while descriptive line stays 2.7 mm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thermite-rl2-loop-"));
    try {
      for (const name of ["field-interfaces", "industrial-pilot"])
        await cp(repoPath(`libraries/${name}`), join(dir, name), {
          recursive: true,
        });
      await cp(
        repoPath("packages/cli/fixtures/analog-output/source.json"),
        join(dir, "source.json"),
      );
      await writeFile(
        join(dir, "system.json"),
        JSON.stringify({
          format: "electrical-system/0.1",
          project: { name: "Signal loop designation floor control" },
          sources: ["source.json"],
          libraries: ["field-interfaces", "industrial-pilot"].map((name) => ({
            name,
            version: "0.1.0",
            path: name,
          })),
        }),
      );
      expect((await lockProject(dir)).ok).toBe(true);
      const compiled = await compileProject(dir);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      const baseReq: SchematicPacketRequest = JSON.parse(
        readFileSync(
          repoPath("packages/cli/fixtures/analog-output/packet.request.json"),
          "utf8",
        ),
      );
      const rendered = await renderSchematicPacket(
        compiled.ir,
        baseReq,
        compiled.presentation,
      );
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
      const texts = measureSheetTexts(rendered.value.sheets[0]!.svg);
      const cb1 = texts.find((t) => t.text === "CB1");
      expect(cb1?.role).toBe("designation");
      expect(cb1!.rawFontSize).toBeCloseTo(2.916, 3);
      expect(cb1!.rawFontSize * (2.5 / 2.7)).toBeGreaterThanOrEqual(
        DESIGNATION_FLOOR_MM - TOL_MM,
      );
      const desc = texts.find(
        (t) => t.role === "body" && t.text.includes("4-pole command"),
      );
      expect(desc).toBeDefined();
      expect(desc!.rawFontSize).toBe(2.7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
