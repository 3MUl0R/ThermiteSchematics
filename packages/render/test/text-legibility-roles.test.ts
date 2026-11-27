import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import { compileProject, lockProject } from "@thermite/compiler";

import { renderSchematic, renderSchematicPacket } from "../src/index.js";
import type { SchematicPacketRequest } from "../src/packet/types.js";
import { SvgWriter } from "../src/svg/writer.js";

const VALID_ROLES = new Set(["designation", "body", "secondary"]);

function repoPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url));
}

async function renderExamplePacket(
  projectRel: string,
  requestRel?: string,
  override?: (req: SchematicPacketRequest) => SchematicPacketRequest,
) {
  const compiled = await compileProject(repoPath(projectRel));
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const baseRequest: SchematicPacketRequest = requestRel
    ? JSON.parse(readFileSync(repoPath(requestRel), "utf8"))
    : {
        format: "schematic-packet-request/0.1",
        index: true,
        views: [
          {
            format: "schematic-view-request/0.1",
            root: { by: "designation", value: "M1" },
            family: "power",
            flow: "left-to-right",
          },
          {
            format: "documentation-view-request/0.1",
            kind: "terminals",
          },
        ],
      };
  const req = override ? override(baseRequest) : baseRequest;
  const rendered = await renderSchematicPacket(
    compiled.ir,
    req,
    compiled.presentation,
  );
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
  return rendered.value;
}

async function renderFixtureSignalLoop(
  fixtureRel: string,
  request: SchematicPacketRequest,
) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-rl1-loop-"));
  try {
    for (const name of ["field-interfaces", "industrial-pilot"])
      await cp(repoPath(`libraries/${name}`), join(dir, name), {
        recursive: true,
      });
    await cp(repoPath(`${fixtureRel}/source.json`), join(dir, "source.json"));
    await writeFile(
      join(dir, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: "Signal loop role test" },
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
    const rendered = await renderSchematicPacket(
      compiled.ir,
      request,
      compiled.presentation,
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
    return rendered.value;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface PrintedTextInfo {
  text: string;
  role: string | null;
  fontSize: string | null;
  tagField: string | null;
}

function printedTexts(svg: string): PrintedTextInfo[] {
  const { document } = parseHTML(svg);
  return [...document.querySelectorAll("text")]
    .filter((el) => (el.textContent ?? "").trim().length > 0)
    .map((el) => ({
      text: (el.textContent ?? "").replace(/\s+/gu, " ").trim(),
      role: el.getAttribute("data-text-role"),
      fontSize: el.getAttribute("font-size"),
      tagField: el.getAttribute("data-tag-field"),
    }));
}

function assertEveryPrintedTextHasValidRole(
  sheets: readonly { number: number; svg: string }[],
) {
  const invalid: Array<{ sheet: number; text: string; role: string | null }> =
    [];
  for (const sheet of sheets) {
    for (const item of printedTexts(sheet.svg)) {
      if (!item.role || !VALID_ROLES.has(item.role)) {
        invalid.push({
          sheet: sheet.number,
          text: item.text,
          role: item.role,
        });
      }
    }
  }
  expect(invalid).toEqual([]);
}

describe("affirmative text legibility roles on emitted SVG (EM-01/02/07)", () => {
  it("emits affirmative roles on conveyor-line strip, notice, legend, mirror, and compact zones without resizing", async () => {
    const packet = await renderExamplePacket(
      "examples/conveyor-line",
      undefined,
      () => ({
        format: "schematic-packet-request/0.1",
        layout: "compact",
        page: { size: "tabloid", orientation: "landscape" },
        index: true,
        views: [
          {
            format: "schematic-view-request/0.1",
            root: { by: "designation", value: "M1" },
            family: "power",
            flow: "left-to-right",
          },
          {
            format: "schematic-view-request/0.1",
            root: { by: "designation", value: "K1" },
            family: "control",
            flow: "left-to-right",
          },
          {
            format: "documentation-view-request/0.1",
            kind: "terminals",
          },
        ],
      }),
    );

    assertEveryPrintedTextHasValidRole(packet.sheets);

    const allTexts = packet.sheets.flatMap((s) => printedTexts(s.svg));
    const stripHeading = allTexts.find((t) =>
      t.text.startsWith("JB1 — order unspecified"),
    );
    expect(stripHeading?.role).toBe("designation");
    expect(stripHeading?.fontSize).toBe("2.7");

    const stripIncidence = allTexts.find((t) => t.text.includes("→ PX1.1"));
    expect(stripIncidence?.role).toBe("secondary");

    const stripBridge = allTexts.find((t) => t.text.startsWith("B1 JP1 →"));
    expect(stripBridge?.role).toBe("secondary");

    const stripSide = allTexts.find((t) => t.text === "Same location");
    expect(stripSide?.role).toBe("body");

    const notice = allTexts.find((t) =>
      t.text.startsWith("SELECTED PATH VIEW"),
    );
    expect(notice?.role).toBe("body");

    const legendHeading = allTexts.find(
      (t) => t.text === "Devices on this sheet",
    );
    expect(legendHeading?.role).toBe("body");

    // Negative control: device-tag fields keep their existing semantics.
    const tagDesignation = allTexts.find(
      (t) => t.tagField === "designation" && t.text === "M1",
    );
    expect(tagDesignation?.role).toBe("designation");
    const tagDescription = allTexts.find((t) => t.tagField === "description");
    expect(tagDescription?.role).toBe("body");
  });

  it("emits affirmative roles on cap-pagination assemblies, port pointers, peers, and inline notes", async () => {
    const packet = await renderExamplePacket(
      "examples/cap-pagination",
      "examples/cap-pagination/packet.json",
    );
    assertEveryPrintedTextHasValidRole(packet.sheets);

    const allTexts = packet.sheets.flatMap((s) => printedTexts(s.svg));
    const capOwner = allTexts.find((t) => t.text === "CAP-X01");
    expect(capOwner?.role).toBe("designation");
    expect(capOwner?.fontSize).toBe("2.916");

    const portPointer = allTexts.find((t) => t.text.startsWith("Port R1.X06"));
    expect(portPointer?.role).toBe("secondary");

    const peerRef = allTexts.find((t) => t.text.includes("inventory →"));
    expect(peerRef?.role).toBe("secondary");

    const viewHeading = allTexts.find((t) => t.fontSize === "4");
    expect(viewHeading?.role).toBe("body");
  });

  it("emits affirmative roles on network-pagination communication links and continuations", async () => {
    const packet = await renderExamplePacket(
      "examples/network-pagination",
      "examples/network-pagination/packet.json",
    );
    assertEveryPrintedTextHasValidRole(packet.sheets);

    const allTexts = packet.sheets.flatMap((s) => printedTexts(s.svg));
    const linkOwner = allTexts.find((t) => t.text === "NET01");
    expect(linkOwner?.role).toBe("designation");
    expect(linkOwner?.fontSize).toBe("2.916");

    const portCont = allTexts.find((t) => t.text.includes("port OUT →"));
    expect(portCont?.role).toBe("secondary");

    const devCont = allTexts.find((t) => t.text.startsWith("N02 -> "));
    expect(devCont?.role).toBe("secondary");
  });

  it("emits affirmative roles on circuit-pagination group headings and continuations", async () => {
    const packet = await renderExamplePacket(
      "examples/circuit-pagination",
      "examples/circuit-pagination/packet.json",
    );
    assertEveryPrintedTextHasValidRole(packet.sheets);

    const allTexts = packet.sheets.flatMap((s) => printedTexts(s.svg));
    const groupHeading = allTexts.find((t) =>
      t.text.includes("Series contact chain"),
    );
    expect(groupHeading?.role).toBe("body");

    const circuitCont = allTexts.find((t) => t.text.startsWith("C4.1 -> "));
    expect(circuitCont?.role).toBe("secondary");
  });

  it("emits affirmative roles on signal-loop assembly designations, descriptions, enclosures, and dependency captions", async () => {
    const packet = await renderFixtureSignalLoop(
      "packages/cli/fixtures/signal-loop",
      {
        format: "schematic-packet-request/0.1",
        layout: "compact",
        page: { size: "tabloid", orientation: "landscape" },
        views: [
          {
            format: "signal-loop-view-request/0.1",
            from: { device: "PT1", function: "signal" },
            to: { device: "AI1", function: "ch0" },
            cableAssemblies: [
              {
                cable: "CB1",
                connector: "M12",
                description: "4-pole A-coded molded cordset (proposed)",
              },
            ],
            enclosures: [
              {
                label: "Main electrical cabinet",
                devices: ["XP1", "XT1", "AI1"],
                wallDevice: "XP1",
              },
            ],
          },
          {
            format: "documentation-view-request/0.1",
            kind: "cables",
          },
        ],
      },
    );
    assertEveryPrintedTextHasValidRole(packet.sheets);

    const allTexts = packet.sheets.flatMap((s) => printedTexts(s.svg));
    const cableOwner = allTexts.find((t) => t.text === "CB1");
    expect(cableOwner?.role).toBe("designation");

    const cableDesc = allTexts.find((t) => t.text.includes("4-pole A-coded"));
    expect(cableDesc?.role).toBe("body");

    const enclosure = allTexts.find(
      (t) => t.text === "Main electrical cabinet",
    );
    expect(enclosure?.role).toBe("body");

    const depCaption = allTexts.find((t) =>
      t.text.startsWith("Cable core details:"),
    );
    expect(depCaption?.role).toBe("secondary");
  });

  it("SvgWriter refuses nonempty <text> without a valid data-text-role and allows empty placeholders", () => {
    const writer = new SvgWriter();
    expect(() =>
      Reflect.apply(writer.element, writer, [
        1,
        "text",
        { x: 10, y: 10 },
        "Unattributed",
      ]),
    ).toThrow(/data-text-role/);
    expect(() =>
      Reflect.apply(writer.element, writer, [
        1,
        "text",
        { x: 10, y: 10, "data-text-role": "bogus" },
        "Bad role",
      ]),
    ).toThrow(/data-text-role/);
    expect(() =>
      Reflect.apply(writer.open, writer, [1, "text", { x: 10, y: 10 }]),
    ).toThrow(/data-text-role/);
    writer.element(1, "text", { "clip-path": "url(#empty)" }, "");
    writer.element(
      1,
      "text",
      { "data-text-role": "designation", x: 10, y: 10 },
      "M1",
    );
    const out = writer.finish();
    expect(out).toContain('<text clip-path="url(#empty)"></text>');
    expect(out).toContain('data-text-role="designation"');
  });

  it("SvgWriter enforces role invariant across raw(), runtime elements, and finish() while preserving inherited tspans", () => {
    const privateCheck = new SvgWriter();
    expect(Reflect.get(privateCheck, "lines")).toBeUndefined();

    for (const badRaw of [
      '<text x="20" y="20">A</text>',
      '<text x="20" y="20"><![CDATA[A]]></text>',
      '<foreignObject x="20" y="30" width="20" height="10"><div xmlns="http://www.w3.org/1999/xhtml">A</div></foreignObject>',
      "<tspan>Orphan</tspan>",
      '<text data-text-role="bogus"></text>',
      '<text data-text-role="body"><tspan data-text-role="bogus">A</tspan></text>',
    ]) {
      const w = new SvgWriter();
      w.raw(badRaw);
      expect(() => w.finish()).toThrow(/SVG emitter rejected/);
    }

    const runtimeForeign = new SvgWriter();
    expect(() =>
      Reflect.apply(runtimeForeign.element, runtimeForeign, [
        0,
        "foreignObject",
        {},
        "A",
      ]),
    ).toThrow(/foreignObject/);

    const runtimeTspan = new SvgWriter();
    runtimeTspan.open(0, "text", { "data-text-role": "body" });
    expect(() =>
      Reflect.apply(runtimeTspan.element, runtimeTspan, [
        1,
        "tspan",
        { "data-text-role": "bogus" },
        "A",
      ]),
    ).toThrow(/data-text-role/);

    const valid = new SvgWriter();
    valid.raw('<text clip-path="url(#empty)"/>');
    valid.raw('<foreignObject width="10" height="10"></foreignObject>');
    valid.open(0, "text", { "data-text-role": "body" });
    valid.raw("<tspan>Inherited</tspan>");
    valid.raw('<tspan data-text-role="secondary">Overridden</tspan>');
    valid.close(0, "text");
    expect(valid.finish()).toContain("<tspan>Inherited</tspan>");
  });

  it("classifies owning cable headings and rail device designations as designation and off-view rows as secondary", async () => {
    const packet = await renderExamplePacket(
      "examples/motor-starter",
      undefined,
      () => ({
        format: "schematic-packet-request/0.1",
        views: [
          {
            format: "schematic-view-request/0.1",
            root: { by: "designation", value: "K1" },
            family: "control",
            flow: "left-to-right",
          },
          {
            format: "schematic-view-request/0.2",
            root: { by: "designation", value: "CBL1" },
            intent: { kind: "conductors" },
            flow: "left-to-right",
          },
        ],
      }),
    );
    assertEveryPrintedTextHasValidRole(packet.sheets);

    const cableTexts = printedTexts(packet.sheets[1]!.svg);
    const cableHeading = cableTexts.find((t) => t.text === "CABLE CBL1");
    expect(cableHeading?.role).toBe("designation");
    expect(cableHeading?.fontSize).toBe("4");

    const compiled = await compileProject(repoPath("examples/motor-starter"));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const rendered = await renderSchematic(compiled.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "K1" },
      family: "control",
      flow: "left-to-right",
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
    const { document } = parseHTML(rendered.value.svg);
    const railTags = [...document.querySelectorAll("text.rail-device-tag")];
    expect(railTags.length).toBeGreaterThan(0);
    for (const el of railTags) {
      expect(el.getAttribute("data-text-role")).toBe("designation");
    }
    const offViewRows = [...document.querySelectorAll("text.off-view-row")];
    expect(offViewRows.length).toBeGreaterThan(0);
    for (const el of offViewRows) {
      expect(el.getAttribute("data-text-role")).toBe("secondary");
    }
  });

  it("classifies undesignated assembly endpoint-reference captions as secondary rather than designation", async () => {
    const compiled = await compileProject(
      repoPath("examples/assembly-note-bounds"),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const cloned = structuredClone(compiled.ir);
    const assembly = cloned.relations.find((r) => r.assembly);
    expect(assembly).toBeDefined();
    Reflect.deleteProperty(assembly!, "designation");
    const packet = await renderSchematicPacket(
      cloned,
      {
        format: "schematic-packet-request/0.1",
        views: [
          {
            format: "connector-assembly-view-request/0.1",
            title: "Undesignated assembly test",
            assemblies: [assembly!.uid],
          },
        ],
      },
      compiled.presentation,
    );
    expect(packet.ok).toBe(true);
    if (!packet.ok) throw new Error(JSON.stringify(packet.error));
    assertEveryPrintedTextHasValidRole(packet.value.sheets);

    const { document } = parseHTML(packet.value.sheets[0]!.svg);
    const captionTexts = [
      ...document.querySelectorAll(
        `g[data-assembly-label="${assembly!.uid}"] text`,
      ),
    ];
    expect(captionTexts.length).toBeGreaterThanOrEqual(2);
    expect(captionTexts[0]!.getAttribute("data-text-role")).toBe("secondary");
    expect(captionTexts[0]!.textContent).toContain("R1.X1");
    expect(captionTexts[0]!.textContent).toContain("S1.P");
    for (const el of captionTexts.slice(1)) {
      expect(el.getAttribute("data-text-role")).toBe("body");
    }
  });
});
