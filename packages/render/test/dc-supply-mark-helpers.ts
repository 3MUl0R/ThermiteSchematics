import {
  compileProject,
  lockProject,
  type ElectricalIr,
  type IrDeviceType,
  type IrDeviceTypeTerminal,
  type IrFunction,
} from "@thermite/compiler";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { expect } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";

export type SupplyTerminalSpec = IrDeviceTypeTerminal;

export async function corePsuFixture() {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const ir = structuredClone(compiled.ir);
  const ps1 = ir.devices.find((d) => d.designation === "PS1")!;
  const type = ir.deviceTypes.find((t) => t.id === ps1.typeId)!;
  const acInput = ir.functions.find(
    (f) => f.id.deviceUid === ps1.uid && f.id.functionKey === "ac_input",
  )!;
  const dcOutput = ir.functions.find(
    (f) => f.id.deviceUid === ps1.uid && f.id.functionKey === "dc_output",
  )!;
  return { ir, ps1, type, acInput, dcOutput };
}

export function makeSupplyFace(
  baseType: IrDeviceType,
  deviceUid: string,
  kind: "load" | "source",
  terminals: SupplyTerminalSpec[],
  options: {
    symbol?: string;
    functionKey?: string;
    circuitSymbols?: Record<string, string>;
  } = {},
): { t: IrDeviceType; fn: IrFunction } {
  const t = structuredClone(baseType);
  t.symbol = options.symbol ?? "thermite:dc-supply";
  if (options.circuitSymbols) t.circuitSymbols = options.circuitSymbols;
  else delete t.circuitSymbols;
  t.terminals = terminals;
  const fn: IrFunction = {
    id: { deviceUid, functionKey: options.functionKey ?? "face" },
    kind,
    terminals: terminals.map((p) => ({ deviceUid, terminalKey: p.key })),
  };
  return { t, fn };
}

export function makePeAnchorIr(
  baseIr: ElectricalIr,
  typeId: string,
  deviceUid: string,
  terminals: SupplyTerminalSpec[],
  anchorKey: string,
  options: {
    kind?: "load" | "source";
    functionKey?: string;
    potentialUid: string;
    potentialName?: string;
    netId?: string;
    replaceTerminals?: boolean;
  },
) {
  const potIr = structuredClone(baseIr);
  const t = potIr.deviceTypes.find((d) => d.id === typeId)!;
  t.symbol = "thermite:dc-supply";
  delete t.circuitSymbols;
  t.terminals = terminals;
  if (options.replaceTerminals !== false) {
    potIr.terminals = potIr.terminals.filter(
      (x) => x.id.deviceUid !== deviceUid,
    );
    for (const p of terminals) {
      potIr.terminals.push({
        id: { deviceUid, terminalKey: p.key },
        ...(p.role ? { role: p.role } : {}),
        ...(p.rating ? { rating: p.rating } : {}),
        source: t.source,
      });
    }
  }
  potIr.potentials.push({
    uid: options.potentialUid,
    name: options.potentialName ?? "PE",
    electrical: { polarity: "protective_earth" },
    aliases: [],
    terminal: { deviceUid, terminalKey: anchorKey },
    netId: options.netId ?? "net:pe",
    terminalSource: t.source,
    source: t.source,
  });
  const fn: IrFunction = {
    id: { deviceUid, functionKey: options.functionKey ?? "face" },
    kind: options.kind ?? "load",
    terminals: terminals.map((p) => ({ deviceUid, terminalKey: p.key })),
  };
  return { ir: potIr, t, fn };
}

export async function renderCircuitGroupsHtml(
  ir: ElectricalIr,
  title: string,
  flow: "left-to-right" | "top-to-bottom",
  groups: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly deviceUid: string;
    readonly key: string;
  }>,
) {
  const rendered = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "circuit-view-request/0.1",
        title,
        flow,
        groups: groups.map((g) => ({
          id: g.id,
          label: g.label,
          functions: [
            { device: { by: "uid" as const, value: g.deviceUid }, key: g.key },
          ],
          conductors: [],
        })),
      },
    ],
  });
  expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
  if (!rendered.ok) throw new Error(rendered.error.message);
  return parseHTML(rendered.value.html).document;
}

export async function compileTempSupplyProject(
  prefix: string,
  spec: {
    projectName: string;
    libraryName: string;
    types: unknown[];
    objects: unknown[];
  },
) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "library"), { recursive: true });
  await writeFile(
    join(dir, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: spec.projectName },
      sources: ["source.json"],
      libraries: [
        { name: spec.libraryName, version: "0.1.0", path: "library" },
      ],
    }),
  );
  await writeFile(
    join(dir, "library/library.json"),
    JSON.stringify({
      name: spec.libraryName,
      version: "0.1.0",
      sources: ["types.json"],
    }),
  );
  await writeFile(
    join(dir, "library/types.json"),
    JSON.stringify({ types: spec.types }),
  );
  await writeFile(
    join(dir, "source.json"),
    JSON.stringify({ objects: spec.objects }),
  );
  const locked = await lockProject(dir);
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  const compiled = await compileProject(dir);
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  return { dir, ir: compiled.ir };
}
