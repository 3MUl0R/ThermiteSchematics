import { afterAll, beforeAll, expect, it } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, read, uid, write } from "./task-support.mjs";
import { findRegeneratedView } from "./artifacts.mjs";
import { check, reference } from "./tasks.mjs";
import { score } from "./score-log.mjs";
import { snapshot } from "./snapshot.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const thermite = join(repo, "thermite.mjs");
const artifact = "drawings/pt1-loop.pdf";
const report = "drawings/hookup.pdf";
const input = "drawings/loop.request.json";
const loopView = {
  format: "signal-loop-view-request/0.1",
  from: { device: "PT1", function: "signal" },
  to: { device: "AI1", function: "ch0" },
};
let root, project, loop, wrongView;

function render(project, output, view) {
  const request = {
    format: "schematic-packet-request/0.1",
    page: { size: "tabloid", orientation: "landscape" },
    views: [view],
  };
  const argv = ["packet", "--input", input, "-o", output];
  write(join(project, input), request);
  const result = cli({ project, thermite }, ...argv);
  expect(result.status, result.stderr).toBe(0);
  return { argv, exit: result.status, request: JSON.stringify(request) };
}

beforeAll(() => {
  if (process.platform === "win32") return;
  root = mkdtempSync(join(realpathSync(tmpdir()), "e2-t07-"));
  project = join(root, "fixture");
  mkdirSync(project);
  const libraries = ["field-interfaces", "industrial-pilot"].map((name) => {
    cpSync(join(repo, "libraries", name), join(project, name), {
      recursive: true,
    });
    return { name, path: name, version: "0.1.0" };
  });
  cpSync(
    join(repo, "packages/cli/fixtures/signal-loop/source.json"),
    join(project, "source.json"),
  );
  write(join(project, "system.json"), {
    format: "electrical-system/0.1",
    project: { name: "Synthetic T07 fixture" },
    sources: ["source.json"],
    libraries,
  });
  const result = cli({ project, thermite }, "lock", ".");
  expect(result.status, result.stderr).toBe(0);
  wrongView = render(project, report, {
    format: "documentation-view-request/0.1",
    kind: "terminals",
  });
  loop = render(project, artifact, loopView);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function delivery(name, calls) {
  const parent = join(root, name);
  const ctx = {
    project: join(parent, "project"),
    evidence: join(parent, "evidence"),
    thermite,
    calls,
  };
  mkdirSync(ctx.evidence, { recursive: true });
  cpSync(project, ctx.project, { recursive: true });
  return ctx;
}

it("accepts a regenerated loop under its delivered name alongside a wrong view", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("correct", [wrongView, loop]);
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: true });
  expect(result.pass).toBe(true);
  expect(result.hookupPdf).toBe(artifact);
  expect(
    readFileSync(join(ctx.evidence, "regenerated-pt1-loop.pdf")).equals(
      readFileSync(join(ctx.project, artifact)),
    ),
  ).toBe(true);
});

it("rejects a byte-reproducible PDF of the wrong view", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("wrong-view", [wrongView]);
  rmSync(join(ctx.project, artifact));
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
});

it("rejects a stale hookup PDF following a visible project change", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("stale", [loop]);
  rmSync(join(ctx.project, report));
  const systemPath = join(ctx.project, "system.json");
  const system = read(systemPath);
  system.project.name = "After the issued PDF";
  write(systemPath, system);
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
  expect(
    readFileSync(join(ctx.evidence, "regenerated-pt1-loop.pdf")).equals(
      readFileSync(join(ctx.project, artifact)),
    ),
  ).toBe(false);
});

it("rejects a hookup PDF with no reproducible command", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("no-command", []);
  rmSync(join(ctx.project, report));
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
});

it("rejects a recorded print with no delivered PDF", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("missing", [loop]);
  rmSync(join(ctx.project, artifact));
  rmSync(join(ctx.project, report));
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
});

it.each([
  { name: "issue and hookup", hasHookup: true, applicability: "required" },
  { name: "issue only", hasHookup: false, applicability: "draft-only" },
])(
  "scores views guidance for a delivered $name",
  async ({ name, hasHookup, applicability }) => {
    if (process.platform === "win32") return;
    const ctx = delivery(name, []);
    rmSync(join(ctx.project, artifact));
    rmSync(join(ctx.project, report));
    write(
      join(ctx.project, "issue.md"),
      "Please review the proposed transmitter hookup and confirm the selected devices, connector pin assignments and available loop power before installation.",
    );

    const hookup = "drawings/transmitter-wiring.pdf";
    if (hasHookup) {
      ctx.calls.push(
        render(ctx.project, hookup, {
          format: "wiring-view-request/0.1",
          title: "Transmitter hookup wiring",
          conductors: ["CB1/A", "CB1/B", "W1", "W2", "W3", "W4"],
        }),
      );
    }

    const taskOutcome = await check("T07", ctx);
    const task = read(join(repo, "evals/agent/tasks/T07/task.json"));
    const { retrieval } = score({
      calls: ctx.calls,
      final: snapshot(ctx.project),
      requiredTopics: task.requiredTopics,
      taskOutcome,
    });
    expect(taskOutcome.pass).toBe(true);
    expect(taskOutcome.hookupPdf).toBe(hasHookup ? hookup : undefined);
    expect(retrieval.find(({ topic }) => topic === "views")).toMatchObject({
      applicability,
      retrieved: false,
    });
  },
);

function starterWithFieldInterfaces(name) {
  const parent = join(root, name);
  const proj = join(parent, "project");
  const evidence = join(parent, "evidence");
  mkdirSync(evidence, { recursive: true });
  const init = cli({ project: root, thermite }, "init", proj);
  expect(init.status, init.stderr).toBe(0);
  cpSync(
    join(repo, "libraries/field-interfaces"),
    join(proj, "libraries/field-interfaces"),
    { recursive: true },
  );
  const manifestPath = join(proj, "system.json");
  const manifest = read(manifestPath);
  manifest.libraries.push({
    name: "field-interfaces",
    path: "libraries/field-interfaces",
    version: "0.1.0",
  });
  write(manifestPath, manifest);
  const lock = cli({ project: proj, thermite }, "lock", ".");
  expect(lock.status, lock.stderr).toBe(0);
  return { project: proj, evidence, thermite, calls: [] };
}

function renderPacket(project, output, views, extra = {}) {
  const request = {
    format: "schematic-packet-request/0.1",
    page: { size: "tabloid", orientation: "landscape" },
    views,
    ...extra,
  };
  const argv = ["packet", "--input", input, "-o", output];
  write(join(project, input), request);
  const result = cli({ project, thermite }, ...argv);
  expect(result.status, result.stderr).toBe(0);
  return {
    argv,
    exit: result.status,
    phase: "agent",
    request: JSON.stringify(request),
    after: snapshot(project, { documents: false }),
  };
}

function renderBundle(
  project,
  views,
  outputs = { json: "hookup.json", pdf: "hookup.pdf" },
  extra = {},
) {
  const request = {
    format: "schematic-packet-request/0.1",
    page: { size: "tabloid", orientation: "landscape" },
    views,
    ...extra,
  };
  write(join(project, input), request);
  const deliveryPath = "drawings/delivery.request.json";
  const delivery = {
    format: "export-delivery-request/1",
    jobs: [{ kind: "packet", input, outputs }],
  };
  write(join(project, deliveryPath), delivery);
  const argv = [
    "export",
    "bundle",
    "--project",
    ".",
    "--input",
    deliveryPath,
    "--out-dir",
    "drawings",
  ];
  const result = cli({ project, thermite }, ...argv);
  expect(result.status, result.stderr).toBe(0);
  return {
    argv,
    exit: result.status,
    phase: "agent",
    request: JSON.stringify(delivery),
    after: snapshot(project, { documents: false }),
  };
}

const fieldTxType = "field-interfaces:pressure-4-20ma-m12-p1-p2";
const corePlcAiType = "core:plc-8di-8do-2ai";
const siemensAiType = "industrial-pilot:siemens-ai4i-st-2wire";

const makeDevice = (designation, type) => ({
  kind: "device",
  uid: uid("t07-dev-" + designation),
  designation,
  type,
});

const makeWire = (designation, a, at, b, bt, kind = "wire") => ({
  kind,
  uid: uid("t07-wire-" + designation),
  designation,
  endpoints: [
    { device: a, terminal: at },
    { device: b, terminal: bt },
  ],
});

const fnSel = (device, key) => ({
  device: { by: "designation", value: device },
  key,
});

function seriesObjects(
  txType = fieldTxType,
  txP = "1",
  txN = "2",
  aiType = corePlcAiType,
  aiP = "AI1+",
  aiN = "AI1-",
) {
  return [
    makeDevice("FIELD-X", txType),
    makeDevice("CONTROL-Y", aiType),
    makeDevice("LOOP-PS", "core:psu-24vdc"),
    makeWire("LOOP-1", "LOOP-PS", "+", "FIELD-X", txP),
    makeWire("LOOP-2", "FIELD-X", txN, "CONTROL-Y", aiP),
    makeWire("LOOP-3", "CONTROL-Y", aiN, "LOOP-PS", "-"),
    makeWire("PLC-FEED", "LOOP-PS", "+", "CONTROL-Y", "L+"),
    makeWire("PLC-RETURN", "LOOP-PS", "-", "CONTROL-Y", "M"),
  ];
}

function customProject(name, objects, extraFiTypes = []) {
  const parent = join(root, name);
  const proj = join(parent, "project");
  const evidence = join(parent, "evidence");
  mkdirSync(evidence, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const libs = [
    ["field-interfaces", "libraries/field-interfaces", "0.1.0"],
    ["industrial-pilot", "libraries/industrial-pilot", "0.1.0"],
    ["core", "packages/core-library/versions/0.2.0", "0.2.0"],
  ];
  for (const [id, rel] of libs)
    cpSync(join(repo, rel), join(proj, "libraries", id), { recursive: true });
  if (extraFiTypes.length) {
    const typesPath = join(proj, "libraries/field-interfaces/types.json");
    const doc = read(typesPath);
    doc.types.push(...extraFiTypes);
    write(typesPath, doc);
  }
  write(join(proj, "system.json"), {
    format: "electrical-system/0.1",
    project: { name: `Synthetic T07 variant: ${name}` },
    sources: ["source.json"],
    libraries: libs.map(([id, , version]) => ({
      name: id,
      path: `libraries/${id}`,
      version,
    })),
  });
  write(join(proj, "source.json"), { objects });
  const lock = cli({ project: proj, thermite }, "lock", ".");
  expect(lock.status, lock.stderr).toBe(0);
  return { project: proj, evidence, thermite, calls: [] };
}

it.each([
  {
    name: "starter-unrelated-wiring",
    output: "drawings/starter-wiring.pdf",
    view: {
      format: "wiring-view-request/0.1",
      title: "Starter control power wiring",
      conductors: ["W-CTL-001", "W-CTL-002"],
    },
  },
  {
    name: "starter-unrelated-circuit",
    output: "drawings/starter-circuit.pdf",
    view: {
      format: "circuit-view-request/0.1",
      title: "Starter control power circuit",
      groups: [
        {
          id: "ctl-pwr",
          label: "24 VDC supply to PLC",
          functions: [
            { device: { by: "designation", value: "PS1" }, key: "dc_output" },
            { device: { by: "designation", value: "PLC1" }, key: "supply" },
          ],
          conductors: ["W-CTL-001", "W-CTL-002"],
        },
      ],
    },
  },
])(
  "rejects an unrelated reproducible $name PDF even when field-interfaces is locked",
  async ({ name, output, view }) => {
    if (process.platform === "win32") return;
    const ctx = starterWithFieldInterfaces(name);
    ctx.calls.push(render(ctx.project, output, view));
    const result = await check("T07", ctx);
    expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
    expect(result.pass).toBe(false);
    expect(result.hookupPdf).toBeUndefined();
    // Failing-first proof: the legacy kind-only check without requiredLibrary
    // falsely accepted these unrelated starter drawings.
    expect(
      await findRegeneratedView(ctx, {
        allowedKinds: ["signal-loop", "wiring", "circuit"],
      }),
    ).toBe(output);
  },
);

it("accepts multi-sheet wiring and circuit splits, external-powered Siemens terminals, and circuit boundary terminals with supply selected", async () => {
  if (process.platform === "win32") return;
  // Multi-sheet wiring split (review1 split-wiring-packet)
  const splitWiring = delivery("split-wiring-packet", []);
  rmSync(join(splitWiring.project, artifact));
  rmSync(join(splitWiring.project, report));
  splitWiring.calls.push(
    renderPacket(splitWiring.project, "drawings/hookup.pdf", [
      {
        format: "wiring-view-request/0.1",
        title: "Field wiring to XT1",
        conductors: ["CB1/A", "CB1/B", "W1", "W3"],
      },
      {
        format: "wiring-view-request/0.1",
        title: "XT1 to input",
        conductors: ["W2", "W4"],
      },
    ]),
  );
  const splitWiringRes = await check("T07", splitWiring);
  expect(splitWiringRes.checks).toEqual({
    validates: true,
    issueOrHookup: true,
  });
  expect(splitWiringRes.hookupPdf).toBe("drawings/hookup.pdf");

  // Multi-sheet circuit split (review1 split-junction-circuit)
  const junctionObjects = [
    makeDevice("FIELD-X", fieldTxType),
    makeDevice("CONTROL-Y", siemensAiType),
    makeDevice("JB-X", "core:junction-box-8"),
    makeDevice("TB-Y", "core:terminal-block-8"),
    makeWire("J1", "FIELD-X", "1", "JB-X", "X1.1"),
    makeWire("J2", "FIELD-X", "2", "JB-X", "X1.2"),
    makeWire("J3", "JB-X", "X1.1", "TB-Y", "1"),
    makeWire("J4", "JB-X", "X1.2", "TB-Y", "2"),
    makeWire("J5", "TB-Y", "1", "CONTROL-Y", "12"),
    makeWire("J6", "TB-Y", "2", "CONTROL-Y", "16"),
  ];
  const splitCircuit = customProject("split-junction-circuit", junctionObjects);
  splitCircuit.calls.push(
    renderPacket(splitCircuit.project, "drawings/hookup.pdf", [
      {
        format: "circuit-view-request/0.1",
        title: "Field junction",
        groups: [
          {
            id: "field",
            functions: [fnSel("JB-X", "terminal1"), fnSel("JB-X", "terminal2")],
            conductors: ["J1", "J2", "J3", "J4"],
          },
        ],
      },
      {
        format: "circuit-view-request/0.1",
        title: "Cabinet input",
        groups: [
          {
            id: "cabinet",
            functions: [
              fnSel("TB-Y", "terminal1"),
              fnSel("TB-Y", "terminal2"),
              fnSel("CONTROL-Y", "ch3"),
            ],
            conductors: ["J5", "J6"],
          },
        ],
      },
    ]),
  );
  const splitCircuitRes = await check("T07", splitCircuit);
  expect(splitCircuitRes.checks).toEqual({
    validates: true,
    issueOrHookup: true,
  });
  expect(splitCircuitRes.hookupPdf).toBe("drawings/hookup.pdf");

  // Siemens external-powered current-input terminals 1 and 5 (review1 external-powered-ai-module)
  const extPowered = customProject(
    "external-powered-ai-module",
    seriesObjects(fieldTxType, "1", "2", siemensAiType, "1", "5"),
  );
  extPowered.calls.push(
    renderPacket(extPowered.project, "drawings/hookup.pdf", [
      {
        format: "wiring-view-request/0.1",
        title: "External-powered loop hookup",
        conductors: ["LOOP-1", "LOOP-2", "LOOP-3"],
      },
    ]),
  );
  const extPoweredRes = await check("T07", extPowered);
  expect(extPoweredRes.checks).toEqual({
    validates: true,
    issueOrHookup: true,
  });
  expect(extPoweredRes.hookupPdf).toBe("drawings/hookup.pdf");

  // Circuit boundary AI terminals while PLC supply function is selected
  // (review1 circuit-ai-boundary-supply-selected)
  const boundarySupply = customProject(
    "circuit-ai-boundary-supply-selected",
    seriesObjects(),
  );
  boundarySupply.calls.push(
    renderPacket(boundarySupply.project, "drawings/hookup.pdf", [
      {
        format: "circuit-view-request/0.1",
        title: "Loop with supply selected",
        groups: [
          {
            id: "loop",
            functions: [
              fnSel("LOOP-PS", "dc_output"),
              fnSel("CONTROL-Y", "supply"),
            ],
            conductors: [
              "LOOP-1",
              "LOOP-2",
              "LOOP-3",
              "PLC-FEED",
              "PLC-RETURN",
            ],
          },
        ],
      },
    ]),
  );
  const boundarySupplyRes = await check("T07", boundarySupply);
  expect(boundarySupplyRes.checks).toEqual({
    validates: true,
    issueOrHookup: true,
  });
  expect(boundarySupplyRes.hookupPdf).toBe("drawings/hookup.pdf");
}, 60000);

it("accepts a bundle-delivered hookup PDF and rejects a stale bundled hookup", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("bundle-signal", []);
  rmSync(join(ctx.project, artifact));
  rmSync(join(ctx.project, report));
  ctx.calls.push(
    renderBundle(ctx.project, [loopView], {
      json: "hookup.json",
      pdf: "hookup.pdf",
    }),
  );
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: true });
  expect(result.pass).toBe(true);
  expect(result.hookupPdf).toBe("drawings/hookup.pdf");

  // PDF-only bundle output (without json sibling) also passes via metadata regeneration.
  const pdfOnly = delivery("bundle-pdf-only", []);
  rmSync(join(pdfOnly.project, artifact));
  rmSync(join(pdfOnly.project, report));
  pdfOnly.calls.push(
    renderBundle(pdfOnly.project, [loopView], { pdf: "hookup-only.pdf" }),
  );
  const pdfOnlyRes = await check("T07", pdfOnly);
  expect(pdfOnlyRes.checks).toEqual({ validates: true, issueOrHookup: true });
  expect(pdfOnlyRes.hookupPdf).toBe("drawings/hookup-only.pdf");

  // Editing the project after bundle export makes the bundled hookup stale.
  const systemPath = join(ctx.project, "system.json");
  const system = read(systemPath);
  system.project.name = "After bundled hookup";
  write(systemPath, system);
  const staleEvidence = join(root, "bundle-stale-evidence");
  mkdirSync(staleEvidence, { recursive: true });
  const stale = await check("T07", {
    ...ctx,
    clean: undefined,
    evidence: staleEvidence,
  });
  expect(stale.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(stale.pass).toBe(false);
  expect(stale.hookupPdf).toBeUndefined();
}, 30000);

it("rejects drawings without any field-interfaces device even when field-interfaces is locked", async () => {
  if (process.platform === "win32") return;
  // Core two-wire transmitter wired to core PLC AI (no field-interfaces device instance)
  const coreOnly = customProject(
    "no-field-interfaces-core-loop",
    seriesObjects("core:transmitter-2wire-4-20ma", "+", "-"),
  );
  coreOnly.calls.push(
    renderPacket(coreOnly.project, "drawings/core-loop.pdf", [
      {
        format: "wiring-view-request/0.1",
        title: "Core transmitter wiring",
        conductors: ["LOOP-1", "LOOP-2", "LOOP-3"],
      },
    ]),
  );
  const coreOnlyRes = await check("T07", coreOnly);
  expect(coreOnlyRes.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(coreOnlyRes.pass).toBe(false);
  expect(coreOnlyRes.hookupPdf).toBeUndefined();
});

it("rejects a field-interfaces device present only on schedule/index sheets or on a sheet with no represented conductor", async () => {
  if (process.platform === "win32") return;
  // 1. Schedule + index packet only (PT1 appears on terminals/index, no eligible drawing sheet)
  const schedOnly = delivery("schedule-index-only", []);
  rmSync(join(schedOnly.project, artifact));
  rmSync(join(schedOnly.project, report));
  schedOnly.calls.push(
    renderPacket(
      schedOnly.project,
      "drawings/schedules-index.pdf",
      [
        { format: "documentation-view-request/0.1", kind: "terminals" },
        { format: "documentation-view-request/0.1", kind: "io" },
      ],
      { index: true },
    ),
  );
  const schedOnlyRes = await check("T07", schedOnly);
  expect(schedOnlyRes.checks).toEqual({
    validates: true,
    issueOrHookup: false,
  });
  expect(schedOnlyRes.pass).toBe(false);

  // 2. Unrelated starter wiring sheet where FIELD-X only appears on auto-generated schedule sheets
  // (review1 negative-starter-power)
  const starterPower = customProject("negative-starter-power", seriesObjects());
  starterPower.calls.push(
    renderPacket(starterPower.project, "drawings/starter-power.pdf", [
      {
        format: "wiring-view-request/0.1",
        title: "PLC power feed only",
        conductors: ["PLC-FEED", "PLC-RETURN"],
      },
    ]),
  );
  const starterPowerRes = await check("T07", starterPower);
  expect(starterPowerRes.checks).toEqual({
    validates: true,
    issueOrHookup: false,
  });
  expect(starterPowerRes.pass).toBe(false);

  // 3. Field-interfaces device on a circuit sheet with zero represented conductors.
  // Use a circuit-supported symbol profile in a locked local field-interfaces
  // library so the circuit PDF renders legitimately with no conductors.
  const circuitDeviceType = {
    kind: "device_type",
    id: "field-interfaces:synthetic-indicator",
    description: "Synthetic circuit-supported field-interfaces device for test",
    symbol: "thermite:lamp",
    terminals: {
      1: { connection_policy: "exclusive" },
      2: { connection_policy: "exclusive" },
    },
    functions: {
      lamp: { kind: "load", terminals: ["1", "2"] },
    },
  };
  const noConductors = customProject(
    "circuit-no-conductors",
    [makeDevice("FI1", circuitDeviceType.id)],
    [circuitDeviceType],
  );
  noConductors.calls.push(
    renderPacket(noConductors.project, "drawings/unwired-fi.pdf", [
      {
        format: "circuit-view-request/0.1",
        title: "Unwired field-interfaces device",
        groups: [
          {
            id: "empty",
            functions: [fnSel("FI1", "lamp")],
            conductors: [],
          },
        ],
      },
    ]),
  );
  const noConductorsRes = await check("T07", noConductors);
  expect(noConductorsRes.checks).toEqual({
    validates: true,
    issueOrHookup: false,
  });
  expect(noConductorsRes.pass).toBe(false);

  // 4. Unwired field-interfaces device placed on a circuit sheet that only draws starter conductors
  const unwiredOnStarter = customProject(
    "circuit-unwired-with-starter",
    [
      makeDevice("FI1", circuitDeviceType.id),
      makeDevice("LOOP-PS", "core:psu-24vdc"),
      makeDevice("CONTROL-Y", corePlcAiType),
      makeWire("PLC-FEED", "LOOP-PS", "+", "CONTROL-Y", "L+"),
      makeWire("PLC-RETURN", "LOOP-PS", "-", "CONTROL-Y", "M"),
    ],
    [circuitDeviceType],
  );
  unwiredOnStarter.calls.push(
    renderPacket(unwiredOnStarter.project, "drawings/unwired-on-starter.pdf", [
      {
        format: "circuit-view-request/0.1",
        title: "Starter power with unrelated unwired field-interfaces device",
        groups: [
          {
            id: "pwr",
            functions: [
              fnSel("LOOP-PS", "dc_output"),
              fnSel("CONTROL-Y", "supply"),
              fnSel("FI1", "lamp"),
            ],
            conductors: ["PLC-FEED", "PLC-RETURN"],
          },
        ],
      },
    ]),
  );
  const unwiredOnStarterRes = await check("T07", unwiredOnStarter);
  expect(unwiredOnStarterRes.checks).toEqual({
    validates: true,
    issueOrHookup: false,
  });
  expect(unwiredOnStarterRes.pass).toBe(false);
}, 60000);

it("accepts the T07 reference issue-draft path without a hookup drawing", async () => {
  if (process.platform === "win32") return;
  const parent = join(root, "reference-issue-draft");
  const proj = join(parent, "project");
  const evidence = join(parent, "evidence");
  mkdirSync(evidence, { recursive: true });
  const init = cli({ project: root, thermite }, "init", proj);
  expect(init.status, init.stderr).toBe(0);
  const ctx = { project: proj, evidence, thermite, calls: [] };
  reference("T07", ctx);
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: true });
  expect(result.pass).toBe(true);
  expect(result.hookupPdf).toBeUndefined();
});

it("accepts a field-interfaces transmitter wired to a digital input (analog-input correctness delegated to the T07 judge rubric)", async () => {
  if (process.platform === "win32") return;
  // Automated T07 credit verifies a locked field-interfaces device drawn with a
  // represented conductor; judging whether the loop actually lands on an analog
  // input rather than a digital input or supply only is delegated to the rubric
  // (evals/agent/tasks/T07/task.json).
  const diObjects = seriesObjects(
    fieldTxType,
    "1",
    "2",
    corePlcAiType,
    "DI0",
    "AI1-",
  ).filter((o) => o.designation !== "LOOP-3");
  const ctx = customProject("tx-to-di-delegated", diObjects);
  const pdfPath = "drawings/tx-to-di.pdf";
  ctx.calls.push(
    renderPacket(ctx.project, pdfPath, [
      {
        format: "wiring-view-request/0.1",
        title: "Transmitter wired to DI0",
        conductors: ["LOOP-1", "LOOP-2"],
      },
    ]),
  );
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: true });
  expect(result.pass).toBe(true);
  expect(result.hookupPdf).toBe(pdfPath);
  const task = read(join(repo, "evals/agent/tasks/T07/task.json"));
  expect(task.version).toBe("1.3.2");
  expect(
    task.rubric.some((line) =>
      /not a digital input or supply only/i.test(line),
    ),
  ).toBe(true);
});
