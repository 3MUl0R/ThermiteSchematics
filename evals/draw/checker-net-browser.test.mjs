import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { createSchematicRenderer } from "../../packages/render/dist/index.js";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { netLabelRepetition, terminalText } from "./checks.mjs";
import { command, json, readJson } from "./support.mjs";
let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
});
import { netDrawing as drawing } from "./net-label-fixture.mjs";
it("222.3 painted label at the target fails with coherent false source claims", async () => {
  expect(netLabelRepetition(await openSheet(page, drawing()))).toEqual([]);
  const g = await openSheet(page, drawing({ far: true, falseSource: true }));
  expect(netLabelRepetition(g).map((f) => f.kind)).toEqual([
    "net-label-source-geometry-mismatch",
  ]);
});
function addWideThreePhasePotentials(potentials) {
  const l1 = potentials.objects.find(
    (o) =>
      o.kind === "potential" &&
      o.at?.device === "SRC1" &&
      o.at?.terminal === "L1",
  );
  if (l1) l1.name = "480VAC-L1";
  potentials.objects.push(
    {
      uid: "8c28fde4-d3a2-4ee3-8cfc-b1323845f39e",
      kind: "potential",
      name: "480VAC-L2",
      at: { device: "SRC1", terminal: "L2" },
      electrical: {
        nominal_voltage: 480,
        voltage_type: "AC",
        polarity: "line_2",
        frequency: 60,
      },
    },
    {
      uid: "8c28fde4-d3a2-4ee3-8cfc-b1323845f39f",
      kind: "potential",
      name: "480VAC-L3",
      at: { device: "SRC1", terminal: "L3" },
      electrical: {
        nominal_voltage: 480,
        voltage_type: "AC",
        polarity: "line_3",
        frequency: 60,
      },
    },
  );
}

it("DQ-17 accepts TTB three-phase source net labels anchored at route source (#570)", async () => {
  const root = process.cwd();
  const dest = await mkdtemp(join(tmpdir(), "draw-netlabel-ttb-"));
  const project = join(dest, "project");
  try {
    await cp(join(root, "examples/motor-starter"), project, {
      recursive: true,
    });
    const potPath = join(project, "potentials/potentials.json");
    const potentials = await readJson(potPath);
    addWideThreePhasePotentials(potentials);
    await writeFile(potPath, json(potentials));
    const lock = await command(root, process.execPath, [
      join(root, "thermite.mjs"),
      "lock",
      project,
    ]);
    expect(lock.code).toBe(0);
    const compiled = await compileProject(project);
    expect(compiled.ok).toBe(true);
    const rendered = await createSchematicRenderer().render(compiled.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "M1" },
      family: "power",
      flow: "top-to-bottom",
    });
    expect(rendered.ok).toBe(true);
    const g = await openSheet(page, rendered.value.svg);
    const paintedNetLabels = g.texts
      .filter(
        (t) =>
          t.labelRole === "net" &&
          t.labelOwnerKind === "edge" &&
          t.painted !== false,
      )
      .map((t) => t.text)
      .sort();
    expect(paintedNetLabels).toEqual(["480VAC-L1", "480VAC-L2", "480VAC-L3"]);
    expect(terminalText(g, compiled.ir)).toEqual([]);
    expect(netLabelRepetition(g, compiled.ir)).toEqual([]);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
