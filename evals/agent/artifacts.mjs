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
let pdfjs;
export async function pdfInfo(path) {
  try {
    return await parsePdf(readFileSync(path));
  } catch {
    return { valid: false, pages: 0, text: "" };
  }
}
async function parsePdf(bytes) {
  try {
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      return { valid: false, pages: 0, text: "" };
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
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      text +=
        (await page.getTextContent()).items
          .map((item) => item.str ?? "")
          .join(" ") + "\n";
    }
    await task.destroy();
    return { valid: pages > 0 && text.trim().length > 0, pages, text };
  } catch {
    return { valid: false, pages: 0, text: "" };
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
export async function deliveredPdf(ctx, artifact) {
  try {
    return (await parsePdf(deliveredBytes(ctx, artifact))).valid;
  } catch {
    return false;
  }
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
    packet?.sheets?.some((sheet) => {
      const view = sheet.view ?? {},
        intent =
          typeof view.intent === "string" ? view.intent : view.intent?.kind;
      if (expected.allowedKinds?.includes(view.kind)) return true;
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
                typeMap.get(objectMap.get(ref.designation)?.type)?.functions?.[
                  key
                ]?.kind === functionKind,
            ),
        )
      );
    }) ?? false;
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

function packetFailureReport({
  ctx,
  name,
  formats,
  request,
  bundle,
  deliveredRequests,
  missingFormats,
  stdinFormats,
  outsideInputs,
  failedRegens,
  matches,
}) {
  const artifacts = formats.map((ext) => `drawings/${name}.${ext}`);
  const searchedInvocations = [
    "export bundle --out-dir drawings",
    ...artifacts.map((artifact) => `packet -o ${artifact}`),
    ...observedPacketInvocations(ctx),
  ];
  const searchedPaths = [
    ...new Set([
      ...(bundle?.request ? [bundle.request] : []),
      ...(bundle?.authored ? [bundle.authored] : []),
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
      ...outsideInputs,
      ...(bundle?.outsideProject && bundle.authored ? [bundle.authored] : []),
    ];
    code = "outside-project-request";
    message = `Packet request outside project root (${rejected.join(", ") || "bundle input"}). ${scope}`;
  } else if (bundle && bundle.status !== "current" && !distinct.length) {
    code = "invalid-bundle-request";
    const detail = bundle.findings?.[0]?.message ?? bundle.status;
    message = `Bundle packet request failed (${detail}). ${scope}`;
  } else if (distinct.length > 1) {
    code = "mismatched-request";
    message = `Packet outputs came from different requests (${distinct.join(", ")}). ${scope}`;
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
    searched: { invocations: searchedInvocations, paths: searchedPaths },
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

function standalonePacketCommand(ctx, artifact, request) {
  const call = standaloneExportCall(ctx, artifact, ["packet"]);
  if (call)
    return {
      parsed: parseStandaloneExport(call.argv),
      argv: call.argv,
      request: call.request,
    };
  if (!request) return null;
  const fallback = ["packet", "--input", request, "-o", artifact];
  return { parsed: parseStandaloneExport(fallback), argv: fallback };
}

async function regenerateOneStandaloneFormat(
  ctx,
  clean,
  project,
  { artifact, output, ext, request, bindRequest, commands },
) {
  const command = standalonePacketCommand(ctx, artifact, request);
  if (!command?.parsed) return { missing: true, match: false };
  commands[ext] = command.argv;
  const rawInput = command.parsed.input,
    isStdin = rawInput === "-";
  const rel = isStdin ? null : relative(project, resolve(project, rawInput));
  if (
    !isStdin &&
    (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
  )
    return { used: true, outside: rawInput, match: false };
  const requestMismatch =
    bindRequest &&
    (isStdin || resolve(project, rawInput) !== resolve(project, request));
  if (bindRequest) command.parsed.input = request;
  const mapped = remap(command, ctx, output, false, true);
  if (!mapped) return { used: true, match: false };
  const result = cli(clean, ...mapped);
  const input = isStdin ? "-" : rel.replaceAll("\\", "/");
  if (result.status !== 0)
    return {
      used: true,
      stdin: isStdin,
      failed: { artifact, input, exit: result.status },
      match: false,
    };
  const packet = ext === "json" ? read(output) : null;
  const bound = !isStdin && !requestMismatch;
  return {
    used: true,
    stdin: isStdin,
    deliveredInput: isStdin ? null : input,
    packet,
    match:
      bound && (await compareOnePacketArtifact(ctx, artifact, output, true)),
  };
}

async function regenerateStandaloneFormats(
  ctx,
  { name, formats, request, bindRequest, prefix, bundleHandled, commands },
) {
  const clean = cleanChecker(ctx),
    project = ctx.originalProject ?? ctx.project;
  const matches = {},
    deliveredRequests = new Map(),
    missingFormats = [],
    stdinFormats = [],
    outsideInputs = [],
    failedRegens = [];
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
      commands,
    });
    matches[ext] = step.match;
    if (step.used) usedStandalone = true;
    if (step.missing) missingFormats.push(artifact);
    if (step.stdin) stdinFormats.push(artifact);
    if (step.outside) outsideInputs.push(step.outside);
    if (step.failed) failedRegens.push(step.failed);
    if (step.deliveredInput) deliveredRequests.set(ext, step.deliveredInput);
    if (step.packet) packet = step.packet;
  }
  return {
    matches,
    packet,
    deliveredRequests,
    missingFormats,
    stdinFormats,
    outsideInputs,
    failedRegens,
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
  } = {},
) {
  const prefix = join(ctx.evidence, `regenerated-${name}`),
    commands = {},
    matches = {},
    deliveredRequests = new Map(),
    bundleHandled = new Set(),
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
    commands[ext] = entry.argv;
    matches[ext] = bundle.status === "current" && entry.status === "current";
    if (entry.packetInput) deliveredRequests.set(ext, entry.packetInput);
    if (ext === "json" && bundle.packet) packet = bundle.packet;
  }
  const standalone = await regenerateStandaloneFormats(ctx, {
    name,
    formats,
    request,
    bindRequest,
    prefix,
    bundleHandled,
    commands,
  });
  Object.assign(matches, standalone.matches);
  if (!packet && standalone.packet) packet = standalone.packet;
  for (const [ext, input] of standalone.deliveredRequests)
    deliveredRequests.set(ext, input);
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
        missingFormats: standalone.missingFormats,
        stdinFormats: standalone.stdinFormats,
        outsideInputs: standalone.outsideInputs,
        failedRegens: standalone.failedRegens,
        matches,
      });
  return {
    pass,
    route,
    request: distinctRequests.length === 1 ? distinctRequests[0] : null,
    bundleRequest: bundle?.request ?? null,
    matches,
    packet,
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
