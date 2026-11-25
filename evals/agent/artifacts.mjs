import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute, relative, sep } from "node:path";
import { cli, read } from "./task-support.mjs";
import {
  assertConfinedProjectPaths,
  canonical,
  libraryTypes,
  sourceDocuments,
} from "./source-files.mjs";
import { copyConfinedTree, projectReader } from "./capture-files.mjs";
import { regenerateBundle } from "./conveyor-exports.mjs";
import { sha256 } from "./snapshot.mjs";
import {
  SYMBOL_PROFILES,
  symbolProfile,
} from "../../packages/schema/dist/index.js";
let pdfjs;
export async function pdfInfo(path) {
  try {
    return await parsePdf(readFileSync(path));
  } catch {
    return { valid: false, pages: 0, text: "", pageSizes: [] };
  }
}
async function parsePdf(bytes) {
  try {
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      return { valid: false, pages: 0, text: "", pageSizes: [] };
    pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      useSystemFonts: false,
      isEvalSupported: false,
      disableFontFace: true,
    });
    const doc = await task.promise;
    let text = "";
    const pages = doc.numPages;
    const pageSizes = [];
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      pageSizes.push({ width: viewport.width, height: viewport.height });
      text +=
        (await page.getTextContent()).items
          .map((item) => item.str ?? "")
          .join(" ") + "\n";
    }
    await task.destroy();
    return {
      valid: pages > 0 && text.trim().length > 0,
      pages,
      text,
      pageSizes,
    };
  } catch {
    return { valid: false, pages: 0, text: "", pageSizes: [] };
  }
}
export async function pdf(path) {
  return (await pdfInfo(path)).valid;
}
export function cleanChecker(ctx) {
  if (ctx.clean) return ctx.clean;
  const project = join(ctx.evidence, "checker-input");
  const source = projectReader(ctx.project);
  try {
    copyConfinedTree(source, project);
    assertConfinedProjectPaths(project);
  } finally {
    source.close();
  }
  mkdirSync(join(project, "drawings"), { recursive: true });
  ctx.clean = { ...ctx, project };
  return ctx.clean;
}
const printSwitches = new Set(["--index", "--json"]);
const printValues = new Set([
  "--input",
  "--project",
  "-o",
  "--output",
  "--paper",
  "--orientation",
  "--layout",
  "--margin",
]);
const reportValues = new Set(["--device", "--filter"]);
const diagnosticValues = new Set(["--device", "--location"]);
const standaloneCommands = [
  "view",
  "packet",
  "report",
  "diagnostics",
  "cable",
  "review",
];
const viewSwitches = new Set([
  "--power",
  "--actuation",
  "--loads",
  "--conductors",
  "--include-power",
]);
const viewValues = new Set(["--to", "--flow"]);

// Rebuild a standalone export invocation from its allowed options. File arguments
// are always supplied by the checker or resolved inside its staged copy.
function parseStandaloneExport(argv) {
  if (
    !Array.isArray(argv) ||
    !argv.every((arg) => typeof arg === "string") ||
    !standaloneCommands.includes(argv[0])
  )
    return null;
  const kind = argv[0],
    view = kind === "view",
    report = kind === "report",
    hasRoot = view || report || kind === "cable",
    options = [],
    files = {};
  let root;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (hasRoot && !root && !arg.startsWith("-")) {
      root = arg;
      continue;
    }
    if (
      printSwitches.has(arg) ||
      (view ? viewSwitches.has(arg) : !report && arg === "--strict")
    ) {
      options.push(arg);
      continue;
    }
    const equals = arg.indexOf("="),
      key = equals < 0 ? arg : arg.slice(0, equals);
    if (arg === "--receipt") continue;
    if (
      !printValues.has(key) &&
      !(view && viewValues.has(key)) &&
      !(report && reportValues.has(key)) &&
      !(kind === "diagnostics" && diagnosticValues.has(key)) &&
      !(kind === "review" && key === "--before")
    )
      return null;
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (!value || (value.startsWith("-") && value !== "-")) return null;
    if (key === "-o" || key === "--output") files.output = value;
    else if (key === "--project") files.project = value;
    else if (key === "--input" && kind === "packet") files.input = value;
    else if (key === "--input") return null;
    else if (key === "--filter" || key === "--before")
      files[key.slice(2)] = value;
    else options.push(key, value);
  }
  if (
    (hasRoot && !root) ||
    (kind === "packet" && !files.input) ||
    (kind === "review" && !files.before)
  )
    return null;
  return { argv: [kind, ...(root ? [root] : []), ...options], ...files };
}
export function standaloneExportArtifact(
  call,
  root,
  kinds = standaloneCommands,
) {
  if (
    call?.phase === "flush" ||
    call?.exit !== 0 ||
    !kinds.includes(call.argv?.[0])
  )
    return null;
  const parsed = parseStandaloneExport(call.argv);
  if (!parsed?.output) return null;
  if (parsed.project && resolve(root, parsed.project) !== resolve(root))
    return null;
  const rel = relative(root, resolve(root, parsed.output));
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    return null;
  return {
    path: rel.replaceAll("\\", "/"),
    parsed,
    call,
  };
}
export function standaloneExportCall(
  ctx,
  artifact,
  kinds = standaloneCommands,
) {
  const project = ctx.originalProject ?? ctx.project;
  for (const call of [...(ctx.calls ?? [])].reverse()) {
    if (
      call?.phase === "flush" ||
      call?.exit !== 0 ||
      !kinds.includes(call.argv?.[0])
    )
      continue;
    const parsed = parseStandaloneExport(call.argv);
    if (
      parsed?.output &&
      resolve(project, parsed.output) === resolve(project, artifact)
    )
      return call;
  }
}
function commandFor(ctx, artifact, fallback, kinds = ["view", "packet"]) {
  const call = standaloneExportCall(ctx, artifact, kinds);
  if (call)
    return {
      parsed: parseStandaloneExport(call.argv),
      argv: call.argv,
      request: call.request,
    };
  return fallback
    ? { parsed: parseStandaloneExport(fallback), argv: fallback }
    : null;
}
function remap(command, ctx, out, receipt = false, finalInput = false) {
  const parsed = command?.parsed;
  if (!parsed) return null;
  const project = ctx.originalProject ?? ctx.project,
    clean = cleanChecker(ctx),
    result = [...parsed.argv];
  if (parsed.project && resolve(project, parsed.project) !== project)
    return null;
  if (parsed.input) {
    const path = relative(project, resolve(project, parsed.input));
    if (
      !path ||
      path === ".." ||
      path.startsWith(".." + sep) ||
      isAbsolute(path)
    )
      return null;
    if (receipt || (finalInput && parsed.input !== "-")) {
      if (parsed.input === "-") return null;
      result.push("--input", join(clean.project, path));
    } else if (typeof command.request === "string") {
      const request = out + ".request.json";
      writeFileSync(request, command.request);
      result.push("--input", request);
    } else if (parsed.input !== "-") {
      result.push("--input", join(clean.project, path));
    } else return null;
  }
  for (const key of ["filter", "before"]) {
    if (!parsed[key]) continue;
    const path = relative(project, resolve(project, parsed[key]));
    if (
      !path ||
      path === ".." ||
      path.startsWith(".." + sep) ||
      isAbsolute(path)
    )
      return null;
    result.push("--" + key, join(clean.project, path));
  }
  return [
    ...result,
    "--project",
    clean.project,
    "-o",
    out,
    ...(receipt ? ["--receipt"] : []),
  ];
}
export function deliveredBytes(ctx, artifact) {
  const source = projectReader(ctx.project);
  try {
    return source.read(artifact);
  } finally {
    source.close();
  }
}
export function replayExport(ctx, artifact, fallback, receipt = false) {
  const command = commandFor(
    ctx,
    artifact,
    fallback,
    fallback && !["view", "packet"].includes(fallback[0])
      ? []
      : standaloneCommands,
  );
  const output = join(ctx.evidence, "regenerated-export", artifact);
  try {
    mkdirSync(join(output, ".."), { recursive: true });
    const mapped = remap(command, ctx, output, receipt, true);
    if (!mapped || cli(cleanChecker(ctx), ...mapped).status !== 0) return null;
    return {
      bytes: readFileSync(output),
      ...(receipt && { receipt: readFileSync(output + ".receipt.json") }),
    };
  } catch {
    return null;
  }
}
export async function deliveredPdfInfo(ctx, artifact) {
  try {
    return await parsePdf(deliveredBytes(ctx, artifact));
  } catch {
    return { valid: false, pages: 0, text: "", pageSizes: [] };
  }
}
export async function deliveredPdf(ctx, artifact) {
  return (await deliveredPdfInfo(ctx, artifact)).valid;
}
const isAnalogInputRole = (role) =>
  typeof role === "string" && /analog.?input/i.test(role);

function transmitterTerminals(type, referencedFunctions) {
  const profile = SYMBOL_PROFILES.find((p) => p.id === symbolProfile(type));
  const hasProfile = !!profile?.support.some(
    (s) => s.family === "signal-loop" && s.role === "from",
  );
  const entries = Object.entries(type.terminals ?? {});
  const pos = entries
    .filter(([, t]) => t?.role === "loop_positive")
    .map(([k]) => k);
  const neg = entries
    .filter(([, t]) => t?.role === "loop_negative")
    .map(([k]) => k);
  const hasLoopRoles = pos.length > 0 && neg.length > 0;
  if (!hasProfile && !hasLoopRoles) return new Set();
  const fns = type.functions ?? {};
  const result = new Set();
  if (referencedFunctions.length) {
    for (const key of referencedFunctions) {
      const terms = fns[key]?.terminals ?? [];
      if (
        terms.length === 2 ||
        terms.some((t) => pos.includes(t) || neg.includes(t))
      )
        for (const t of terms) result.add(t);
    }
    return result;
  }
  for (const fn of Object.values(fns))
    if (fn?.terminals?.length === 2)
      for (const t of fn.terminals) result.add(t);
  for (const t of [...pos, ...neg]) result.add(t);
  return result;
}

function analogInputTerminals(type, referencedFunctions) {
  const fns = type.functions ?? {};
  const isAiFn = (fn) =>
    (fn?.kind === "channel" &&
      fn?.direction === "input" &&
      fn?.terminals?.length === 2) ||
    (fn?.terminals ?? []).some((k) =>
      isAnalogInputRole(type.terminals?.[k]?.role),
    );
  const result = new Set();
  if (referencedFunctions.length) {
    for (const key of referencedFunctions)
      if (isAiFn(fns[key]))
        for (const t of fns[key].terminals ?? []) result.add(t);
    return result;
  }
  for (const fn of Object.values(fns))
    if (isAiFn(fn)) for (const t of fn.terminals ?? []) result.add(t);
  for (const [k, t] of Object.entries(type.terminals ?? {}))
    if (isAnalogInputRole(t?.role)) result.add(k);
  return result;
}

function roleTerminals(type, role, referencedFunctions) {
  if (!type) return new Set();
  if (role === "two-wire-transmitter")
    return transmitterTerminals(type, referencedFunctions);
  if (role === "analog-input")
    return analogInputTerminals(type, referencedFunctions);
  return new Set();
}

function terminalsConnected(conductors, starts, targets) {
  if (!starts.size || !targets.size) return false;
  const termId = (t) => JSON.stringify([t.deviceUid, t.terminalKey]);
  const adjacent = new Map();
  for (const conductor of conductors) {
    const ends = conductor?.terminals;
    if (!Array.isArray(ends) || ends.length !== 2) continue;
    const a = termId(ends[0]),
      b = termId(ends[1]);
    if (!adjacent.has(a)) adjacent.set(a, []);
    if (!adjacent.has(b)) adjacent.set(b, []);
    adjacent.get(a).push(b);
    adjacent.get(b).push(a);
  }
  const queue = [...starts],
    visited = new Set(starts);
  for (const current of queue) {
    if (targets.has(current)) return true;
    for (const next of adjacent.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
}

function hasDistinctRoleDevices(groups, index = 0, used = new Set()) {
  if (index >= groups.length) return true;
  for (const uid of groups[index].keys()) {
    if (used.has(uid)) continue;
    used.add(uid);
    if (hasDistinctRoleDevices(groups, index + 1, used)) return true;
    used.delete(uid);
  }
  return false;
}

function matchesAllowedKindSheet(packet, sheet, expected, objectMap, typeMap) {
  const refs = sheet.references ?? [];
  if (
    expected.roots?.length &&
    !expected.roots.includes(sheet.view?.root?.designation) &&
    !refs.some((ref) => expected.roots.includes(ref.designation))
  )
    return false;
  const roles = expected.requiredRoles ?? [];
  if (!roles.length) return true;
  const groups = roles.map((role) => {
    const byUid = new Map();
    for (const ref of refs) {
      const object = objectMap.get(ref.designation);
      const uid = ref.deviceUid ?? object?.uid;
      if (!uid) continue;
      const terms = roleTerminals(
        typeMap.get(object?.type),
        role,
        ref.functions ?? [],
      );
      if (!terms.size) continue;
      const bucket = byUid.get(uid) ?? new Set();
      for (const t of terms) bucket.add(JSON.stringify([uid, t]));
      byUid.set(uid, bucket);
    }
    return byUid;
  });
  if (groups.some((g) => g.size === 0)) return false;
  if (!expected.requireConnected || groups.length < 2)
    return hasDistinctRoleDevices(groups);
  const allConductors = packet?.coverage?.conductors ?? [];
  const conductors = ["wiring", "circuit"].includes(sheet.view?.kind)
    ? allConductors.filter((c) =>
        c.appearances?.some((a) => a.sheet === sheet.number),
      )
    : allConductors;
  const [first, second] = groups;
  for (const [uidA, termsA] of first)
    for (const [uidB, termsB] of second)
      if (uidA !== uidB && terminalsConnected(conductors, termsA, termsB))
        return true;
  return false;
}

function sheetMatchesExpected(
  packet,
  sheet,
  expected,
  { kind, roots, objectMap, typeMap },
) {
  const view = sheet.view ?? {},
    intent = typeof view.intent === "string" ? view.intent : view.intent?.kind;
  if (expected.allowedKinds?.includes(view.kind))
    return matchesAllowedKindSheet(packet, sheet, expected, objectMap, typeMap);
  if (
    roots.includes(view.root?.designation) &&
    (kind === "power" || kind === "control"
      ? view.family === kind
      : intent === kind)
  )
    return true;
  if (view.kind !== "circuit") return false;
  const functionKind =
    kind === "control"
      ? "coil"
      : kind === "power"
        ? "load"
        : kind === "loads"
          ? "source"
          : null;
  return (
    functionKind &&
    sheet.references?.some(
      (ref) =>
        roots.includes(ref.designation) &&
        ref.functions?.some(
          (key) =>
            typeMap.get(objectMap.get(ref.designation)?.type)?.functions?.[key]
              ?.kind === functionKind,
        ),
    )
  );
}

export async function regenerateView(ctx, artifact, fallback, expected = {}) {
  const command = commandFor(ctx, artifact, fallback);
  if (!command) return { pass: false, reason: "missing-view-command" };
  const clean = cleanChecker(ctx),
    output = join(ctx.evidence, "regenerated-" + artifact.split("/").at(-1));
  const mapped = remap(command, ctx, output);
  if (!mapped) return { pass: false, reason: "missing-input-request" };
  const kind =
    expected.kind ??
    (fallback?.includes("--actuation")
      ? "control"
      : fallback?.includes("--power")
        ? "power"
        : fallback?.includes("--loads")
          ? "loads"
          : fallback?.includes("--conductors")
            ? "conductors"
            : null);
  const roots =
    expected.roots ?? (fallback?.[0] === "view" ? [fallback[1]] : []);
  const metaOutput = output + ".json",
    metaMapped = remap(command, ctx, metaOutput),
    metadata = metaMapped ? cli(clean, ...metaMapped) : null;
  let packet;
  try {
    packet = metadata?.status === 0 ? read(metaOutput) : null;
  } catch {}
  const typeMap = new Map(libraryTypes(clean.project).map((t) => [t.id, t])),
    objectMap = new Map(
      sourceDocuments(clean.project)
        .flatMap((d) => d.objects)
        .map((o) => [o.designation, o]),
    );
  const matches =
    packet?.sheets?.some((sheet) =>
      sheetMatchesExpected(packet, sheet, expected, {
        kind,
        roots,
        objectMap,
        typeMap,
      }),
    ) ?? false;
  if (!matches)
    return {
      pass: false,
      reason: "view-metadata-mismatch",
      exit: metadata?.status ?? null,
    };
  const result = cli(clean, ...mapped);
  let pass = false;
  if (result.status === 0)
    try {
      const delivered = deliveredBytes(ctx, artifact);
      pass =
        readFileSync(output).equals(delivered) &&
        (await parsePdf(delivered)).valid;
    } catch {}
  return { pass, exit: result.status };
}
// The judge receives delivered files from the top level of drawings/.
export async function findRegeneratedView(ctx, expected) {
  const source = projectReader(ctx.project);
  let pdfs;
  try {
    pdfs = source
      .list("drawings")
      .filter((name) => name.endsWith(".pdf"))
      .sort();
  } catch {
    return null;
  } finally {
    source.close();
  }
  for (const name of pdfs) {
    const artifact = `drawings/${name}`;
    if ((await regenerateView(ctx, artifact, null, expected)).pass)
      return artifact;
  }
  return null;
}
function observedPacketInvocations(ctx) {
  return (ctx.calls ?? [])
    .filter(
      (call) =>
        call?.phase !== "flush" &&
        Array.isArray(call?.argv) &&
        (call.argv[0] === "packet" ||
          (call.argv[0] === "export" && call.argv[1] === "bundle")),
    )
    .map((call) => `exit=${call.exit} ${call.argv.join(" ")}`);
}

export function packetFailureReport({
  ctx,
  name = "packet",
  formats = ["json", "pdf", "html"],
  request = null,
  bundle = null,
  deliveredRequests = new Map(),
  candidateInputs = [],
  missingFormats = [],
  stdinFormats = [],
  outsideInputs = [],
  failedRegens = [],
  changedRequests = [],
  replacedOutputs = [],
  reboundBundles = [],
  mismatchedBound = [],
  matches = {},
}) {
  const artifacts = formats.map((ext) => `drawings/${name}.${ext}`);
  const nestedBundleInputs = [
    ...new Set([
      ...(bundle?.nestedInputs ?? []),
      ...[...(bundle?.artifacts?.values() ?? [])].flatMap((entry) => [
        ...(entry.packetInput ? [entry.packetInput] : []),
        ...(entry.auditedPacketInput ? [entry.auditedPacketInput] : []),
      ]),
    ]),
  ];
  const searchedInvocations = [
    "export bundle --out-dir drawings",
    ...artifacts.map((artifact) => `packet -o ${artifact}`),
    ...observedPacketInvocations(ctx),
  ];
  const searchedPaths = [
    ...new Set([
      ...(bundle?.request ? [bundle.request] : []),
      ...(bundle?.authored ? [bundle.authored] : []),
      ...nestedBundleInputs,
      ...(bundle?.outsideInputs ?? []),
      ...candidateInputs,
      ...deliveredRequests.values(),
      ...outsideInputs,
      ...(request ? [request] : []),
      ...artifacts,
    ]),
  ];
  const distinct = [...new Set(deliveredRequests.values())];
  const failedFormats = formats.filter((ext) => !matches[ext]);
  const scope = `Searched invocations [${searchedInvocations.join("; ")}] and paths [${searchedPaths.join(", ")}].`;
  let code = "byte-mismatch",
    message = `Packet outputs failed byte-equal verification (${failedFormats.join(", ")}). ${scope}`;
  if (outsideInputs.length || bundle?.outsideProject) {
    const rejected = [
      ...new Set([
        ...outsideInputs,
        ...(bundle?.outsideInputs ?? []),
        ...(!outsideInputs.length &&
        !(bundle?.outsideInputs ?? []).length &&
        bundle?.authored
          ? [bundle.authored]
          : []),
      ]),
    ];
    code = "outside-project-request";
    message = `Packet request outside project root (${rejected.join(", ") || "bundle input"}). ${scope}`;
  } else if (bundle && bundle.status !== "current" && !distinct.length) {
    code = "invalid-bundle-request";
    const detail = bundle.findings?.[0]?.message ?? bundle.status;
    message = `Bundle packet request failed (${detail}). ${scope}`;
  } else if (reboundBundles.length) {
    code = "rebound-bundle-request";
    message = `Bundle plan changed after audited publication for ${reboundBundles.join(", ")}. ${scope}`;
  } else if (changedRequests.length) {
    code = "request-changed";
    message = `Saved packet request changed after audited publication for ${changedRequests.join(", ")}. ${scope}`;
  } else if (replacedOutputs.length) {
    code = "published-output-mismatch";
    message = `Delivered packet outputs differ from audited publication for ${replacedOutputs.join(", ")}. ${scope}`;
  } else if (distinct.length > 1 || mismatchedBound.length) {
    code = "mismatched-request";
    const inputs = [...new Set([...distinct, ...mismatchedBound])];
    message = `Packet outputs came from different requests (${inputs.join(", ")}). ${scope}`;
  } else if (missingFormats.length || stdinFormats.length) {
    code = "missing-request";
    const missing = [...missingFormats, ...stdinFormats];
    message = `No locatable project-local packet request for ${missing.join(", ")}. ${scope}`;
  } else if (failedRegens.length) {
    code = "regeneration-failed";
    message = `Packet regeneration failed for ${failedRegens.map((r) => `${r.artifact} (input ${r.input}, exit ${r.exit})`).join(", ")}. ${scope}`;
  }
  return {
    code,
    message,
    searched: {
      invocations: searchedInvocations,
      paths: searchedPaths,
      ...(nestedBundleInputs.length ? { nestedBundleInputs } : {}),
    },
  };
}

async function compareOnePacketArtifact(ctx, artifact, output, exactJson) {
  try {
    const delivered = deliveredBytes(ctx, artifact);
    if (artifact.endsWith(".json") && !exactJson)
      return canonical(JSON.parse(delivered)) === canonical(read(output));
    return (
      readFileSync(output).equals(delivered) &&
      (!artifact.endsWith(".pdf") || (await pdf(output)))
    );
  } catch {
    return false;
  }
}

const packetOptionFlags = new Set([
  "--paper",
  "--orientation",
  "--margin",
  "--layout",
]);
const packetSwitchFlags = new Set(["--index", "--strict"]);

export function packetRecipeKey(cleanProject, argv) {
  if (!Array.isArray(argv) || argv[0] !== "packet") return null;
  let input = null;
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (packetSwitchFlags.has(arg)) {
      opts[arg] = true;
      continue;
    }
    if (arg === "--json" || arg === "--receipt") continue;
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg : arg.slice(0, equals);
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (key === "--input") {
      if (!value || value === "-") return null;
      input = relative(cleanProject, resolve(cleanProject, value)).replaceAll(
        "\\",
        "/",
      );
    } else if (packetOptionFlags.has(key)) {
      opts[key] = value;
    }
  }
  return input ? canonical({ input, opts }) : null;
}

export function regeneratePacketMetadata(
  ctx,
  clean,
  recipeArgv,
  metaName,
  cache = new Map(),
) {
  const key = packetRecipeKey(clean.project, recipeArgv);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const args = [];
  for (let i = 0; i < recipeArgv.length; i++) {
    const arg = recipeArgv[i];
    if (arg === "--receipt") continue;
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (["-o", "--output", "--project"].includes(flag)) {
      if (equals < 0) i++;
      continue;
    }
    args.push(arg);
  }
  const out = join(ctx.evidence, "checker-meta", `${metaName}.json`);
  mkdirSync(join(out, ".."), { recursive: true });
  const result = cli(clean, ...args, "--project", clean.project, "-o", out);
  let parsed = null;
  if (result.status === 0) {
    try {
      parsed = read(out);
    } catch {}
  }
  cache.set(key, parsed);
  return parsed;
}

function standalonePacketCommand(
  ctx,
  artifact,
  request,
  { allowUnauditedFallback = false } = {},
) {
  const latest = standaloneExportCall(ctx, artifact);
  if (latest) {
    if (latest.argv?.[0] !== "packet") return null;
    return {
      call: latest,
      parsed: parseStandaloneExport(latest.argv),
      argv: latest.argv,
      request: latest.request,
    };
  }
  if (!allowUnauditedFallback || !request) return null;
  const fallback = ["packet", "--input", request, "-o", artifact];
  return { parsed: parseStandaloneExport(fallback), argv: fallback };
}

function checkStandaloneProvenance(ctx, call, artifact, input) {
  if (!call)
    return {
      ok: true,
      requestChanged: false,
      outputReplaced: false,
      outside: null,
    };
  let savedRequestBytes;
  try {
    savedRequestBytes = deliveredBytes(ctx, input);
  } catch (error) {
    return {
      ok: false,
      requestChanged: error?.code === "ENOENT",
      outputReplaced: false,
      outside: error?.code !== "ENOENT" ? input : null,
    };
  }
  const savedRequestHash = sha256(savedRequestBytes);
  const requestChanged =
    call.request === null ||
    (typeof call.request === "string" &&
      sha256(call.request) !== savedRequestHash) ||
    (!!call.after?.files &&
      Object.hasOwn(call.after.files, input) &&
      call.after.files[input] !== savedRequestHash);
  let outputReplaced = false;
  if (call.after?.files) {
    const published = call.after.files[artifact];
    try {
      const delivered = deliveredBytes(ctx, artifact);
      outputReplaced = !published || published !== sha256(delivered);
    } catch {
      outputReplaced = true;
    }
  }
  return {
    ok: !requestChanged && !outputReplaced,
    requestChanged,
    outputReplaced,
    outside: null,
  };
}

async function regenerateOneStandaloneFormat(
  ctx,
  clean,
  project,
  {
    artifact,
    output,
    ext,
    request,
    bindRequest,
    allowUnauditedFallback,
    commands,
  },
) {
  const command = standalonePacketCommand(ctx, artifact, request, {
    allowUnauditedFallback,
  });
  if (!command?.parsed) return { missing: true, match: false };
  commands[ext] = command.argv;
  const rawInput = command.parsed.input,
    isStdin = rawInput === "-";
  const rel = isStdin ? null : relative(project, resolve(project, rawInput));
  if (
    !isStdin &&
    (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
  )
    return {
      used: true,
      outside: rawInput,
      candidateInput: rawInput,
      match: false,
    };
  const input = isStdin ? "-" : rel.replaceAll("\\", "/");
  const candidateInput = isStdin ? null : input;
  const requestMismatch =
    bindRequest &&
    (isStdin || resolve(project, rawInput) !== resolve(project, request));
  const provenance = isStdin
    ? { ok: false, requestChanged: false, outputReplaced: false, outside: null }
    : checkStandaloneProvenance(ctx, command.call, artifact, input);
  if (provenance.outside)
    return {
      used: true,
      outside: provenance.outside,
      candidateInput,
      match: false,
    };
  if (bindRequest) command.parsed.input = request;
  const mapped = remap(command, ctx, output, false, true);
  if (!mapped)
    return {
      used: true,
      candidateInput,
      requestChanged: provenance.requestChanged,
      outputReplaced: provenance.outputReplaced,
      match: false,
    };
  const result = cli(clean, ...mapped);
  if (result.status !== 0)
    return {
      used: true,
      stdin: isStdin,
      candidateInput,
      requestChanged: provenance.requestChanged,
      outputReplaced: provenance.outputReplaced,
      failed: { artifact, input, exit: result.status },
      match: false,
    };
  const packet = ext === "json" ? read(output) : null;
  const bound = !isStdin && !requestMismatch && provenance.ok;
  return {
    used: true,
    stdin: isStdin,
    candidateInput,
    deliveredInput: isStdin ? null : input,
    requestMismatch,
    requestChanged: provenance.requestChanged,
    outputReplaced: provenance.outputReplaced,
    packet,
    recipeArgv: mapped,
    match:
      bound && (await compareOnePacketArtifact(ctx, artifact, output, true)),
  };
}

async function regenerateStandaloneFormats(
  ctx,
  {
    name,
    formats,
    request,
    bindRequest,
    allowUnauditedFallback,
    prefix,
    bundleHandled,
    commands,
    recipeArgvs,
  },
) {
  const clean = cleanChecker(ctx),
    project = ctx.originalProject ?? ctx.project;
  const matches = {},
    deliveredRequests = new Map(),
    candidateInputs = [],
    missingFormats = [],
    stdinFormats = [],
    outsideInputs = [],
    failedRegens = [],
    changedRequests = [],
    replacedOutputs = [],
    mismatchedBound = [];
  let packet = null,
    usedStandalone = false;
  for (const ext of formats) {
    if (bundleHandled.has(ext)) continue;
    const artifact = `drawings/${name}.${ext}`;
    const step = await regenerateOneStandaloneFormat(ctx, clean, project, {
      artifact,
      output: `${prefix}.${ext}`,
      ext,
      request,
      bindRequest,
      allowUnauditedFallback,
      commands,
    });
    matches[ext] = step.match;
    if (step.used) usedStandalone = true;
    if (step.candidateInput) candidateInputs.push(step.candidateInput);
    if (step.missing) missingFormats.push(artifact);
    if (step.stdin) stdinFormats.push(artifact);
    if (step.outside) outsideInputs.push(step.outside);
    if (step.failed) failedRegens.push(step.failed);
    if (step.requestChanged) changedRequests.push(artifact);
    if (step.outputReplaced) replacedOutputs.push(artifact);
    if (step.requestMismatch && step.deliveredInput)
      mismatchedBound.push(step.deliveredInput);
    if (step.deliveredInput) deliveredRequests.set(ext, step.deliveredInput);
    if (step.recipeArgv) recipeArgvs[ext] = step.recipeArgv;
    if (step.packet) packet = step.packet;
  }
  return {
    matches,
    packet,
    deliveredRequests,
    candidateInputs,
    missingFormats,
    stdinFormats,
    outsideInputs,
    failedRegens,
    changedRequests,
    replacedOutputs,
    mismatchedBound,
    usedStandalone,
  };
}

export async function regeneratePacket(
  ctx,
  {
    request = null,
    name = "packet",
    formats = ["json", "pdf", "html"],
    bindRequest = false,
    allowBundle = true,
    allowUnauditedFallback = false,
  } = {},
) {
  const prefix = join(ctx.evidence, `regenerated-${name}`),
    commands = {},
    recipeArgvs = {},
    matches = {},
    deliveredRequests = new Map(),
    bundleHandled = new Set(),
    reboundBundles = [],
    bundleChangedRequests = [],
    bundleReplacedOutputs = [],
    targetPaths = new Set(formats.map((ext) => `drawings/${name}.${ext}`));
  let packet = null;
  const bundle = allowBundle
    ? await regenerateBundle(ctx, {
        required: targetPaths,
        packetPaths: targetPaths,
        packetJsonPath: `drawings/${name}.json`,
        packetRequest: bindRequest ? request : null,
        onlyPaths: targetPaths,
        allowManifestFallback: false,
      })
    : null;
  for (const ext of formats) {
    const artifact = `drawings/${name}.${ext}`;
    const entry = bundle?.artifacts.get(artifact);
    if (!entry) continue;
    bundleHandled.add(ext);
    if (entry.argv) {
      commands[ext] = entry.argv;
      recipeArgvs[ext] = entry.argv;
    }
    matches[ext] = bundle.status === "current" && entry.status === "current";
    if (entry.planRebound) reboundBundles.push(artifact);
    if (entry.changedDependency) bundleChangedRequests.push(artifact);
    if (entry.changedBytes) bundleReplacedOutputs.push(artifact);
    if (entry.packetInput) deliveredRequests.set(ext, entry.packetInput);
    if (ext === "json" && bundle.packet) packet = bundle.packet;
  }
  const standalone = await regenerateStandaloneFormats(ctx, {
    name,
    formats,
    request,
    bindRequest,
    allowUnauditedFallback,
    prefix,
    bundleHandled,
    commands,
    recipeArgvs,
  });
  Object.assign(matches, standalone.matches);
  if (!packet && standalone.packet) packet = standalone.packet;
  for (const [ext, input] of standalone.deliveredRequests)
    deliveredRequests.set(ext, input);
  const packets = {};
  const metaCache = new Map();
  if (formats.some((ext) => recipeArgvs[ext])) {
    const clean = cleanChecker(ctx);
    if (packet && recipeArgvs.json) {
      const jsonKey = packetRecipeKey(clean.project, recipeArgvs.json);
      if (jsonKey) metaCache.set(jsonKey, packet);
    }
    for (const ext of formats) {
      if (ext === "json" && packet) {
        packets.json = packet;
        continue;
      }
      packets[ext] = recipeArgvs[ext]
        ? regeneratePacketMetadata(
            ctx,
            clean,
            recipeArgvs[ext],
            `${name}.${ext}`,
            metaCache,
          )
        : null;
    }
  }
  const distinctRequests = [...new Set(deliveredRequests.values())];
  if (!bindRequest && distinctRequests.length > 1)
    for (const ext of formats) matches[ext] = false;
  const pass =
    formats.every((ext) => matches[ext] === true) &&
    (bindRequest || distinctRequests.length <= 1) &&
    (!bundle || bundle.status === "current" || bundleHandled.size === 0);
  const usedBundle = bundleHandled.size > 0;
  const route =
    usedBundle && standalone.usedStandalone
      ? "mixed"
      : usedBundle ||
          bundle?.status === "invalid-request" ||
          bundle?.status === "tampered"
        ? "bundle"
        : standalone.usedStandalone
          ? "legacy"
          : "none";
  const failure = pass
    ? null
    : packetFailureReport({
        ctx,
        name,
        formats,
        request,
        bundle,
        deliveredRequests,
        candidateInputs: standalone.candidateInputs,
        missingFormats: standalone.missingFormats,
        stdinFormats: standalone.stdinFormats,
        outsideInputs: standalone.outsideInputs,
        failedRegens: standalone.failedRegens,
        changedRequests: [
          ...bundleChangedRequests,
          ...standalone.changedRequests,
        ],
        replacedOutputs: [
          ...bundleReplacedOutputs,
          ...standalone.replacedOutputs,
        ],
        reboundBundles,
        mismatchedBound: standalone.mismatchedBound,
        matches,
      });
  return {
    pass,
    route,
    request: distinctRequests.length === 1 ? distinctRequests[0] : null,
    bundleRequest: bundle?.request ?? null,
    matches,
    packet,
    packets,
    commands,
    prefix,
    ...(failure ? { failure } : {}),
  };
}
export async function comparePacketArtifacts(
  ctx,
  {
    name = "packet",
    prefix = join(ctx.evidence, `regenerated-${name}`),
    exactJson = false,
  } = {},
) {
  const matches = {};
  for (const ext of ["json", "pdf", "html"])
    matches[ext] = await compareOnePacketArtifact(
      ctx,
      `drawings/${name}.${ext}`,
      `${prefix}.${ext}`,
      exactJson,
    );
  return { pass: Object.values(matches).every(Boolean), matches };
}
