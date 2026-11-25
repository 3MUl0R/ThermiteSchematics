import { cableListingMatches } from "./cable-listing.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "linkedom";
import { sha256 } from "./snapshot.mjs";
import { libraryTypes, canonical } from "./source-files.mjs";
import {
  SYMBOL_PROFILES,
  symbolProfile,
} from "../../packages/schema/dist/index.js";
import {
  regeneratePacket,
  regeneratePacketMetadata,
  packetRecipeKey,
  regenerateView,
  cleanChecker,
  deliveredBytes,
  packetFailureReport,
} from "./artifacts.mjs";
import {
  conveyorOutputs,
  conveyorBaseline,
  conveyorPacketRequest,
  captureChain,
  exportFile,
  verifyStandaloneExport,
  regenerateDeliveryBundle,
  regenerateHistoricalConveyorBundle,
} from "./conveyor-exports.mjs";
import { read, objects, cli, query } from "./task-support.mjs";
import { runAssessDogfood } from "./dogfood-assess.mjs";
import { runPrepareDogfoodProject } from "./dogfood-prepare.mjs";
export function schematicSheets(packet) {
  return (packet?.sheets ?? []).filter(
    (s) =>
      s.view?.format?.startsWith("schematic-view/") ||
      [
        "circuit",
        "wiring",
        "communication",
        "signal-loop",
        "connector-assembly",
      ].includes(s.view?.kind),
  );
}
export function drawingNames(packet) {
  const names = new Set(
    schematicSheets(packet).flatMap((s) =>
      (s.references ?? []).map((r) => r.designation),
    ),
  );
  for (const sheet of schematicSheets(packet))
    if (sheet.view?.root?.kind === "cable")
      names.add(sheet.view.root.designation);
  return names;
}
// Packet coverage covers only audited circuit/wiring views. Continuous
// schematic exports also emit physical wire paths with source UIDs.
function drawnWires(packet) {
  const uids = new Set();
  for (const sheet of schematicSheets(packet)) {
    if (!sheet.svg) continue;
    const svg = new DOMParser().parseFromString(sheet.svg, "image/svg+xml");
    for (const path of svg.querySelectorAll("path.wire-path[data-wire-uid][d]"))
      if (path.getAttribute("d").trim())
        uids.add(path.getAttribute("data-wire-uid"));
  }
  return uids;
}
export function fitsRole(object, type, role) {
  if (role === "cable") return object?.kind === "cable";
  if (object?.kind !== "device" || !type) return false;
  const profile = SYMBOL_PROFILES.find((p) => p.id === symbolProfile(type)),
    family = profile?.id.split(":")[1],
    functions = Object.values(type.functions ?? {}),
    has = (kind, direction) =>
      functions.some(
        (f) => f.kind === kind && (!direction || f.direction === direction),
      );
  switch (role) {
    case "supply":
      return (
        has("source") &&
        functions.some((f) => f.kind === "source" && f.terminals?.length === 3)
      );
    case "breaker":
    case "overload":
      return family === role;
    case "contactor":
      return has("coil") && has("contact");
    case "motor":
      return !!profile && /^motor(?:-|$)/.test(family);
    case "psu":
      return has("source") && has("load");
    case "plc":
      return has("channel", "input") && has("channel", "output");
    case "terminal":
    case "junction":
      return functions.length > 0 && functions.every((f) => f.kind === "bus");
    case "start-button":
      return (
        family === "pushbutton" &&
        functions.some((f) => f.kind === "contact" && f.normal_state === "open")
      );
    case "level-switch":
      return ["level-switch", "level-sensor", "conductivity-probe"].includes(
        family,
      );
    case "stop-button":
      return (
        family === "pushbutton" &&
        functions.some(
          (f) => f.kind === "contact" && f.normal_state === "closed",
        )
      );
    case "pnp-sensor":
      return (
        has("load") &&
        has("channel", "output") &&
        family === "sensor-3wire" &&
        /\bPNP\b/i.test(type.description ?? "")
      );
    case "pressure-transmitter":
      return !!profile?.support.some(
        (s) => s.family === "signal-loop" && s.role === "from",
      );
    case "analog-input":
      return (
        Object.values(type.terminals ?? {}).some((t) =>
          /analog.?input/i.test(t.role ?? ""),
        ) ||
        functions.some(
          (f) =>
            f.kind === "channel" &&
            f.direction === "input" &&
            f.terminals?.length === 2,
        )
      );
    case "hmi":
      return (
        Object.values(type.ports ?? {}).some((p) => p.medium === "ethernet") &&
        !fitsRole(object, type, "plc")
      );
    case "indicator":
      return family === "lamp";
    default:
      return false;
  }
}

export function assessDogfood(options) {
  return runAssessDogfood(options, {
    schematicSheets,
    drawingNames,
    drawnWires,
    fitsRole,
  });
}
function dogfoodBundlePacketFailure(ctx, bundle, verified) {
  if (!bundle) return null;
  const exts = ["json", "pdf", "html"];
  const matches = Object.fromEntries(
    exts.map((ext) => [
      ext,
      bundle.status === "current" &&
        verified.get(`drawings/packet.${ext}`)?.status === "current",
    ]),
  );
  if (Object.values(matches).every(Boolean)) return null;
  const deliveredRequests = new Map(),
    reboundBundles = [],
    changedRequests = [],
    replacedOutputs = [];
  for (const ext of exts) {
    const artifact = `drawings/packet.${ext}`;
    const entry = bundle.artifacts.get(artifact);
    if (!entry) continue;
    if (entry.packetInput) deliveredRequests.set(ext, entry.packetInput);
    if (entry.planRebound) reboundBundles.push(artifact);
    if (entry.changedDependency) changedRequests.push(artifact);
    if (entry.changedBytes) replacedOutputs.push(artifact);
  }
  return packetFailureReport({
    ctx,
    request: conveyorPacketRequest,
    bundle,
    deliveredRequests,
    reboundBundles,
    changedRequests,
    replacedOutputs,
    matches,
  });
}

// Explicit historical D-conveyor replay compatibility path. Keeps archived
// unaudited conveyor deliveries byte-identical without weakening checkDogfood.
export async function checkHistoricalConveyor(ctx) {
  if (ctx?.task?.id !== "D-conveyor")
    throw new Error(
      `checkHistoricalConveyor requires task D-conveyor, received ${JSON.stringify(ctx?.task?.id ?? null)}.`,
    );
  return checkDogfood(ctx, { allowUnauditedConveyorReplay: true });
}

export async function checkDogfood(
  ctx,
  { allowUnauditedConveyorReplay = false } = {},
) {
  const safeRead = (path) => {
    try {
      return JSON.parse(deliveredBytes(ctx, path));
    } catch {
      return null;
    }
  };
  const hasCapture = ctx.task.visualCapture === true;
  const spec = ctx.task.deliverables,
    sourceObjects = objects(ctx.project),
    types = libraryTypes(ctx.project),
    matrix = safeRead("requirement-matrix.json"),
    byTag = new Map(sourceObjects.map((o) => [o.designation, o])),
    byType = new Map(types.map((t) => [t.id, t])),
    clean = cleanChecker(ctx),
    files = {},
    views = new Map();
  const namesFor = (id) =>
    Array.isArray(matrix)
      ? matrix.find(
          (row) => typeof row?.id === "string" && row.id.toUpperCase() === id,
        )?.designations
      : undefined;
  const roleByFile = {
    "motor-power.pdf": ["motor", "power"],
    "ps1-loads.pdf": ["psu", "loads"],
    "contactor-actuation.pdf": ["contactor", "actuation"],
  };
  for (const name of spec.views) {
    const [role, intent] =
      roleByFile[name] ?? roleByFile["contactor-actuation.pdf"];
    const row = spec.requirements.find((r) => r.roles.includes(role));
    const names = namesFor(row?.id);
    const roots = Array.isArray(names)
      ? names.filter((tag) =>
          fitsRole(byTag.get(tag), byType.get(byTag.get(tag)?.type), role),
        )
      : [];
    const fallback = [
      "view",
      roots[0],
      "--" + intent,
      "-o",
      "drawings/" + name,
    ];
    views.set(name, { roots, intent, fallback });
  }
  const cableRow = spec.requirements.find((r) => r.roles[0] === "cable");
  const cableTags = namesFor(cableRow?.id);
  const resolvedCableTags = Array.isArray(cableTags)
    ? cableTags.filter((tag) => byTag.get(tag)?.kind === "cable")
    : [];
  const bundle = allowUnauditedConveyorReplay
    ? await regenerateHistoricalConveyorBundle(
        ctx,
        spec,
        views,
        resolvedCableTags,
      )
    : await regenerateDeliveryBundle(ctx, spec, views, resolvedCableTags);
  const legacy = (path) => !bundle?.artifacts.has(path);
  const formats = ["json", "pdf", "html"].filter((ext) =>
    legacy("drawings/packet." + ext),
  );
  const regenerated = formats.length
    ? await regeneratePacket(ctx, {
        request: conveyorPacketRequest,
        formats,
        bindRequest: true,
        allowBundle: false,
        allowUnauditedFallback: allowUnauditedConveyorReplay,
      })
    : null;
  const fallbacks = new Map();
  for (const [name, { roots, fallback }] of views) {
    const path = "drawings/" + name;
    if (!legacy(path)) continue;
    files[path] =
      roots.length > 0 &&
      (await regenerateView(ctx, path, fallback, { roots })).pass;
    fallbacks.set(path, fallback);
  }
  for (const ext of formats) {
    const path = "drawings/packet." + ext;
    files[path] = regenerated.matches[ext];
    fallbacks.set(path, ["packet", "--input", conveyorPacketRequest]);
  }
  for (const kind of spec.reports) {
    const path = `drawings/${kind}.csv`;
    if (!legacy(path)) continue;
    const argv = ["report", kind],
      out = join(ctx.evidence, `checker-${kind}.csv`);
    const result = cli(clean, ...argv, "-o", out);
    const delivered = exportFile(ctx, path);
    files[path] =
      result.status === 0 && !!delivered.bytes?.equals(readFileSync(out));
    fallbacks.set(path, argv);
  }
  if (legacy("drawings/diagnostics.json")) {
    const diagnostic = query(clean, "diagnostics", "--json");
    files["drawings/diagnostics.json"] =
      canonical(safeRead("drawings/diagnostics.json")) ===
      canonical(diagnostic);
    fallbacks.set("drawings/diagnostics.json", ["diagnostics"]);
  }
  if (legacy("drawings/cable.json")) {
    const listing = safeRead("drawings/cable.json");
    files["drawings/cable.json"] = cableListingMatches(
      listing,
      sourceObjects,
      (designation) => query(clean, "cable", designation, "--json"),
    );
    if (files["drawings/cable.json"])
      fallbacks.set("drawings/cable.json", ["cable", listing.designation]);
  }
  if (legacy("drawings/review.json")) {
    const argv = ["review", "--before", conveyorBaseline];
    let reviewed = null;
    try {
      reviewed = query(clean, ...argv, "--json");
    } catch {}
    files["drawings/review.json"] =
      !!reviewed &&
      canonical(reviewed) === canonical(safeRead("drawings/review.json"));
    fallbacks.set("drawings/review.json", argv);
  }

  const required = conveyorOutputs(spec);
  const verified = new Map(bundle?.artifacts);
  if (
    !allowUnauditedConveyorReplay &&
    regenerated?.failure?.code === "missing-request"
  )
    for (const ext of formats)
      if (!regenerated.commands?.[ext])
        verified.set("drawings/packet." + ext, { status: "unverified" });
  const verify = (path) => {
    if (!verified.has(path)) {
      const fallback =
        fallbacks.get(path) ??
        views.get(
          path
            .split("/")
            .at(-1)
            .replace(/\.html$/, ".pdf"),
        )?.fallback;
      verified.set(
        path,
        verifyStandaloneExport(ctx, path, {
          matches: files[path],
          fallback,
        }),
      );
    }
    return verified.get(path);
  };
  for (const path of required) files[path] = verify(path).status === "current";
  const capture = hasCapture ? captureChain(ctx, verify) : null;
  files[conveyorBaseline] = !!safeRead(conveyorBaseline);
  const packet = bundle?.packet ?? regenerated?.packet;
  const packetFormats = {};
  const metaCache = new Map();
  const jsonArgv =
    bundle?.artifacts.get("drawings/packet.json")?.argv ??
    regenerated?.commands?.json;
  if (packet && jsonArgv) {
    const jsonKey = packetRecipeKey(clean.project, jsonArgv);
    if (jsonKey) metaCache.set(jsonKey, packet);
  }
  for (const ext of ["json", "html", "pdf"]) {
    if (ext === "json" && packet) {
      packetFormats.json = packet;
    } else if (regenerated?.packets?.[ext]) {
      packetFormats[ext] = regenerated.packets[ext];
    } else {
      const entryArgv = bundle?.artifacts.get(`drawings/packet.${ext}`)?.argv;
      packetFormats[ext] = entryArgv
        ? regeneratePacketMetadata(
            ctx,
            clean,
            entryArgv,
            `packet.${ext}`,
            metaCache,
          )
        : null;
    }
  }
  const counts = {
    localTypes: types.filter((t) => t.library !== "core").length,
    sourceReads: ctx.metrics?.sourceReads ?? 0,
    attemptedWrites: ctx.metrics?.attemptedWrites?.length ?? 0,
    failedCalls: (ctx.calls ?? []).filter(
      (c) => c.phase === "agent" && c.exit !== 0,
    ).length,
  };
  let drawEvidence = existsSync(join(ctx.evidence, "draw-evidence.json"))
    ? read(join(ctx.evidence, "draw-evidence.json"))
    : null;
  if (drawEvidence)
    for (const path of ["drawings/packet.pdf", "drawings/packet.html"]) {
      const { bytes } = exportFile(ctx, path);
      if (!bytes || drawEvidence.files?.[path] !== sha256(bytes))
        drawEvidence = { ...drawEvidence, V1: false, V5: false, stale: true };
    }
  const outcome = assessDogfood({
    task: ctx.task,
    promptVersion: ctx.promptVersion,
    validationExit: cli(clean, "validate", ".").status,
    files,
    packet,
    packetFormats,
    sourceObjects,
    types,
    calls: ctx.calls ?? [],
    matrix,
    drawEvidence,
    counts,
    diagnostics: ctx.validationDiagnostics ?? [],
  });
  const artifacts = Object.fromEntries(
    required.map((path) => [path, verified.get(path).status]),
  );
  const extras = Object.fromEntries(
    [...(bundle?.artifacts ?? [])]
      .filter(([path]) => !required.includes(path))
      .map(([path, { status }]) => [path, status]),
  );
  const status =
    bundle?.status === "current" || !bundle
      ? (["tampered", "missing", "stale", "unverified"].find((value) =>
          Object.values(artifacts).includes(value),
        ) ?? "current")
      : bundle.status;
  const usedBundle = bundle?.artifacts.size > 0;
  const usedStandalone =
    required.some(legacy) ||
    !!capture?.files.some(({ input }) => input && legacy(input));
  const packetFailure =
    regenerated?.failure ?? dogfoodBundlePacketFailure(ctx, bundle, verified);
  return {
    ...outcome,
    pass: outcome.pass && status === "current",
    exports: {
      route:
        usedBundle && usedStandalone
          ? "mixed"
          : usedBundle || bundle?.status === "invalid-request"
            ? "bundle"
            : "legacy",
      status,
      artifacts,
      ...(Object.keys(extras).length && { extras }),
      ...(bundle && { request: bundle.request, findings: bundle.findings }),
    },
    ...(packetFailure ? { packetFailure } : {}),
    ...(hasCapture
      ? { captureCurrent: capture.status === "current", capture }
      : {}),
  };
}
export function referenceDogfood(ctx) {
  prepareDogfoodProject(ctx, { exportDrawings: true });
  return "Reference deliverables are generated. The matrix distinguishes modeled requirements and disclosed substitutions from specific compiler/library gaps. Unfinished hookups and print-size visual checks remain explicit; this is not electrical approval.";
}

// Export tests supply their own delivery commands from the same source,
// packet request, and review baseline as the scripted reference.
export function prepareDogfoodProject(ctx, options = {}) {
  return runPrepareDogfoodProject(ctx, options);
}
