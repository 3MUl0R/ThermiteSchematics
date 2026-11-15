import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import {
  createSchematicRenderer,
  renderSchematic,
  renderSchematicPacket,
  renderSchematicSheets,
  normalizePaperPage,
  type RenderOutcome,
} from "../src/index.js";
import * as elkRuntime from "../src/layout/elk-runtime.js";
import { errorContractCases } from "./render-contract-fixture.js";
import {
  transformerFixture,
  transformerRequest,
} from "./transformer-control-fixture.js";

let core: ElectricalIr;
let cases: Awaited<ReturnType<typeof errorContractCases>>;
const observed: unknown[] = [];
afterAll(() => {
  const destination = process.env.THERMITE_AUDIT_R_DIAGNOSTICS;
  if (destination)
    writeFileSync(destination, JSON.stringify(observed, null, 2) + "\n");
});
beforeAll(async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error("Cannot compile the fixed audit fixture");
  core = compiled.ir;
  cases = await errorContractCases();
});
afterEach(() => vi.restoreAllMocks());

it("the standalone page normalizer identifies its authored fields without inventing a view", () => {
  const result = normalizePaperPage({ unexpected: true });
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("Expected invalid page fields");
  expect(result.error.code).toBe("R006");
  expect(result.error.message).toContain("size, orientation and marginMm");
  expect(result.error.root).toBe("packet");
});

function device(name: string) {
  const found = core.devices.find((d) => d.designation === name);
  if (!found) throw Error(`Missing authored device ${name}`);
  return found;
}
function failure<T>(result: RenderOutcome<T>, code: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw Error(`Expected ${code}`);
  expect(result.error.code).toBe(code);
  observed.push({ code, error: result.error });
  return result.error;
}
function names(error: unknown, ...expected: string[]) {
  for (const name of expected) expect(JSON.stringify(error)).toContain(name);
}
const control = () => ({
  format: "schematic-view-request/0.1" as const,
  root: { by: "uid" as const, value: device("K1").uid },
  family: "control" as const,
});

it("R001 maps an authored UID selector to the device designation", async () => {
  const result = await renderSchematic(
    core,
    JSON.parse(JSON.stringify({ ...control(), flow: "sideways" })),
  );
  const error = failure(result, "R001");
  expect(error.details).toMatchObject({ designation: "K1" });
});

it("R002 retains the involved transformer and both stopped terminals", async () => {
  const fixture = await transformerFixture("same");
  try {
    const error = failure(
      await renderSchematic(fixture.ir, transformerRequest("left-to-right")),
      "R002",
    );
    expect(error.details).toMatchObject({
      input: { designation: "T1" },
      return: { designation: "T1" },
    });
    names({ message: error.message, details: error.details }, "T1", "X1");
  } finally {
    await fixture.dispose();
  }
});

it("R003 names the actual unsupported device instead of just its UID", async () => {
  const probe = cases.find((c) => c.code === "R003");
  if (!probe || !("view" in probe)) throw Error("Missing R003 fixture");
  const error = failure(await renderSchematic(probe.ir, probe.view), "R003");
  names({ message: error.message, details: error.details }, "TB1");
});

it.each(["function", "factory"])(
  "R004 global layout failure names its view through the public %s API",
  async (entry) => {
    const engine = elkRuntime.createElkEngine(),
      layout = engine.layout.bind(engine);
    engine.layout = async (...args) => {
      const result = await layout(...args);
      result.width = NaN;
      return result;
    };
    vi.spyOn(elkRuntime, "createElkEngine").mockReturnValue(engine);
    const result =
      entry === "factory"
        ? await createSchematicRenderer().render(core, control())
        : await renderSchematic(core, control());
    const error = failure(result, "R004");
    expect(error.details).toMatchObject({
      diagnosticContext: { views: [{ viewIndex: 0, title: "K1 / control" }] },
    });
    names({ message: error.message, details: error.details }, "K1");
  },
);

it("R005 names the actual conductor and its device endpoints", async () => {
  const ir = structuredClone(core),
    wire = ir.wires.find((w) => w.designation === "W-CTL-007");
  if (!wire) throw Error("Missing conductor");
  wire.properties = { ...wire.properties, label: "bad\u0001label" };
  const error = failure(await renderSchematic(ir, control()), "R005");
  names({ message: error.message, details: error.details }, "W-CTL-007", "K1");
});

it("R005 project title failures retain the authored view scope", async () => {
  const ir = structuredClone(core);
  ir.project.name = "bad\u0001name";
  const error = failure(await renderSchematic(ir, control()), "R005");
  expect(error.details).toMatchObject({
    diagnosticContext: { views: [{ viewIndex: 0, title: "K1 / control" }] },
  });
});

it("R006 invalid page names the authored packet view, without changing the message", async () => {
  const error = failure(
    await renderSchematicPacket(
      core,
      JSON.parse(
        JSON.stringify({
          format: "schematic-packet-request/0.1",
          page: { size: "not-paper" },
          views: [
            {
              format: "documentation-view-request/0.1",
              kind: "bom",
              title: "Parts review",
            },
          ],
        }),
      ),
    ),
    "R006",
  );
  expect(error.message).toBe(
    "Use letter, tabloid, a4 or a3; landscape or portrait; and a margin from 5 to 25 mm.",
  );
  expect(error.details).toMatchObject({
    diagnosticContext: { views: [{ viewIndex: 0, title: "Parts review" }] },
  });
});

it("R006 implicit-sheet page failures resolve UID roots to a named view", async () => {
  const error = failure(
    await renderSchematicSheets(
      core,
      control(),
      undefined,
      JSON.parse('{"size":"not-paper"}'),
    ),
    "R006",
  );
  expect(error.details).toMatchObject({
    diagnosticContext: { views: [{ viewIndex: 0, title: "K1 / control" }] },
  });
});

it("R006 empty-view requests name the project and request field without inventing a view", async () => {
  const error = failure(
    await renderSchematicPacket(core, {
      format: "schematic-packet-request/0.1",
      views: [],
    }),
    "R006",
  );
  expect(error.details).toMatchObject({
    diagnosticContext: {
      projectName: core.project.name,
      requestField: "/views",
      views: [],
    },
  });
});

it("R006 view-budget failures name the first overflowing authored view", async () => {
  const views = Array.from({ length: 41 }, (_, i) => ({
    format: "documentation-view-request/0.1",
    kind: "bom",
    title: `Bill ${i}`,
  }));
  const error = failure(
    await renderSchematicPacket(
      core,
      JSON.parse(
        JSON.stringify({ format: "schematic-packet-request/0.1", views }),
      ),
    ),
    "R006",
  );
  expect(error.details).toMatchObject({
    diagnosticContext: { views: [{ viewIndex: 40, title: "Bill 40" }] },
  });
});

it("R006 keeps the authored circuit keys and device names together", async () => {
  const probe = cases.find((c) => c.code === "R006");
  if (!probe || !("packet" in probe)) throw Error("Missing R006 fixture");
  const error = failure(
    await renderSchematicPacket(probe.ir, probe.packet),
    "R006",
  );
  names(
    { message: error.message, details: error.details },
    "PX1",
    "supply",
    "output",
    "Sensor",
  );
});
