import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileProject, lockProject } from "@thermite/compiler";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/index.js";
import { splitTwoLineNetLabel } from "../src/presentation/net-label-wrap.js";
import { parseSvg } from "./off-view-fixtures.js";

async function pumpVariantObjects(
  phaseNames: readonly [string, string, string],
): Promise<Record<string, unknown>> {
  const raw: unknown = JSON.parse(
    await readFile(
      resolve(import.meta.dirname, "fixtures/agent-refusals/pump.json"),
      "utf8",
    ),
  );
  assert.ok(
    typeof raw === "object" &&
      raw !== null &&
      "objects" in raw &&
      Array.isArray(raw.objects),
  );
  const byTerm = new Map([
    ["L1", phaseNames[0]],
    ["L2", phaseNames[1]],
    ["L3", phaseNames[2]],
  ]);
  for (const obj of raw.objects) {
    if (
      typeof obj !== "object" ||
      obj === null ||
      !("kind" in obj) ||
      obj.kind !== "potential" ||
      !("at" in obj) ||
      typeof obj.at !== "object" ||
      obj.at === null ||
      !("device" in obj.at) ||
      obj.at.device !== "SUP1" ||
      !("terminal" in obj.at) ||
      typeof obj.at.terminal !== "string"
    ) {
      continue;
    }
    const next = byTerm.get(obj.at.terminal);
    if (next !== undefined && "name" in obj) obj.name = next;
  }
  return { objects: raw.objects };
}

async function compilePumpVariant(
  tag: string,
  phaseNames: readonly [string, string, string],
) {
  const root = await mkdtemp(join(tmpdir(), `thermite-ttblong-${tag}-`));
  await writeFile(
    join(root, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: `Synthetic ${tag}` },
      sources: ["source.json"],
      libraries: [{ name: "core", version: "0.2.0" }],
    }),
  );
  await writeFile(
    join(root, "source.json"),
    JSON.stringify(await pumpVariantObjects(phaseNames)),
  );
  const locked = await lockProject(root);
  assert.ok(locked.ok, JSON.stringify(locked));
  const compiled = await compileProject(root);
  assert.ok(compiled.ok, JSON.stringify(compiled));
  return {
    ir: compiled.ir,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function phaseTriple(sample: string): readonly [string, string, string] {
  return [
    sample,
    sample.replace(/L1$/u, "L2"),
    sample.replace(/L1$/u, "L3"),
  ] as const;
}

function netLabelGroups(svg: string) {
  const doc = parseSvg(svg);
  const byClip = new Map<
    string,
    { lines: string[]; fontSizes: number[]; ys: number[] }
  >();
  for (const el of doc.querySelectorAll("text.label-net")) {
    const text = el.textContent ?? "";
    if (!text) continue;
    const clip = el.getAttribute("clip-path") ?? "";
    const entry = byClip.get(clip) ?? { lines: [], fontSizes: [], ys: [] };
    entry.lines.push(text);
    entry.fontSizes.push(Number(el.getAttribute("font-size")));
    entry.ys.push(Number(el.getAttribute("y")));
    byClip.set(clip, entry);
  }
  return [...byClip.values()];
}

it("splits potential names only at existing separators closest to the middle (#576)", () => {
  expect(
    splitTwoLineNetLabel(
      "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-01-L1",
    ),
  ).toEqual(["MCC1-MAIN-MOTOR-POWER-480VAC-", "BUS-FEEDER-PANEL-MOD-01-L1"]);
  expect(splitTwoLineNetLabel("MAIN_BUS_480VAC_FEEDER_L1")).toEqual([
    "MAIN_BUS_",
    "480VAC_FEEDER_L1",
  ]);
  expect(splitTwoLineNetLabel("PANEL.A.480VAC.BUS.L1")).toEqual([
    "PANEL.A.",
    "480VAC.BUS.L1",
  ]);
  expect(splitTwoLineNetLabel("MAIN/FEEDER/480V/L1")).toEqual([
    "MAIN/FEEDER/",
    "480V/L1",
  ]);
  expect(splitTwoLineNetLabel("MAIN PANEL 480VAC BUS L1")).toEqual([
    "MAIN PANEL ",
    "480VAC BUS L1",
  ]);
  expect(
    splitTwoLineNetLabel(
      "MAINPOWERPANEL480VACBUSFEEDERSECTIONAMAINFEEDERBRANCHL1",
    ),
  ).toBeUndefined();
});

it.each([
  ["length-55", "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-01-L1"],
  ["length-60", "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-ALPHA-1-L1"],
] as const)(
  "issues TTB Tabloid landscape power packet with verbatim two-line source net labels for %s (#576)",
  async (tag, sample) => {
    const names = phaseTriple(sample);
    const fixture = await compilePumpVariant(tag, names);
    try {
      const packet = await renderSchematicPacket(fixture.ir, {
        format: "schematic-packet-request/0.1",
        page: { size: "tabloid", orientation: "landscape" },
        views: [
          {
            format: "schematic-view-request/0.1",
            root: { by: "designation", value: "M1" },
            family: "power",
            flow: "top-to-bottom",
          },
        ],
      });
      assert.ok(packet.ok, JSON.stringify(packet));
      const groups = packet.value.sheets.flatMap((s) => netLabelGroups(s.svg));
      const reconstructed = [
        ...new Set(
          groups.map((g) => g.lines.join("")).filter((t) => names.includes(t)),
        ),
      ].sort();
      expect(reconstructed).toEqual([...names].sort());
      for (const group of groups.filter((g) =>
        names.includes(g.lines.join("")),
      )) {
        expect(group.lines).toHaveLength(2);
        expect(group.fontSizes).toEqual([10, 10]);
        expect(group.ys[1]! - group.ys[0]!).toBeGreaterThanOrEqual(12);
      }
    } finally {
      await fixture.dispose();
    }
  },
);

it("keeps single-line source net labels for short phases alongside wrapped long phases (#576)", async () => {
  const names = [
    "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-ALPHA-1-L1",
    "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-ALPHA-1-L2",
    "480VAC-L3",
  ] as const;
  const fixture = await compilePumpVariant("mixed", names);
  try {
    const packet = await renderSchematicPacket(fixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow: "top-to-bottom",
        },
      ],
    });
    assert.ok(packet.ok, JSON.stringify(packet));
    const groups = packet.value.sheets.flatMap((s) => netLabelGroups(s.svg));
    const byText = new Map(groups.map((g) => [g.lines.join(""), g]));
    expect(byText.get(names[0])?.lines).toHaveLength(2);
    expect(byText.get(names[1])?.lines).toHaveLength(2);
    expect(byText.get(names[2])?.lines).toEqual(["480VAC-L3"]);
  } finally {
    await fixture.dispose();
  }
});

it("refuses with actionable R006 naming potential and widths when no separator exists (#576)", async () => {
  const sample = "MAINPOWERPANEL480VACBUSFEEDERSECTIONAMAINFEEDERBRANCHL1";
  const names = phaseTriple(sample);
  const fixture = await compilePumpVariant("nosep", names);
  try {
    const packet = await renderSchematicPacket(fixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow: "top-to-bottom",
        },
      ],
    });
    expect(packet.ok).toBe(false);
    if (packet.ok) return;
    expect(packet.error.code).toBe("R006");
    expect(packet.error.message).toContain(sample);
    expect(packet.error.message).toMatch(
      /protected width [0-9.]+ mm exceeds 375\.80 mm/u,
    );
    expect(packet.error.message).toMatch(/shorter potential name/iu);
    expect(packet.error.message).toMatch(/larger sheet/iu);
  } finally {
    await fixture.dispose();
  }
});

it("refuses with actionable R006 when even the two-line form still exceeds the field (#576)", async () => {
  const sample = "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-01-L1";
  const names = phaseTriple(sample);
  const fixture = await compilePumpVariant("two-line-too-wide", names);
  try {
    const packet = await renderSchematicPacket(fixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "portrait" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow: "top-to-bottom",
        },
      ],
    });
    expect(packet.ok).toBe(false);
    if (packet.ok) return;
    expect(packet.error.code).toBe("R006");
    expect(packet.error.message).toContain(sample);
    expect(packet.error.message).toMatch(
      /protected width [0-9.]+ mm exceeds 159\.90 mm/u,
    );
    expect(packet.error.message).toMatch(/shorter potential name/iu);
    expect(packet.error.message).toMatch(/larger sheet/iu);
  } finally {
    await fixture.dispose();
  }
});

it("breaks space-separated 60-character TTB source net labels verbatim onto two lines (#576)", async () => {
  const sample = "MCC1 MAIN MOTOR POWER 480VAC BUS FEEDER PANEL MOD ALPHA 1 L1";
  const names = phaseTriple(sample);
  const fixture = await compilePumpVariant("space-60", names);
  try {
    const packet = await renderSchematicPacket(fixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow: "top-to-bottom",
        },
      ],
    });
    assert.ok(packet.ok, JSON.stringify(packet));
    const groups = packet.value.sheets.flatMap((s) => netLabelGroups(s.svg));
    const reconstructed = [
      ...new Set(
        groups.map((g) => g.lines.join("")).filter((t) => names.includes(t)),
      ),
    ].sort();
    expect(reconstructed).toEqual([...names].sort());
    for (const group of groups.filter((g) =>
      names.includes(g.lines.join("")),
    )) {
      expect(group.lines).toHaveLength(2);
      expect(group.lines[0]!.endsWith(" ")).toBe(true);
      expect(group.fontSizes).toEqual([10, 10]);
    }
  } finally {
    await fixture.dispose();
  }
});

it("keeps LTR long names and <=24-char fitting TTB names single-line (#576)", async () => {
  const longNames = phaseTriple(
    "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-ALPHA-1-L1",
  );
  const shortNames = phaseTriple("MAIN-PANEL-480VAC-BUS-L1");
  const longFixture = await compilePumpVariant("ltr-60", longNames);
  const shortFixture = await compilePumpVariant("ttb-24", shortNames);
  try {
    const ltr = await renderSchematicPacket(longFixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow: "left-to-right",
        },
      ],
    });
    assert.ok(ltr.ok, JSON.stringify(ltr));
    for (const group of ltr.value.sheets.flatMap((s) => netLabelGroups(s.svg))) {
      if (longNames.includes(group.lines.join(""))) {
        expect(group.lines).toHaveLength(1);
      }
    }
    const ttb = await renderSchematicPacket(shortFixture.ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "landscape" },
      views: [
        {
          format: "schematic-view-request/0.1",
          root: { by: "designation", value: "M1" },
          family: "power",
          flow: "top-to-bottom",
        },
      ],
    });
    assert.ok(ttb.ok, JSON.stringify(ttb));
    for (const group of ttb.value.sheets.flatMap((s) => netLabelGroups(s.svg))) {
      if (shortNames.includes(group.lines.join(""))) {
        expect(group.lines).toHaveLength(1);
      }
    }
  } finally {
    await longFixture.dispose();
    await shortFixture.dispose();
  }
});

it("enforces two-line box clearance against non-owner frames in validate-output (#576)", async () => {
  const names = phaseTriple(
    "MCC1-MAIN-MOTOR-POWER-480VAC-BUS-FEEDER-PANEL-MOD-ALPHA-1-L1",
  );
  const fixture = await compilePumpVariant("twoline-collision", names);
  try {
    const { layoutPresentationGraph } = await import(
      "../src/layout/elk-adapter.js"
    );
    const { createElkEngine } = await import("../src/layout/elk-runtime.js");
    const { wrapPresentationNetLabels } = await import(
      "../src/presentation/net-label-wrap.js"
    );
    const { agentPresentation } = await import("./helpers/agent-recovery.js");
    const { graph: baseGraph, selected } = agentPresentation(fixture.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "M1" },
      family: "power",
      flow: "top-to-bottom",
    });
    const wrapIds = new Set(
      baseGraph.edges
        .filter((e) => e.netLabel && names.includes(e.netLabel.text))
        .map((e) => e.netLabel!.id),
    );
    const wrapped = wrapPresentationNetLabels(baseGraph, wrapIds);
    const baseEngine = createElkEngine();
    const realLayout = baseEngine.layout.bind(baseEngine);
    const engine = createElkEngine();
    engine.layout = async (input, options) => {
      const output = await realLayout(input, options);
      const nonOwner = output.children
        ?.flatMap((loc) => loc.children ?? [])
        .find((dev) => dev.labels?.[0]?.text !== "SUP1");
      const loc = output.children?.find((l) =>
        l.children?.some((d) => d === nonOwner),
      );
      const netLabel = output.edges
        ?.flatMap((e) => e.labels ?? [])
        .find((l) => l.text === names[0]);
      assert.ok(nonOwner && loc && netLabel);
      // Place only the second line (bottom half of the 28-unit box) into the non-owner frame.
      netLabel.x = (loc.x ?? 0) + (nonOwner.x ?? 0) + 4;
      netLabel.y = (loc.y ?? 0) + (nonOwner.y ?? 0) - 18;
      return output;
    };
    const outcome = await layoutPresentationGraph(wrapped, {
      engine,
      selected,
    });
    expect(outcome).toMatchObject({
      ok: false,
      failureKind: "net-label-intersection",
      error: { code: "R004" },
    });
  } finally {
    await fixture.dispose();
  }
});
