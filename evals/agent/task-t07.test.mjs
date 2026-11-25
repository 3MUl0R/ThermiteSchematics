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
import { cli, read, write } from "./task-support.mjs";
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
  },
);

it("rejects a wiring view that omits the transmitter device", async () => {
  if (process.platform === "win32") return;
  const ctx = delivery("wiring-no-tx", []);
  rmSync(join(ctx.project, artifact));
  rmSync(join(ctx.project, report));
  ctx.calls.push(
    render(ctx.project, "drawings/cabinet-only.pdf", {
      format: "wiring-view-request/0.1",
      title: "Cabinet wiring without transmitter",
      conductors: ["W1", "W2", "W3", "W4"],
    }),
  );
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
  expect(result.hookupPdf).toBeUndefined();
});

it("accepts a series-powered core transmitter-to-PLC analog-input loop with field-interfaces locked", async () => {
  if (process.platform === "win32") return;
  const ctx = starterWithFieldInterfaces("series-core-loop");
  const equipPath = join(ctx.project, "devices/equipment.json");
  const equip = read(equipPath);
  equip.objects.find((o) => o.designation === "PLC1").type =
    "core:plc-8di-8do-2ai";
  equip.objects.push({
    uid: "9b2a1c4d-5e6f-4789-a012-3456789abcde",
    kind: "device",
    designation: "TX1",
    type: "core:transmitter-2wire-4-20ma",
    location: "FIELD",
  });
  write(equipPath, equip);
  const wiresPath = join(ctx.project, "connections/control-power.json");
  const wires = read(wiresPath);
  wires.objects.push(
    {
      uid: "1b2a1c4d-5e6f-4789-a012-3456789abc01",
      kind: "wire",
      designation: "W-LOOP-1",
      endpoints: [
        { device: "PS1", terminal: "+" },
        { device: "TX1", terminal: "+" },
      ],
    },
    {
      uid: "1b2a1c4d-5e6f-4789-a012-3456789abc02",
      kind: "wire",
      designation: "W-LOOP-2",
      endpoints: [
        { device: "TX1", terminal: "-" },
        { device: "PLC1", terminal: "AI0+" },
      ],
    },
    {
      uid: "1b2a1c4d-5e6f-4789-a012-3456789abc03",
      kind: "wire",
      designation: "W-LOOP-3",
      endpoints: [
        { device: "PLC1", terminal: "AI0-" },
        { device: "PS1", terminal: "-" },
      ],
    },
  );
  write(wiresPath, wires);
  const seriesPdf = "drawings/tx1-series-loop.pdf";
  ctx.calls.push(
    render(ctx.project, seriesPdf, {
      format: "signal-loop-view-request/0.1",
      from: { device: "TX1", function: "signal" },
      to: { device: "PLC1", function: "ai0" },
      loopPower: { device: "PS1", function: "dc_output" },
    }),
  );
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: true });
  expect(result.pass).toBe(true);
  expect(result.hookupPdf).toBe(seriesPdf);
});

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

it("rejects a wiring view where transmitter is wired to a digital input instead of analog input", async () => {
  if (process.platform === "win32") return;
  const ctx = starterWithFieldInterfaces("wrong-di-wiring");
  const equipPath = join(ctx.project, "devices/equipment.json");
  const equip = read(equipPath);
  equip.objects.find((o) => o.designation === "PLC1").type =
    "core:plc-8di-8do-2ai";
  equip.objects.push({
    uid: "8b2a1c4d-5e6f-4789-a012-3456789abcde",
    kind: "device",
    designation: "TX1",
    type: "core:transmitter-2wire-4-20ma",
    location: "FIELD",
  });
  write(equipPath, equip);
  const wiresPath = join(ctx.project, "connections/control-power.json");
  const wires = read(wiresPath);
  wires.objects.push(
    {
      uid: "2b2a1c4d-5e6f-4789-a012-3456789abc01",
      kind: "wire",
      designation: "W-BAD-1",
      endpoints: [
        { device: "PS1", terminal: "+" },
        { device: "TX1", terminal: "+" },
      ],
    },
    {
      uid: "2b2a1c4d-5e6f-4789-a012-3456789abc02",
      kind: "wire",
      designation: "W-BAD-2",
      endpoints: [
        { device: "TX1", terminal: "-" },
        { device: "PLC1", terminal: "DI0" },
      ],
    },
  );
  write(wiresPath, wires);
  const pdfPath = "drawings/tx-to-di.pdf";
  ctx.calls.push(
    render(ctx.project, pdfPath, {
      format: "wiring-view-request/0.1",
      title: "Transmitter miswired to DI0",
      conductors: ["W-BAD-1", "W-BAD-2"],
    }),
  );
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
  expect(result.hookupPdf).toBeUndefined();
  // allowedKinds-only without requiredRoles preserves the legacy kind-only short-circuit.
  expect(await findRegeneratedView(ctx, { allowedKinds: ["wiring"] })).toBe(
    pdfPath,
  );
});
