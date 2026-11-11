import { beforeAll, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import {
  renderSchematic,
  createSchematicRendererWithDependencies,
} from "../src/renderer.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { createElkEngine } from "../src/layout/elk-runtime.js";
import { errorContractCases } from "./render-contract-fixture.js";
import { renderErrorContext } from "../src/render-error-context.js";
import { svgSemanticId } from "../src/svg/escape.js";
import {
  PrintableFontBudgetError,
  fontBudgetFailure,
} from "../../cli/src/printable-font.js";
import type { RenderOutcome } from "../src/types.js";

let cases: Awaited<ReturnType<typeof errorContractCases>>;
let core: ElectricalIr;
beforeAll(async () => {
  cases = await errorContractCases();
  const c = await compileProject("examples/motor-starter");
  if (!c.ok) throw Error("compile");
  core = c.ir;
});

function errorOf<T>(result: RenderOutcome<T>, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw Error(`Expected ${code}`);
  expect(result.error.code).toBe(code);
  return result.error;
}

// All seven R codes have an emitted example. Project/page/font errors have no
// affected device; their own scope must survive without an invented designation.
it.each([
  ["R001", "PLC1"],
  ["R002", "PS1"],
  ["R003", "TB1"],
  ["R004", "RIO2"],
  ["R005", "K1"],
  ["R006", "PX1"],
  ["R007", undefined],
] as const)("locates the affected object for %s", async (code, designation) => {
  if (code === "R007") {
    const error = fontBudgetFailure(
      new PrintableFontBudgetError(70_000, 60_000),
    );
    expect(error).toMatchObject({
      code,
      details: { bytes: 70_000, maximum: 60_000 },
    });
    expect(error).not.toHaveProperty("details.designation");
    return;
  }
  const c = cases.find((c) => c.code === code);
  if (!c) throw Error(code);
  let result: RenderOutcome<unknown>;
  if (code === "R004") {
    const wire = c.ir.wires.find((w) => w.designation === "W-RIO2-L+");
    if (!wire) throw Error("wire");
    const engine = createElkEngine(),
      layout = engine.layout.bind(engine);
    engine.layout = async (...args) => {
      const output = await layout(...args);
      const section = output.edges?.find(
        (e) => e.id === JSON.stringify(["wire", wire.uid]),
      )?.sections?.[0];
      if (!section) throw Error("section");
      section.startPoint.x += 1;
      return output;
    };
    result = await createSchematicRendererWithDependencies({
      layoutEngine: engine,
    }).render(c.ir, c.view);
  } else if (code === "R005") {
    const input = structuredClone(core);
    const wire = input.wires.find((w) => w.designation === "W-CTL-007");
    if (!wire) throw Error("wire");
    wire.properties = { ...wire.properties, label: "bad\u0001label" };
    result = await renderSchematic(input, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "K1" },
      family: "control",
    });
  } else if ("packet" in c)
    result = await renderSchematicPacket(c.ir, c.packet);
  else result = await renderSchematic(c.ir, c.view);
  const error = errorOf(result, code);
  if (code === "R005")
    expect(error.details).toMatchObject({
      designation: "W-CTL-007",
      terminals: expect.arrayContaining([
        expect.objectContaining({ designation: "K1", terminalKey: "A1" }),
      ]),
    });
  expect(
    JSON.stringify({ message: error.message, details: error.details }),
  ).toContain(designation);
});

it("resolves UID circuit selectors even before drawing with a custom title", async () => {
  const device = core.devices.find((d) => d.designation === "K1");
  if (!device) throw Error("device");
  const error = errorOf(
    await renderSchematicPacket(core, {
      format: "schematic-packet-request/0.1",
      views: [
        {
          format: "circuit-view-request/0.1",
          title: "Custom title",
          groups: [
            {
              id: "bad-coil",
              conductors: [],
              functions: [
                { device: { by: "uid", value: device.uid }, key: "ABSENT" },
              ],
            },
          ],
        },
      ],
    }),
    "R006",
  );
  expect(error.details).toMatchObject({
    circuitGroups: [{ groupId: "bad-coil", functionKeys: ["K1/ABSENT"] }],
  });
});

it.each(["terminal", "function", "aggregate"] as const)(
  "keeps the %s key alongside the text owner's designation",
  (kind) => {
    const device = core.devices.find((d) => d.designation === "K1");
    if (!device) throw Error("device");
    const key = kind === "terminal" ? "A1" : "coil";
    const error = renderErrorContext(core, {
      code: "R005",
      family: "control",
      root: "K1",
      ownerKind: kind,
      ownerId: svgSemanticId(kind, [device.uid, key]),
      field:
        kind === "terminal"
          ? "terminal.key"
          : kind === "function"
            ? "function.key"
            : "aggregate.key",
      reason: "xml-illegal-code-point",
      message: "Invalid render text.",
    });
    expect(error.details).toMatchObject({
      designation: "K1",
      [`${kind === "aggregate" ? "aggregate" : kind}Key`]: key,
    });
  },
);

it("does not fabricate a designation for an unresolved text owner or a project title", () => {
  for (const ownerKind of ["device", "project"] as const) {
    const error = renderErrorContext(core, {
      code: "R005",
      family: "control",
      root: "K1",
      ownerKind,
      ownerId: "absent",
      field: "title.project-line",
      reason: "xml-illegal-code-point",
      message: "Invalid render text.",
    });
    expect(error.details).toBeUndefined();
  }
});

it("names cable-core endpoints when a UID wiring selection fails before drawing", async () => {
  const cable = core.cables.find((c) => c.designation === "CBL1");
  const conductor = core.cableConductors.find(
    (c) => c.cableUid === cable?.uid && c.id.conductorId === "1+",
  );
  if (!conductor) throw Error("core");
  const error = errorOf(
    await renderSchematicPacket(core, {
      format: "schematic-packet-request/0.1",
      views: [
        {
          format: "wiring-view-request/0.1",
          title: "Core ordering",
          conductors: [JSON.stringify(conductor.id)],
          deviceOrder: ["ABSENT"],
        },
      ],
    }),
    "R006",
  );
  expect(error.details?.devices).toEqual([
    {
      deviceUid: conductor.endpoints[0].terminal.deviceUid,
      designation: "TB1",
      functions: [],
      terminals: ["2"],
    },
    {
      deviceUid: conductor.endpoints[1].terminal.deviceUid,
      designation: "JB1",
      functions: [],
      terminals: ["X1.1"],
    },
  ]);
});
