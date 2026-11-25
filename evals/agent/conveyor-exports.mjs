import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import {
  parseExportJson,
  portablePath,
} from "../../packages/cli/dist/alpha-export-input.js";
import { readReceiptRecord } from "../../packages/cli/dist/alpha-export-record.js";
import {
  cleanChecker,
  deliveredBytes,
  pdf,
  replayExport,
  standaloneExportArtifact,
  standaloneExportCall,
} from "./artifacts.mjs";
import { projectReader } from "./capture-files.mjs";
import { sha256 } from "./snapshot.mjs";
import { canonical } from "./source-files.mjs";
import { cli } from "./task-support.mjs";

const directory = "drawings";
const marker = "drawings/export-manifest.json";
const packetHtml = "drawings/packet.html";
const packetJson = "drawings/packet.json";
const packetPdf = "drawings/packet.pdf";
const packetArtifacts = new Set([packetJson, packetHtml, packetPdf]);
export const conveyorPacketRequest = "packet.request.json";
export const conveyorBaseline = "drawings/before.json";
const diagnostics = "drawings/diagnostics.json";
const cable = "drawings/cable.json";
const review = "drawings/review.json";

export function conveyorOutputs(spec) {
  return [
    ...spec.views.map((name) => directory + "/" + name),
    packetJson,
    packetHtml,
    packetPdf,
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

export function isDrawingsBundleCall(call, root) {
  const { argv, phase, exit } = call ?? {};
  return (
    phase !== "flush" &&
    exit === 0 &&
    Array.isArray(argv) &&
    argv[0] === "export" &&
    argv[1] === "bundle" &&
    argv.every((arg) => typeof arg === "string") &&
    resolve(root, option(argv, "--project") ?? ".") === resolve(root) &&
    resolve(root, option(argv, "--out-dir") ?? "") === resolve(root, directory)
  );
}

function confineProjectInput(source, root, authored) {
  if (typeof authored !== "string" || !authored || authored === "-")
    throw new Error("Expected a named project-local request path.");
  const rel = relative(root, resolve(root, authored));
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw Object.assign(
      new Error(`Request path outside project root: ${authored}.`),
      { outsideInput: authored },
    );
  return portablePath(
    source.path(rel.replaceAll("\\", "/")).replaceAll("\\", "/"),
  );
}

// Resolve one bundle invocation's named delivery request path within the project.
function bundleCallInput(source, root, call, index) {
  const authored = call
    ? option(call.argv, "--input")
    : "delivery.request.json";
  if (!authored || authored === "-")
    return { call, index, authored: authored ?? null };
  try {
    return {
      path: confineProjectInput(source, root, authored),
      call,
      index,
      authored,
    };
  } catch (error) {
    return {
      call,
      index,
      authored,
      outsideProject:
        !!error.outsideInput || /outside project root/.test(error.message),
      outsideInput: error.outsideInput ?? null,
      error: error.message,
    };
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

// Only required names carry task-specific intent constraints. The CLI validates
// the entire request before these recipes can be replayed.
function bundleRecipe(
  job,
  path,
  required,
  views,
  cableTags,
  { packetRequest, packetPaths, confine },
) {
  const name = basename(path);
  switch (job.kind) {
    case "packet": {
      if (required && !packetPaths.has(path)) break;
      const confined = confine(job.input);
      const input =
        packetRequest !== null
          ? required
            ? packetRequest
            : confined
          : confined;
      return [
        "packet",
        "--input",
        input,
        ...drawingOptions(job),
        ...(job.strict ? ["--strict"] : []),
      ];
    }
    case "view": {
      const view = views.get(name);
      if (
        required &&
        (!view?.roots.includes(job.designation) || job.intent !== view.intent)
      )
        break;
      return [
        "view",
        job.designation,
        ...(job.intent === "trace"
          ? ["--to", job.to, ...(job.includePower ? ["--include-power"] : [])]
          : ["--" + job.intent]),
        ...drawingOptions(job),
        ...(job.flow === undefined ? [] : ["--flow", job.flow]),
      ];
    }
    case "report":
      if (
        required &&
        (path !== directory + "/" + job.report + ".csv" ||
          job.device !== undefined ||
          job.filter !== undefined)
      )
        break;
      return [
        "report",
        job.report,
        ...drawingOptions(job),
        ...(job.device === undefined ? [] : ["--device", job.device]),
        ...(job.filter === undefined ? [] : ["--filter", job.filter]),
      ];
    case "diagnostics":
      if (
        required &&
        (path !== diagnostics ||
          job.device !== undefined ||
          job.location !== undefined)
      )
        break;
      return [
        "diagnostics",
        ...(job.device === undefined ? [] : ["--device", job.device]),
        ...(job.location === undefined ? [] : ["--location", job.location]),
      ];
    case "cable":
      if (required && (path !== cable || !cableTags.includes(job.designation)))
        break;
      return ["cable", job.designation];
    case "review":
      if (required && (path !== review || job.before !== conveyorBaseline))
        break;
      return ["review", "--before", job.before];
    default:
      throw new Error(
        "Disallowed bundle job type " + JSON.stringify(job.kind) + ".",
      );
  }
  throw new Error("Bundle job " + job.kind + " cannot satisfy " + path + ".");
}

function planBundle(
  request,
  {
    required,
    views = new Map(),
    cableTags = [],
    packetRequest = conveyorPacketRequest,
    packetPaths = packetArtifacts,
    confine,
  },
) {
  if (
    request?.format !== "export-delivery-request/1" ||
    !Array.isArray(request.jobs) ||
    !request.jobs.length
  )
    throw new Error("Expected a nonempty export-delivery-request/1.");
  const plan = new Map();
  for (const job of request.jobs) {
    if (
      !job?.outputs ||
      typeof job.outputs !== "object" ||
      Array.isArray(job.outputs) ||
      !Object.keys(job.outputs).length
    )
      throw new Error("Each bundle job needs at least one named output.");
    for (const name of Object.values(job.outputs)) {
      const path = directory + "/" + portablePath(name);
      if (plan.has(path))
        throw new Error("Duplicate bundle output " + path + ".");
      const isRequired = required.has(path);
      const confinedPacketInput =
        job.kind === "packet" ? confine(job.input) : null;
      const argv = bundleRecipe(job, path, isRequired, views, cableTags, {
        packetRequest,
        packetPaths,
        confine,
      });
      plan.set(path, {
        argv,
        packetInput: confinedPacketInput,
        requestMismatch:
          packetRequest !== null &&
          isRequired &&
          job.kind === "packet" &&
          confinedPacketInput !== confine(packetRequest),
      });
    }
  }
  return plan;
}

function checkFindings(clean, request) {
  const check = cli(
    clean,
    "export",
    "check",
    "--input",
    request,
    "--out-dir",
    directory,
    "--json",
  );
  try {
    const report = JSON.parse(check.stdout);
    if (
      report.format === "export-check/1" &&
      (check.status === 0 || report.reasons.length)
    )
      return report.reasons;
  } catch {}
  return [{ path: "delivery", code: "unverifiable_input" }];
}

function evaluateBundleMarker(ctx, input, requestBytes, checks, findings) {
  const deliveredMarker = exportFile(ctx, marker);
  const publishedHash = input.call?.after?.files?.[marker];
  let markerTampered =
    deliveredMarker.status === "tampered" ||
    checks.some(
      ({ path, code }) =>
        path === basename(marker) && code === "unverifiable_input",
    );
  if (
    publishedHash &&
    deliveredMarker.bytes &&
    sha256(deliveredMarker.bytes) !== publishedHash
  ) {
    findings.push({ path: basename(marker), code: "marker_changed" });
    markerTampered = true;
  }
  const changedRequest =
    typeof input.call?.request === "string" &&
    sha256(input.call.request) !== sha256(requestBytes);
  const markerStale = checks.some(
    ({ path, code }) =>
      path === basename(marker) &&
      (code === "source_changed" ||
        code === "producer_mismatch" ||
        (code === "request_changed" && changedRequest)),
  );
  if (
    !changedRequest &&
    checks.some(
      ({ path, code }) =>
        path === basename(marker) && code === "request_changed",
    )
  )
    markerTampered = true;
  return { deliveredMarker, markerTampered, markerStale, changedRequest };
}

async function regenerateBundleArtifact(
  ctx,
  clean,
  input,
  path,
  {
    argv,
    requestMismatch,
    packetInput,
    planRebound = false,
    auditedOutside = false,
    auditedPacketInput = null,
  },
  { checks, deliveredMarker, markerStale, changedRequest, packetJsonPath },
) {
  const delivered = exportFile(ctx, path);
  const specific = checks.filter(
    (finding) => directory + "/" + finding.path === path,
  );
  const out = join(ctx.evidence, "checker-bundle", path);
  mkdirSync(dirname(out), { recursive: true });
  const generated = cli(clean, ...argv, "-o", out);
  let equals = false,
    packet = null;
  if (generated.status === 0) {
    const expected = readFileSync(out);
    if (path === packetJsonPath) packet = JSON.parse(expected);
    equals =
      !!delivered.bytes?.equals(expected) &&
      (!path.endsWith(".pdf") || (await pdf(out)));
  }
  const changedDependency = ["--input", "--before", "--filter"].some((flag) => {
    const dependency = option(argv, flag);
    const published = input.call?.after?.files?.[dependency];
    const { bytes } = dependency ? exportFile(ctx, dependency) : {};
    return published && bytes && sha256(bytes) !== published;
  });
  const stale = markerStale || changedDependency;
  const conflicting = specific.some(
    ({ code }) =>
      code === "unverifiable_input" ||
      (code === "request_changed" && !changedRequest && !changedDependency),
  );
  const published = input.call?.after?.files?.[path];
  const hash = delivered.bytes && sha256(delivered.bytes);
  const byteMismatch = specific.some(({ code }) => code === "byte_mismatch");
  const changedBytes = !!(published && hash && published !== hash);
  const status =
    delivered.status ??
    (conflicting ||
    auditedOutside ||
    changedBytes ||
    (byteMismatch && !(stale && equals))
      ? "tampered"
      : equals && !requestMismatch && !planRebound && !changedDependency
        ? "current"
        : stale || requestMismatch || planRebound || !deliveredMarker.bytes
          ? "stale"
          : "tampered");
  if (status === "current") for (const finding of specific) finding.note = true;
  return {
    entry: {
      status,
      hash,
      argv,
      packetInput,
      ...(planRebound ? { planRebound: true } : {}),
      ...(changedDependency ? { changedDependency: true } : {}),
      ...(changedBytes ? { changedBytes: true } : {}),
      ...(auditedPacketInput ? { auditedPacketInput } : {}),
    },
    packet,
  };
}

function rawBundleInputs(raw) {
  if (!Array.isArray(raw?.jobs)) return [];
  return raw.jobs
    .map((job) =>
      typeof job?.input === "string" && job.input ? job.input : null,
    )
    .filter(Boolean);
}

function rawBundleOutputs(raw) {
  if (!Array.isArray(raw?.jobs)) return null;
  const outputs = new Set();
  for (const job of raw.jobs) {
    if (
      !job?.outputs ||
      typeof job.outputs !== "object" ||
      Array.isArray(job.outputs)
    )
      continue;
    for (const name of Object.values(job.outputs)) {
      if (typeof name !== "string" || !name) continue;
      try {
        outputs.add(directory + "/" + portablePath(name));
      } catch {}
    }
  }
  return outputs.size ? outputs : null;
}

function loadBundlePlan(ctx, input, planOptions, nestedInputs) {
  const root = ctx.originalProject ?? ctx.project;
  const source = projectReader(ctx.project);
  try {
    if (!input.path)
      throw Object.assign(
        new Error(
          input.error ?? "Expected a named project-local bundle request.",
        ),
        input.outsideInput ? { outsideInput: input.outsideInput } : {},
      );
    const requestBytes = deliveredBytes(ctx, input.path);
    const parsed = readJson(requestBytes, input.path);
    for (const item of rawBundleInputs(parsed)) nestedInputs.add(item);
    const plan = planBundle(parsed, {
      ...planOptions,
      confine: (authored) => confineProjectInput(source, root, authored),
    });
    return { plan, requestBytes };
  } finally {
    source.close();
  }
}

function inspectAuditedBundleCall(ctx, input, planOptions, nestedInputs) {
  if (typeof input.call?.request === "string") {
    const auditedBytes = Buffer.from(input.call.request, "utf8");
    const root = ctx.originalProject ?? ctx.project;
    const source = projectReader(ctx.project);
    let rawOutputs = null;
    try {
      const parsed = readJson(
        auditedBytes,
        input.path ?? input.authored ?? "delivery",
      );
      for (const item of rawBundleInputs(parsed)) nestedInputs.add(item);
      rawOutputs = rawBundleOutputs(parsed);
      const auditedPlan = planBundle(parsed, {
        ...planOptions,
        confine: (authored) => confineProjectInput(source, root, authored),
      });
      return {
        auditedPlan,
        auditedError: null,
        auditedOutputs: new Set(auditedPlan.keys()),
      };
    } catch (error) {
      return {
        auditedPlan: null,
        auditedError: error,
        auditedOutputs: rawOutputs,
      };
    } finally {
      source.close();
    }
  }
  if (input.call?.request === null)
    return {
      auditedPlan: null,
      auditedError: new Error("Audited bundle request could not be read."),
      auditedOutputs: null,
    };
  if (input.path) {
    try {
      const { plan, requestBytes } = loadBundlePlan(
        ctx,
        input,
        planOptions,
        nestedInputs,
      );
      return {
        auditedPlan: null,
        auditedError: null,
        auditedOutputs: new Set(plan.keys()),
        fallbackPlan: plan,
        fallbackRequestBytes: requestBytes,
      };
    } catch {}
  }
  return { auditedPlan: null, auditedError: null, auditedOutputs: null };
}

// Build per-artifact publishing ownership in chronological call order from
// audited bundle plans and standalone export calls before checking saved plans.
function buildPublishingHistory(
  ctx,
  { planOptions, onlyPaths, allowManifestFallback, nestedInputs },
) {
  const root = ctx.originalProject ?? ctx.project;
  const calls = ctx.calls ?? [];
  const bundleByIndex = new Map();
  const bundleEntries = [];
  const source = projectReader(ctx.project);
  try {
    for (let i = 0; i < calls.length; i++) {
      if (!isDrawingsBundleCall(calls[i], root)) continue;
      const entry = bundleCallInput(source, root, calls[i], i);
      bundleByIndex.set(i, entry);
      bundleEntries.push(entry);
    }
    if (!bundleEntries.length) {
      const manifest = exportFile(ctx, marker);
      if (!allowManifestFallback || manifest.status === "missing")
        return { bundleEntries: [], latestPublisher: new Map() };
      const fallbackEntry = bundleCallInput(source, root, null, -1);
      bundleByIndex.set(-1, fallbackEntry);
      bundleEntries.push(fallbackEntry);
    }
  } finally {
    source.close();
  }
  const latestPublisher = new Map();
  const applyBundle = (entry, index) => {
    Object.assign(
      entry,
      inspectAuditedBundleCall(ctx, entry, planOptions, nestedInputs),
    );
    const claimed =
      entry.auditedOutputs ??
      new Set([
        ...(onlyPaths ?? planOptions.required ?? []),
        ...latestPublisher.keys(),
      ]);
    for (const path of claimed)
      latestPublisher.set(path, { kind: "bundle", entry, index });
  };
  if (bundleByIndex.has(-1)) applyBundle(bundleByIndex.get(-1), -1);
  for (let i = 0; i < calls.length; i++) {
    if (bundleByIndex.has(i)) {
      applyBundle(bundleByIndex.get(i), i);
      continue;
    }
    const target = standaloneExportArtifact(calls[i], root);
    if (target)
      latestPublisher.set(portablePath(target.path), {
        kind: "standalone",
        call: calls[i],
        index: i,
      });
  }
  return { bundleEntries, latestPublisher };
}

function planMatchesAudited(auditedPlan, auditedError, path, planned) {
  if (auditedError)
    return {
      ok: false,
      outside: !!auditedError.outsideInput,
      outsideInput: auditedError.outsideInput ?? null,
      packetInput: null,
    };
  if (!auditedPlan)
    return { ok: true, outside: false, outsideInput: null, packetInput: null };
  const audited = auditedPlan.get(path);
  if (!audited)
    return { ok: false, outside: false, outsideInput: null, packetInput: null };
  return {
    ok:
      !audited.requestMismatch &&
      audited.packetInput === planned.packetInput &&
      canonical(audited.argv) === canonical(planned.argv),
    outside: false,
    outsideInput: null,
    packetInput: audited.packetInput,
  };
}

function removedFromPlanEntry(ctx, entry, path, outsideInputs, result) {
  const auditedEntry = entry.auditedPlan?.get(path) ?? null;
  const outsideInput = entry.auditedError?.outsideInput ?? null;
  if (outsideInput) {
    result.outsideProject = true;
    outsideInputs.add(outsideInput);
  }
  const delivered = exportFile(ctx, path);
  return {
    status: outsideInput ? "tampered" : "stale",
    hash: delivered.bytes ? sha256(delivered.bytes) : null,
    argv: auditedEntry?.argv ?? null,
    packetInput: null,
    planRebound: true,
    ...(auditedEntry?.packetInput
      ? { auditedPacketInput: auditedEntry.packetInput }
      : {}),
  };
}

export async function regenerateBundle(
  ctx,
  {
    required,
    views = new Map(),
    cableTags = [],
    packetRequest = conveyorPacketRequest,
    packetPaths = packetArtifacts,
    packetJsonPath = packetJson,
    onlyPaths = null,
    allowManifestFallback = false,
  },
) {
  const planOptions = {
    required,
    views,
    cableTags,
    packetRequest,
    packetPaths,
  };
  const artifacts = new Map(),
    findings = [],
    nestedInputs = new Set();
  const { bundleEntries, latestPublisher } = buildPublishingHistory(ctx, {
    planOptions,
    onlyPaths,
    allowManifestFallback,
    nestedInputs,
  });
  if (!bundleEntries.length) return null;
  const latestBundle = bundleEntries.at(-1);
  const outsideInputs = new Set(
    latestBundle.outsideInput ? [latestBundle.outsideInput] : [],
  );
  const result = {
    artifacts,
    findings,
    request: latestBundle.path ?? null,
    authored: latestBundle.authored ?? null,
    outsideProject: !!latestBundle.outsideProject,
    nestedInputs: [],
    outsideInputs: [...outsideInputs],
    packet: null,
  };
  const clean = cleanChecker(ctx);
  let hasInvalidRequest = false;
  let markerTampered = false;
  for (const entry of bundleEntries) {
    const isLatest = entry === latestBundle;
    const owned = [...latestPublisher.entries()]
      .filter(
        ([path, pub]) =>
          pub.kind === "bundle" &&
          pub.entry === entry &&
          (!onlyPaths || onlyPaths.has(path)),
      )
      .map(([path]) => path);
    if (!owned.length && !isLatest) continue;
    if (!isLatest && entry.path) nestedInputs.add(entry.path);
    if (entry.outsideInput) {
      outsideInputs.add(entry.outsideInput);
      if (owned.length) result.outsideProject = true;
    }
    let plan, requestBytes;
    try {
      if (entry.fallbackPlan) {
        plan = entry.fallbackPlan;
        requestBytes = entry.fallbackRequestBytes;
      } else {
        ({ plan, requestBytes } = loadBundlePlan(
          ctx,
          entry,
          planOptions,
          nestedInputs,
        ));
      }
    } catch (error) {
      if (!owned.length) continue;
      if (error.outsideInput) outsideInputs.add(error.outsideInput);
      findings.push({
        path: error.outsideInput ?? entry.path ?? entry.authored ?? "delivery",
        code: "invalid_request",
        message: error.message,
      });
      hasInvalidRequest = true;
      if (outsideInputs.size > 0 || /outside project root/.test(error.message))
        result.outsideProject = true;
      for (const path of owned)
        artifacts.set(
          path,
          removedFromPlanEntry(ctx, entry, path, outsideInputs, result),
        );
      continue;
    }
    let checks = [];
    let markerState;
    if (isLatest) {
      checks = checkFindings(clean, entry.path);
      findings.push(...checks);
      if (
        owned.length &&
        checks.some(
          ({ path, code }) =>
            code === "unverifiable_input" &&
            path !== basename(marker) &&
            !plan.has(directory + "/" + path),
        )
      ) {
        hasInvalidRequest = true;
        for (const path of owned)
          artifacts.set(
            path,
            removedFromPlanEntry(ctx, entry, path, outsideInputs, result),
          );
        continue;
      }
      markerState = evaluateBundleMarker(
        ctx,
        entry,
        requestBytes,
        checks,
        findings,
      );
      if (markerState.markerTampered) markerTampered = true;
      const ownedSet = new Set(owned);
      for (const finding of checks) {
        const full = directory + "/" + finding.path;
        if (
          finding.path !== basename(marker) &&
          !ownedSet.has(full) &&
          (plan.has(full) || entry.auditedOutputs?.has(full))
        )
          finding.superseded = true;
      }
    } else {
      const changedRequest =
        typeof entry.call?.request === "string" &&
        sha256(entry.call.request) !== sha256(requestBytes);
      markerState = {
        deliveredMarker: { bytes: Buffer.alloc(1) },
        markerTampered: false,
        markerStale: false,
        changedRequest,
      };
    }
    for (const path of owned) {
      const planned = plan.get(path);
      if (!planned) {
        artifacts.set(
          path,
          removedFromPlanEntry(ctx, entry, path, outsideInputs, result),
        );
        continue;
      }
      const audited = planMatchesAudited(
        entry.auditedPlan,
        entry.auditedError,
        path,
        planned,
      );
      if (audited.outside) {
        result.outsideProject = true;
        if (audited.outsideInput) outsideInputs.add(audited.outsideInput);
      }
      const { entry: artifactEntry, packet } = await regenerateBundleArtifact(
        ctx,
        clean,
        entry,
        path,
        {
          ...planned,
          planRebound: !audited.ok,
          auditedOutside: audited.outside,
          auditedPacketInput: audited.packetInput,
        },
        { checks, ...markerState, packetJsonPath },
      );
      if (packet) result.packet = packet;
      artifacts.set(path, artifactEntry);
    }
  }
  for (const finding of findings)
    if (finding.path === basename(marker) && !markerTampered)
      finding.note = true;
  return {
    ...result,
    nestedInputs: [...nestedInputs],
    outsideInputs: [...outsideInputs],
    status: hasInvalidRequest
      ? "invalid-request"
      : markerTampered
        ? "tampered"
        : "current",
  };
}

// Strict audited bundle verification: requires an observed export-bundle call.
export async function regenerateDeliveryBundle(ctx, spec, views, cableTags) {
  return regenerateBundle(ctx, {
    required: new Set(conveyorOutputs(spec)),
    views,
    cableTags,
    packetRequest: conveyorPacketRequest,
    packetPaths: packetArtifacts,
    packetJsonPath: packetJson,
    allowManifestFallback: false,
  });
}

// Explicit historical D-conveyor replay compatibility path (allows unaudited
// export-manifest discovery when no export-bundle call was recorded).
export async function regenerateHistoricalConveyorBundle(
  ctx,
  spec,
  views,
  cableTags,
) {
  return regenerateBundle(ctx, {
    required: new Set(conveyorOutputs(spec)),
    views,
    cableTags,
    packetRequest: conveyorPacketRequest,
    packetPaths: packetArtifacts,
    packetJsonPath: packetJson,
    allowManifestFallback: true,
  });
}

export function verifyStandaloneExport(ctx, path, { matches, fallback } = {}) {
  const delivered = exportFile(ctx, path);
  if (!delivered.bytes) return delivered;
  if (path.endsWith(".json")) {
    try {
      readJson(delivered.bytes, path);
    } catch {
      return { status: "tampered" };
    }
  }
  const pathReceipt = path + ".receipt.json";
  const sidecar = exportFile(ctx, pathReceipt);
  if (sidecar.status === "tampered") return sidecar;
  const hash = sha256(delivered.bytes);
  const call = standaloneExportCall(ctx, path);
  const published = call?.after?.files?.[path];
  const publishedReceipt = call?.after?.files?.[pathReceipt];
  if (
    (published && published !== hash) ||
    (publishedReceipt &&
      sidecar.bytes &&
      publishedReceipt !== sha256(sidecar.bytes))
  )
    return { status: "tampered" };
  // A plain standalone export leaves any previous receipt on disk. The audit
  // can establish that this call published the current bytes without it.
  const leftover =
    published &&
    publishedReceipt &&
    call.before?.files?.[pathReceipt] === publishedReceipt &&
    !call.argv.includes("--receipt");
  const receipt = !leftover && sidecar.bytes;
  if (!receipt && matches !== undefined)
    return { status: matches ? "current" : "stale", hash };

  let actual;
  if (receipt) {
    try {
      actual = readReceiptRecord(readJson(receipt, pathReceipt));
      if (
        actual.artifact.path !== basename(path) ||
        actual.artifact.sha256 !== hash
      )
        return { status: "tampered" };
      const input = actual.artifact.intent?.inputs?.[0]?.path;
      if (
        packetArtifacts.has(path) &&
        (matches === false ||
          (typeof input === "string" && input !== conveyorPacketRequest))
      )
        return { status: "stale", hash };
    } catch {
      return { status: "tampered" };
    }
  }
  const replay = replayExport(ctx, path, fallback, !!receipt);
  const equals = replay?.bytes.equals(delivered.bytes);
  if (actual) {
    try {
      if (!replay?.receipt) return { status: "unverified" };
      const expected = readReceiptRecord(readJson(replay.receipt, pathReceipt));
      const { inputs, ...intent } = actual.artifact.intent;
      const { inputs: expectedInputs, ...expectedIntent } =
        expected.artifact.intent;
      const stale =
        canonical(actual.source) !== canonical(expected.source) ||
        canonical(actual.producer) !== canonical(expected.producer) ||
        canonical(inputs) !== canonical(expectedInputs);
      if (!equals && stale) return { status: "stale" };
      if (
        canonical(intent) !== canonical(expectedIntent) ||
        canonical(inputs.map(({ path }) => path)) !==
          canonical(expectedInputs.map(({ path }) => path))
      )
        return { status: "tampered" };
    } catch {
      return { status: "tampered" };
    }
  }
  return equals && matches !== false
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
