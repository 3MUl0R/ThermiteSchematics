import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { regeneratePacket, regenerateView } from "./artifacts.mjs";
import { checkDogfood, prepareDogfoodProject } from "./dogfood.mjs";
import { diff, sha256, snapshot } from "./snapshot.mjs";
import { check } from "./tasks.mjs";
import { ok, read, replaceObject, write } from "./task-support.mjs";

const supported = process.platform !== "win32";
const thermite = resolve("thermite.mjs");
const packetRequestPath = "drawings/packet.request.json";
const deliveryRequestPath = "drawings/delivery.request.json";

const t05PacketRequest = {
  format: "schematic-packet-request/0.1",
  index: true,
  views: [
    {
      format: "documentation-view-request/0.1",
      kind: "terminals",
      device: "TB1",
    },
    { format: "documentation-view-request/0.1", kind: "io" },
    {
      format: "schematic-view-request/0.2",
      root: { by: "designation", value: "CBL1" },
      intent: { kind: "conductors" },
    },
  ],
};

const t05DeliveryRequest = {
  format: "export-delivery-request/1",
  jobs: [
    {
      kind: "packet",
      input: packetRequestPath,
      index: true,
      page: { size: "letter", orientation: "landscape" },
      strict: false,
      outputs: { json: "packet.json", html: "packet.html", pdf: "packet.pdf" },
    },
  ],
};

const bundleArgs = [
  "export",
  "bundle",
  "--project",
  ".",
  "--input",
  deliveryRequestPath,
  "--out-dir",
  "drawings",
];

let root, prepared, ctx;

function bundleCall(context, input = deliveryRequestPath) {
  const argv = [
    "export",
    "bundle",
    "--project",
    ".",
    "--input",
    input,
    "--out-dir",
    "drawings",
  ];
  const after = snapshot(context.project, { documents: false });
  return {
    phase: "agent",
    exit: 0,
    argv,
    request: existsSync(join(context.project, input))
      ? readFileSync(join(context.project, input), "utf8")
      : undefined,
    after,
  };
}

function packetCall(context, input, ext, extra = []) {
  const artifact = `drawings/packet.${ext}`;
  const argv = ["packet", "--input", input, ...extra, "-o", artifact];
  ok(context, ...argv);
  const file = join(context.project, artifact);
  return {
    phase: "agent",
    exit: 0,
    argv,
    request: existsSync(join(context.project, input))
      ? readFileSync(join(context.project, input), "utf8")
      : undefined,
    after: { files: { [artifact]: sha256(readFileSync(file)) } },
  };
}

beforeAll(() => {
  if (!supported) return;
  root = mkdtempSync(join(realpathSync(tmpdir()), "packet-bundle-"));
  prepared = join(root, "prepared");
  ok({ project: root, thermite }, "init", prepared, "--template", "cabinets");
  mkdirSync(join(prepared, "drawings"), { recursive: true });
  write(join(prepared, packetRequestPath), t05PacketRequest);
  write(join(prepared, deliveryRequestPath), t05DeliveryRequest);
  ok({ project: prepared, thermite }, ...bundleArgs);
});

beforeEach(() => {
  if (!supported) return;
  const work = mkdtempSync(join(root, "case-"));
  ctx = {
    work,
    thermite,
    project: join(work, "project"),
    evidence: join(work, "evidence"),
    validationDiagnostics: [],
  };
  cpSync(prepared, ctx.project, { recursive: true });
  mkdirSync(ctx.evidence, { recursive: true });
  ctx.calls = [bundleCall(ctx)];
});

afterEach(() => {
  if (supported && ctx) rmSync(ctx.work, { recursive: true, force: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function freshEvidence(name, extra = {}) {
  const evidence = join(ctx.work, name);
  mkdirSync(evidence, { recursive: true });
  return { ...ctx, clean: undefined, evidence, ...extra };
}

it("passes T05 on the export-bundle route and enforces byte equality", async () => {
  if (!supported) return;
  const result = await check("T05", ctx);
  expect(result.pass, JSON.stringify(result)).toBe(true);
  expect(result.checks).toMatchObject({
    validates: true,
    artifacts: true,
    pdf: true,
    sheets: true,
    terminals: true,
    io: true,
    cable: true,
    index: true,
  });
  expect(result.packetFailure).toBeUndefined();

  const direct = await regeneratePacket(freshEvidence("ev-direct"));
  expect(direct.pass).toBe(true);
  expect(direct.route).toBe("bundle");
  expect(direct.request).toBe(packetRequestPath);

  // Reformatting packet.json keeps semantics identical but breaks byte equality.
  const delivered = join(ctx.project, "drawings/packet.json");
  writeFileSync(delivered, JSON.stringify(read(delivered)));
  const minified = await check("T05", freshEvidence("ev-minified"));
  expect(minified.pass).toBe(false);
  expect(minified.checks.artifacts).toBe(false);
}, 60000);

it("passes T05 on a mixed bundle + standalone route with overridden print options", async () => {
  if (!supported) return;
  ctx.calls.push(
    packetCall(ctx, packetRequestPath, "pdf", [
      "--index",
      "--paper",
      "letter",
      "--orientation",
      "landscape",
      "--margin",
      "12",
    ]),
  );
  const result = await check("T05", ctx);
  expect(result.pass, JSON.stringify(result)).toBe(true);
  expect(result.checks.artifacts).toBe(true);

  const direct = await regeneratePacket(freshEvidence("ev-mixed"));
  expect(direct.pass).toBe(true);
  expect(direct.route).toBe("mixed");
  expect(direct.request).toBe(packetRequestPath);
}, 60000);

it("fails T05 when the saved packet request is stale after export bundle", async () => {
  if (!supported) return;
  write(join(ctx.project, packetRequestPath), {
    ...t05PacketRequest,
    views: t05PacketRequest.views.slice(0, 2),
  });
  const result = await check("T05", ctx);
  expect(result.pass).toBe(false);
  expect(result.checks.artifacts).toBe(false);
  expect(result.packetFailure).toBeDefined();
}, 60000);

it("fails T05 when mixed or bundle outputs come from a foreign request", async () => {
  if (!supported) return;
  const foreignPath = "drawings/other.request.json";
  write(join(ctx.project, foreignPath), {
    ...t05PacketRequest,
    views: t05PacketRequest.views.slice(0, 2),
  });
  ctx.calls.push(packetCall(ctx, foreignPath, "pdf", ["--index"]));
  const mixed = await check("T05", ctx);
  expect(mixed.pass).toBe(false);
  expect(mixed.checks.artifacts).toBe(false);
  expect(mixed.packetFailure?.code).toBe("mismatched-request");
  expect(mixed.packetFailure?.searched.paths).toEqual(
    expect.arrayContaining([packetRequestPath, foreignPath]),
  );

  // Split bundle jobs referencing two different packet requests also fail.
  const splitDelivery = {
    format: "export-delivery-request/1",
    jobs: [
      {
        kind: "packet",
        input: packetRequestPath,
        index: true,
        outputs: { json: "packet.json" },
      },
      {
        kind: "packet",
        input: foreignPath,
        index: true,
        outputs: { html: "packet.html", pdf: "packet.pdf" },
      },
    ],
  };
  write(join(ctx.project, deliveryRequestPath), splitDelivery);
  ok(ctx, ...bundleArgs);
  ctx.calls = [bundleCall(ctx)];
  const split = await check("T05", freshEvidence("ev-split"));
  expect(split.pass).toBe(false);
  expect(split.checks.artifacts).toBe(false);
  expect(split.packetFailure?.code).toBe("mismatched-request");
}, 60000);

it("fails closed with searched invocations and paths when no request is audited", async () => {
  if (!supported) return;
  // Even if a fallback file exists on disk, the checker must never guess.
  write(join(ctx.project, "requests/packet.json"), t05PacketRequest);
  ctx.calls = [
    {
      phase: "agent",
      exit: 1,
      argv: [
        "export",
        "bundle",
        "--input",
        "missing.json",
        "--out-dir",
        "drawings",
      ],
    },
  ];
  const result = await check("T05", ctx);
  expect(result.pass).toBe(false);
  expect(result.checks.artifacts).toBe(false);
  expect(result.packetFailure?.code).toBe("missing-request");
  expect(result.packetFailure?.searched.invocations).toEqual(
    expect.arrayContaining([
      "export bundle --out-dir drawings",
      "packet -o drawings/packet.json",
      "exit=1 export bundle --input missing.json --out-dir drawings",
    ]),
  );
  expect(result.packetFailure?.searched.paths).toEqual(
    expect.arrayContaining([
      "drawings/packet.json",
      "drawings/packet.pdf",
      "drawings/packet.html",
    ]),
  );
  expect(result.packetFailure?.message).toContain(
    "export bundle --out-dir drawings",
  );
}, 30000);

it("rejects bundle and standalone requests outside the project root", async () => {
  if (!supported) return;
  const outsideDelivery = join(ctx.work, "outside-delivery.json");
  write(outsideDelivery, t05DeliveryRequest);
  ctx.calls = [
    {
      phase: "agent",
      exit: 0,
      argv: [
        "export",
        "bundle",
        "--project",
        ".",
        "--input",
        outsideDelivery,
        "--out-dir",
        "drawings",
      ],
    },
  ];
  const bundleOutside = await check("T05", ctx);
  expect(bundleOutside.pass).toBe(false);
  expect(bundleOutside.checks.artifacts).toBe(false);
  expect(bundleOutside.packetFailure?.code).toBe("outside-project-request");
  expect(bundleOutside.packetFailure?.searched.paths).toContain(
    outsideDelivery,
  );

  const outsidePacket = join(ctx.work, "outside-packet.json");
  write(outsidePacket, t05PacketRequest);
  write(join(ctx.project, deliveryRequestPath), {
    ...t05DeliveryRequest,
    jobs: [{ ...t05DeliveryRequest.jobs[0], input: "../outside-packet.json" }],
  });
  ctx.calls = [bundleCall(ctx)];
  const jobOutside = await check("T05", freshEvidence("ev-job-outside"));
  expect(jobOutside.pass).toBe(false);
  expect(jobOutside.checks.artifacts).toBe(false);
  expect(jobOutside.packetFailure?.code).toBe("outside-project-request");

  ctx.calls = ["json", "html", "pdf"].map((ext) => ({
    phase: "agent",
    exit: 0,
    argv: [
      "packet",
      "--project",
      ".",
      "--input",
      outsidePacket,
      "-o",
      `drawings/packet.${ext}`,
    ],
  }));
  const standaloneOutside = await check(
    "T05",
    freshEvidence("ev-standalone-outside"),
  );
  expect(standaloneOutside.pass).toBe(false);
  expect(standaloneOutside.packetFailure?.code).toBe("outside-project-request");

  // View regeneration with an outside-project packet input (Claude T02 shape) stays rejected.
  const viewOutside = await regenerateView(
    freshEvidence("ev-view-outside", {
      calls: [
        {
          phase: "agent",
          exit: 0,
          argv: [
            "packet",
            "--project",
            ".",
            "--input",
            outsidePacket,
            "-o",
            "drawings/k1-control.pdf",
          ],
        },
      ],
    }),
    "drawings/k1-control.pdf",
    ["view", "K1", "--actuation", "-o", "drawings/k1-control.pdf"],
  );
  expect(viewOutside.pass).toBe(false);
  expect(viewOutside.reason).toBe("missing-input-request");
}, 30000);

it("verifies D-pump through the same bundle-aware path without requiring visual capture", async () => {
  if (!supported) return;
  const task = read(new URL("./tasks/D-pump/task.json", import.meta.url));
  const work = mkdtempSync(join(root, "dpump-"));
  const project = join(work, "project");
  const evidence = join(work, "evidence");
  mkdirSync(evidence);
  try {
    ok({ project: work, thermite }, "init", project);
    const pumpCtx = { project, thermite, task, evidence };
    prepareDogfoodProject(pumpCtx);
    const before = snapshot(project);
    replaceObject(
      pumpCtx,
      "M1",
      "description",
      "5 HP pump motor. Selected-part review remains open.",
    );
    const after = snapshot(project);
    const apply = {
      argv: [
        "agent",
        "apply-source-patch",
        "--input",
        "requests/reference.json",
      ],
      phase: "agent",
      exit: 0,
      before,
      after,
      request: readFileSync(join(project, "requests/reference.json"), "utf8"),
      editsByThisCall: diff(before, after),
    };
    const pumpPlan = {
      format: "export-delivery-request/1",
      jobs: [
        {
          kind: "packet",
          input: "packet.request.json",
          index: true,
          outputs: {
            json: "packet.json",
            html: "packet.html",
            pdf: "packet.pdf",
          },
        },
        {
          kind: "view",
          designation: "M1",
          intent: "power",
          flow: "top-to-bottom",
          page: { size: "tabloid", orientation: "portrait", marginMm: 10 },
          outputs: { pdf: "motor-power.pdf" },
        },
        {
          kind: "view",
          designation: "K1",
          intent: "actuation",
          outputs: { pdf: "contactor-actuation.pdf" },
        },
        ...task.deliverables.reports.map((report) => ({
          kind: "report",
          report,
          outputs: { csv: `${report}.csv` },
        })),
        { kind: "diagnostics", outputs: { json: "diagnostics.json" } },
        { kind: "cable", designation: "CBL1", outputs: { json: "cable.json" } },
        {
          kind: "review",
          before: "drawings/before.json",
          outputs: { json: "review.json" },
        },
      ],
    };
    write(join(project, "delivery.request.json"), pumpPlan);
    const args = [
      "export",
      "bundle",
      "--project",
      ".",
      "--input",
      "delivery.request.json",
      "--out-dir",
      "drawings",
    ];
    ok(pumpCtx, ...args);
    pumpCtx.validationDiagnostics = JSON.parse(
      ok(pumpCtx, "validate", ".", "--json"),
    );
    pumpCtx.calls = [apply, bundleCall(pumpCtx, "delivery.request.json")];
    const outcome = await checkDogfood(pumpCtx);
    expect(outcome.pass, JSON.stringify(outcome.checks)).toBe(true);
    expect(outcome.exports).toMatchObject({
      route: "bundle",
      status: "current",
    });
    expect(outcome.capture).toBeUndefined();
    expect(outcome.captureCurrent).toBeUndefined();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120000);
