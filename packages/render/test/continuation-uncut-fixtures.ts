import { compileProject } from "@thermite/compiler";
import type { SchematicPacketRequest } from "../src/sheets.js";

export async function uncutFixture(name: "init-starter" | "motor-starter") {
  const c = await compileProject(
    name === "init-starter"
      ? "packages/cli/templates/starter-default"
      : "examples/motor-starter",
  );
  if (!c.ok) throw Error(JSON.stringify(c));
  const root = (value: string) => ({ by: "designation" as const, value });
  const flow = "left-to-right" as const;
  const loads = {
    format: "schematic-view-request/0.2",
    root: root("PS1"),
    intent: { kind: "loads" },
    flow,
  } as const;
  const request: SchematicPacketRequest = {
    format: "schematic-packet-request/0.1",
    page: {
      size: "tabloid",
      orientation: "landscape",
      ...(name === "motor-starter" ? { marginMm: 10 } : {}),
    },
    ...(name === "init-starter" ? { layout: "compact" } : {}),
    views:
      name === "init-starter"
        ? [loads]
        : [
            {
              format: "schematic-view-request/0.1",
              root: root("M1"),
              family: "power",
              flow,
            },
            {
              format: "schematic-view-request/0.1",
              root: root("K1"),
              family: "control",
              flow,
            },
            loads,
            {
              format: "schematic-view-request/0.2",
              root: root("LS1"),
              intent: { kind: "trace", to: root("PLC1"), includePower: true },
              flow,
            },
            {
              format: "schematic-view-request/0.2",
              root: root("CBL1"),
              intent: { kind: "conductors" },
              flow,
            },
          ],
  };
  return { ir: c.ir, presentation: c.presentation, request };
}
