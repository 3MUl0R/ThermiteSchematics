import { basename, extname, join, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  parseExportJson,
  portablePath,
} from "../../packages/cli/dist/alpha-export-input.js";
import {
  readBundleRecord,
  readReceiptRecord,
} from "../../packages/cli/dist/alpha-export-record.js";
import { cleanChecker, deliveredBytes, pdf, replayHtml } from "./artifacts.mjs";
import { projectReader } from "./capture-files.mjs";
import { sha256 } from "./snapshot.mjs";
import { canonical } from "./source-files.mjs";
import { cli } from "./task-support.mjs";

const directory = "drawings";
const marker = "drawings/export-manifest.json";
const packetHtml = "drawings/packet.html";
const packetInput = "packet.request.json";
export const conveyorBaseline = "drawings/before.json";
const diagnostics = "drawings/diagnostics.json";
const cable = "drawings/cable.json";
const review = "drawings/review.json";

export function conveyorOutputs(spec) {
  return [
    ...spec.views.map((name) => directory + "/" + name),
    ...["json", "html", "pdf"].map((ext) => directory + "/packet." + ext),
    ...spec.reports.map((kind) => directory + "/" + kind + ".csv"),
    diagnostics,
    cable,
    review,
  ];
}

export function exportFile(ctx, path) {
  try {
    return { bytes: deliveredBytes(ctx, path) };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "tampered" };
  }
}

function readJson(bytes, path) {
  return parseExportJson(bytes, path).value;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return (
    argv.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1) ??
    (index === -1 ? undefined : argv[index + 1])
  );
}

// Use the audited invocation to locate a named delivery request. The default
// is the example in the offline guide and also supports unaudited replays.
function bundleInput(ctx) {
  const root = ctx.originalProject ?? ctx.project;
  const call = (ctx.calls ?? []).findLast(
    ({ argv, phase, exit }) =>
      phase !== "flush" &&
      exit === 0 &&
      Array.isArray(argv) &&
      argv[0] === "export" &&
      argv[1] === "bundle" &&
      argv.every((arg) => typeof arg === "string") &&
      resolve(root, option(argv, "--out-dir") ?? "") ===
        resolve(root, directory),
  );
  const manifest = exportFile(ctx, marker);
  if (!call && manifest.status === "missing") return null;
  const source = projectReader(ctx.project);
  try {
    const authored = call
      ? option(call.argv, "--input")
      : "delivery.request.json";
    if (!authored || authored === "-") return {};
    const path = relative(root, resolve(root, authored)).replaceAll("\\", "/");
    return {
      path: portablePath(source.path(path).replaceAll("\\", "/")),
      call,
    };
  } catch {
    return {};
  } finally {
    source.close();
  }
}

function drawingOptions(job) {
  return [
    ...(job.index === true ? ["--index"] : []),
    ...[
      ["--paper", job.page?.size],
      ["--orientation", job.page?.orientation],
      ["--margin", job.page?.marginMm],
      ["--layout", job.layout],
    ].flatMap(([flag, value]) =>
      value === undefined ? [] : [flag, String(value)],
    ),
  ];
}

// Artifact names and allowed recipes come from the task. The manifest is
// consulted only after the request has been mapped to these standalone CLI calls.
function planBundle(request, spec, views, cableTags) {
  if (
    request?.format !== "export-delivery-request/1" ||
    !Array.isArray(request.jobs)
  )
    return null;
  const plan = new Map();
  let extraHtml = 0;
  for (const job of request.jobs) {
    if (
      !job?.outputs ||
      typeof job.outputs !== "object" ||
      Array.isArray(job.outputs)
    )
      return null;
    for (const [format, name] of Object.entries(job.outputs)) {
      if (
        typeof name !== "string" ||
        name !== basename(name) ||
        extname(name) !== "." + format
      )
        return null;
      // The CLI freshness check subsequently enforces the full strict schema.
      const path = directory + "/" + portablePath(name);
      if (plan.has(path)) return null;
      const view =
        views.get(name) ??
        [...views.values()].find(
          ({ intent, roots }) =>
            intent === job.intent && roots.includes(job.designation),
        );
      let argv;
      switch (job.kind) {
        case "packet":
          if (
            job.input !== packetInput ||
            !["json", "html", "pdf"].includes(format) ||
            name !== "packet." + format
          )
            return null;
          argv = [
            "packet",
            "--input",
            packetInput,
            ...drawingOptions(job),
            ...(job.strict === true ? ["--strict"] : []),
          ];
          break;
        case "view":
          if (
            !view?.roots.includes(job.designation) ||
            job.intent !== view.intent ||
            (format === "pdf"
              ? !views.has(name)
              : format !== "html" || path === packetHtml)
          )
            return null;
          if (format === "html") extraHtml++;
          argv = [
            "view",
            job.designation,
            "--" + job.intent,
            ...drawingOptions(job),
            ...(job.flow === undefined ? [] : ["--flow", job.flow]),
          ];
          break;
        case "report":
          if (
            !spec.reports.includes(job.report) ||
            job.device !== undefined ||
            job.filter !== undefined ||
            (format === "csv"
              ? name !== job.report + ".csv"
              : format !== "html" || path === packetHtml)
          )
            return null;
          if (format === "html") extraHtml++;
          argv = ["report", job.report, ...drawingOptions(job)];
          break;
        case "diagnostics":
          if (
            path !== diagnostics ||
            job.device !== undefined ||
            job.location !== undefined
          )
            return null;
          argv = ["diagnostics"];
          break;
        case "cable":
          if (path !== cable || !cableTags.includes(job.designation))
            return null;
          argv = ["cable", job.designation];
          break;
        case "review":
          if (path !== review || job.before !== conveyorBaseline) return null;
          argv = ["review", "--before", conveyorBaseline];
          break;
        default:
          return null;
      }
      plan.set(path, argv);
    }
  }
  if (
    !conveyorOutputs(spec).every((path) => plan.has(path)) ||
    extraHtml < 1 ||
    extraHtml > 3
  )
    return null;
  return plan;
}

function findingStatus(code) {
  if (code.startsWith("missing_")) return "missing";
  if (["source_changed", "producer_mismatch"].includes(code)) return "stale";
  return "tampered";
}

export async function regenerateConveyorBundle(ctx, spec, views, cableTags) {
  const input = bundleInput(ctx);
  if (!input) return null;
  const artifacts = {},
    html = new Map(),
    paths = conveyorOutputs(spec);
  const result = {
    route: "bundle",
    artifacts,
    html,
    request: input.path ?? null,
  };
  let plan;
  try {
    plan = planBundle(
      readJson(deliveredBytes(ctx, input.path), input.path),
      spec,
      views,
      cableTags,
    );
  } catch {}
  if (!plan) {
    for (const path of paths)
      artifacts[path] = exportFile(ctx, path).status ?? "unverified";
    return { ...result, status: "invalid-request", packet: null, findings: [] };
  }

  const clean = cleanChecker(ctx);
  const check = cli(
    clean,
    "export",
    "check",
    "--input",
    input.path,
    "--out-dir",
    directory,
    "--json",
  );
  let findings;
  try {
    const report = JSON.parse(check.stdout);
    if (report.format !== "export-check/1")
      throw new Error("Expected export check");
    findings = report.reasons.map(({ path, code }) => ({ path, code }));
  } catch {
    findings = [{ path: "delivery", code: "unverifiable_input" }];
  }
  if (check.status !== 0 && !findings.length)
    findings.push({ path: "delivery", code: "unverifiable_input" });
  const publishedHash = input.call?.after?.files?.[marker];
  const deliveredMarker = exportFile(ctx, marker).bytes;
  if (
    publishedHash &&
    deliveredMarker &&
    sha256(deliveredMarker) !== publishedHash
  )
    findings.push({ path: "export-manifest.json", code: "marker_changed" });

  // A request edited after the audited publication is stale. A marker whose
  // request binding disagrees with the audited request has been altered.
  const changedRequest =
    (typeof input.call?.request === "string" &&
      sha256(input.call.request) !== sha256(deliveredBytes(ctx, input.path))) ||
    [packetInput, conveyorBaseline].some((path) => {
      const published = input.call?.after?.files?.[path];
      const { bytes } = exportFile(ctx, path);
      return published && bytes && sha256(bytes) !== published;
    });
  const statusOf = ({ code }) =>
    code === "request_changed" && changedRequest
      ? "stale"
      : findingStatus(code);
  const manifestFindings = findings.filter(
    ({ path }) => !plan.has(directory + "/" + path),
  );
  const markerStatus = manifestFindings.map(statusOf);
  let manifest;
  try {
    manifest = readBundleRecord(readJson(deliveredMarker, marker));
  } catch {}

  let packet = null;
  // A malformed request must never be forwarded as arguments. CLI check may
  // return an input error before producing artifact-specific findings.
  const invalid = findings.some(
    ({ path, code }) =>
      code === "unverifiable_input" &&
      path !== "export-manifest.json" &&
      !plan.has(directory + "/" + path),
  );
  for (const [path, argv] of plan) {
    const delivered = exportFile(ctx, path);
    const specific = findings
      .filter((finding) => directory + "/" + finding.path === path)
      .map(statusOf);
    let equals = false;
    if (!invalid) {
      const out = join(ctx.evidence, "checker-bundle-" + basename(path));
      const generated = cli(clean, ...argv, "-o", out);
      if (generated.status === 0) {
        const expected = readFileSync(out);
        if (path === "drawings/packet.json") packet = JSON.parse(expected);
        equals =
          !!delivered.bytes?.equals(expected) &&
          (!path.endsWith(".pdf") || (await pdf(out)));
      }
    }
    const statuses = [...specific, ...markerStatus];
    const status =
      delivered.status ??
      (specific.includes("tampered")
        ? "tampered"
        : statuses.includes("missing")
          ? "missing"
          : statuses.includes("tampered")
            ? "tampered"
            : statuses.includes("stale")
              ? "stale"
              : equals
                ? "current"
                : "tampered");
    artifacts[path] = status;
    if (path.endsWith(".html"))
      html.set(path, {
        status,
        hash: manifest?.artifacts.get(basename(path))?.sha256,
      });
  }
  return {
    ...result,
    packet,
    findings,
    status:
      ["missing", "tampered", "stale"].find((state) =>
        Object.values(artifacts).includes(state),
      ) ?? "current",
  };
}

export function legacyHtml(ctx, path, regenerated, views) {
  const delivered = exportFile(ctx, path);
  if (!delivered.bytes) return delivered;
  const sidecar = exportFile(ctx, path + ".receipt.json");
  const fallback =
    path === packetHtml
      ? ["packet", "--input", packetInput]
      : views.get(basename(path, ".html") + ".pdf")?.fallback;
  const replay =
    path === packetHtml && !sidecar.bytes && regenerated.matches.html
      ? { bytes: readFileSync(regenerated.prefix + ".html") }
      : replayHtml(ctx, path, fallback, !!sidecar.bytes);
  if (sidecar.status === "tampered") return sidecar;
  const hash = sha256(delivered.bytes);
  if (sidecar.bytes) {
    try {
      const pathReceipt = path + ".receipt.json";
      const actual = readReceiptRecord(readJson(sidecar.bytes, pathReceipt));
      if (
        actual.artifact.path !== basename(path) ||
        actual.artifact.sha256 !== hash
      )
        return { status: "tampered" };
      if (!replay?.receipt) return { status: "unverified" };
      const expected = readReceiptRecord(readJson(replay.receipt, pathReceipt));
      if (
        canonical(actual.source) !== canonical(expected.source) ||
        canonical(actual.producer) !== canonical(expected.producer)
      )
        return { status: "stale" };
      if (
        canonical(actual.artifact.intent) !==
        canonical(expected.artifact.intent)
      )
        return { status: "tampered" };
    } catch {
      return { status: "tampered" };
    }
  }
  return replay?.bytes.equals(delivered.bytes)
    ? { status: "current", hash }
    : { status: sidecar.bytes ? "tampered" : replay ? "stale" : "unverified" };
}

export function captureArtifactPath(project, input) {
  return portablePath(relative(project, resolve(project, input)));
}

export function captureChain(ctx, verifyHtml) {
  let source;
  try {
    source = projectReader(ctx.captureEvidence ?? ctx.evidence);
    const receipt = JSON.parse(source.read("visual-captures/result.json"));
    if (receipt.error)
      return { status: "missing", files: [], error: receipt.error };
    if (
      receipt.format !== "thermite-agent-visual-capture/1" ||
      !Array.isArray(receipt.files) ||
      receipt.files.length > 4
    )
      return { status: "tampered", files: [] };
    const files = receipt.files.map(
      ({ input, inputSha256, output, sha256: pngHash, bytes }, i) => {
        let status, hash;
        try {
          input = captureArtifactPath(
            ctx.originalProject ?? ctx.project,
            input,
          );
          if (
            !input.endsWith(".html") ||
            output !== "visual-captures/0" + (i + 1) + ".png"
          )
            return { input, status: "tampered" };
          const png = source.read(output);
          if (png.length !== bytes || sha256(png) !== pngHash)
            return { input, status: "tampered" };
          ({ status, hash } = verifyHtml(input));
        } catch (error) {
          return {
            input,
            status: error.code === "ENOENT" ? "missing" : "tampered",
          };
        }
        return {
          input,
          status:
            status === "current" && hash !== inputSha256 ? "stale" : status,
          inputSha256,
        };
      },
    );
    const distinct = new Set(files.map(({ inputSha256 }) => inputSha256));
    const status =
      ["tampered", "stale", "missing", "unverified"].find((state) =>
        files.some((file) => file.status === state),
      ) ??
      (files.some(({ input }) => input === packetHtml) && distinct.size >= 2
        ? "current"
        : "missing");
    return { status, files };
  } catch (error) {
    return {
      status: error.code === "ENOENT" ? "missing" : "tampered",
      files: [],
    };
  } finally {
    source?.close();
  }
}
