// Isolated, browser-free mutation acceptance. A green control is mandatory.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import ts from "typescript";
import { fileURLToPath } from "node:url";
const { values: v } = parseArgs({
  options: {
    output: { type: "string" },
    list: { type: "boolean", default: false },
  },
});
assert(v.output, "Use --output <mutation-report.json>");
const root = fileURLToPath(new URL("../../", import.meta.url)),
  out = resolve(v.output);
await mkdir(join(root, "evals/out"), { recursive: true });
const copy = await mkdtemp(join(root, "evals/out/mutation-")),
  vectors = [],
  original = new Map();
process.on("exit", () => rmSync(copy, { recursive: true, force: true }));
const all = [
  "evals/draw/crop-geometry.test.mjs",
  "evals/draw/crop-source-policy.test.mjs",
  "evals/draw/crop-source-pixels.test.mjs",
  "evals/draw/crop-source.test.mjs",
  "evals/draw/crop-report.test.mjs",
  "evals/draw/crop-index.test.mjs",
  "evals/draw/capture.test.mjs",
  "evals/draw/repin-source-integration.test.mjs",
  "evals/draw/sheet-identities.test.mjs",
  "evals/draw/repin-drawing-bindings.test.mjs",
  "evals/draw/repin.test.mjs",
  "evals/draw/repin-succession.test.mjs",
  "scripts/stamp-drawing-crop.test.mjs",
  "evals/draw/crop-review.test.mjs",
  "evals/draw/source-hashes.test.mjs",
];
await mkdir(join(copy, "evals/out"), { recursive: true }); // Test fixtures rely on the ignored output root.
await cp(join(root, "evals/draw"), join(copy, "evals/draw"), {
  recursive: true,
});
await mkdir(join(copy, "scripts"));
for (const f of ["stamp-drawing-crop.mjs", "stamp-drawing-crop.test.mjs"])
  await cp(join(root, "scripts", f), join(copy, "scripts", f));
for (const p of ["node_modules", "packages"])
  await symlink(join(root, p), join(copy, p), "junction");
for (const p of ["package.json", "vitest.config.mjs"])
  await cp(join(root, p), join(copy, p));
async function source(file) {
  if (!original.has(file))
    original.set(file, await readFile(join(root, file), "utf8"));
  return original.get(file);
}
function add(id, file, from, to, tests = all) {
  assert(original.get(file).includes(from), "Missing mutation anchor: " + id);
  vectors.push({ id, file, from, to, tests });
}
function calls(file, name) {
  const s = original.get(file),
    ast = ts.createSourceFile(
      file,
      s,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    out = [];
  function walk(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === name)
      out.push({
        text: n.getText(ast),
        condition: n.arguments[0]?.getText(ast),
        message: n.arguments[1]?.getText(ast),
      });
    ts.forEachChild(n, walk);
  }
  walk(ast);
  return out;
}
for (const [name, tests] of [
  ["crop-source-policy", ["evals/draw/crop-source-policy.test.mjs"]],
  ["crop-source-pixels", ["evals/draw/crop-source-pixels.test.mjs"]],
  ["crop-source", ["evals/draw/crop-source.test.mjs"]],
  [
    "crop-report",
    ["evals/draw/crop-report.test.mjs", "evals/draw/crop-review.test.mjs"],
  ],
  ["crop-index", ["evals/draw/crop-index.test.mjs"]],
  ["source-hashes", ["evals/draw/source-hashes.test.mjs"]],
]) {
  const file = `evals/draw/${name}.mjs`;
  await source(file);
  for (const [n, a] of calls(file, "assert").entries())
    add(
      `${name}/assert-${n} ${a.message ?? ""}`,
      file,
      a.text,
      `assert(true, ${a.message ?? "undefined"})`,
      tests,
    );
  if (name === "crop-report")
    for (const [n, a] of calls(file, "same").entries())
      add(`report-field-${n}`, file, a.text, "undefined", tests);
}
const g = "evals/draw/crop-geometry.mjs";
await source(g);
for (const [id, s] of [
  ["left", "box.x >= cropBbox.x - 0.001"],
  ["top", "box.y >= cropBbox.y - 0.001"],
  ["right", "box.x + box.w <= cropBbox.x + cropBbox.w + 0.001"],
  ["bottom", "box.y + box.h <= cropBbox.y + cropBbox.h + 0.001"],
  ["width", "box.w >= 0"],
  ["height", "box.h >= 0"],
  ["crop-width", "cropBbox.w > 0"],
  ["crop-height", "cropBbox.h > 0"],
])
  add("geometry-" + id, g, s, "true", [all[0]]);
add(
  "geometry-finite",
  g,
  original.get(g).match(/\[\s*box\.x,[\s\S]*?\]\.every\(Number.isFinite\)/)[0],
  "true",
  [all[0]],
);
async function edit(id, file, from, to, tests = all) {
  await source(file);
  add(id, file, from, to, tests);
}
await edit(
  "report-contains",
  "evals/draw/crop-report.mjs",
  "assertCropContainsInstance({ bbox: c.instanceBbox }, c.sourceBbox);",
  "",
  ["evals/draw/crop-report.test.mjs"],
);
const b = "evals/draw/repin-drawing-bindings.mjs";
await edit(
  "bind-containment",
  b,
  "assertCropContainsInstance({ bbox: row.instanceBbox }, row.sourceBbox);",
  "",
  [all[1]],
);
await edit("bind-cropless", b, "assertNoCroplessFacts(file);", "", [all[1]]);
await edit(
  "bind-discard-typed-source",
  b,
  "delete entry.sourceVerification;",
  "",
  [all[1]],
);
const coverage = calls(b, "assert").find((a) =>
  a.message?.includes("exactly cover"),
);
add("bind-exact-coverage", b, coverage.condition, "true", [all[1]]);
const run = "evals/draw/run.mjs";
await edit(
  "runner-HTML-index",
  run,
  "html: svgLocators(htmlSvgs[s.number - 1], ir, s.view, tables)",
  "html: svgLocators(s.svg, ir, s.view, tables)",
  ["evals/draw/sheet-identities.test.mjs"],
);
await source(run);
const runSource = original.get(run),
  runAst = ts.createSourceFile(
    run,
    runSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ),
  boxes = [];
function boxInitializers(n) {
  if (
    ts.isVariableDeclaration(n) &&
    n.name.getText(runAst) === "box" &&
    n.initializer?.getText(runAst).includes("cropBox(")
  )
    boxes.push(n.initializer.getText(runAst));
  ts.forEachChild(n, boxInitializers);
}
boxInitializers(runAst);
assert(boxes.length === 2);
for (const [i, box] of boxes.entries())
  add("capture-canonical-box-" + i, run, box, box.slice(10, -1), [
    "evals/draw/capture.test.mjs",
  ]);
for (const file of ["run.mjs", "crop-source.mjs", "repin-crop-index.mjs"]) {
  await edit(
    "isolated-context-" + file,
    "evals/draw/" + file,
    "browser.newContext(drawingContextOptions)",
    "browser.newContext({})",
    ["evals/draw/capture.test.mjs"],
  );
}
const browser = "evals/draw/browser.mjs";
await edit("capture-offline", browser, "offline: true", "offline: false", [
  "evals/draw/capture.test.mjs",
]);
await edit(
  "capture-service-workers",
  browser,
  'serviceWorkers: "block"',
  'serviceWorkers: "allow"',
  ["evals/draw/capture.test.mjs"],
);
await edit(
  "capture-page-scripts",
  browser,
  "javaScriptEnabled: false",
  "javaScriptEnabled: true",
  ["evals/draw/capture.test.mjs"],
);
const src = "evals/draw/crop-source.mjs";
await edit(
  "source-contains",
  src,
  "assertCropContainsInstance({ bbox: row.instanceBbox }, row.sourceBbox);",
  "",
  [all[3]],
);
await edit(
  "source-compares-pixels",
  src,
  "compareSourcePixels(crops.get(row.path), raster, row.headerPixels ?? 0);",
  "",
  [all[3]],
);
await edit(
  "source-root-containment",
  src,
  "const target = await within(resolve(sourceRoot, path), sourceRoot, {\n    existing: true,\n  });",
  "const target = resolve(sourceRoot,path);",
  [all[3]],
);
await edit(
  "source-canonical-region",
  src,
  "const b = canonical(row.sourceBbox);",
  "const b = row.sourceBbox;",
  [all[3]],
);
const policy = "evals/draw/crop-source-policy.mjs";
for (const [id, from, to] of [
  ["known-pr", "historical.has(file.pr) &&", ""],
  ["loop", "for (const { entry } of refs) checkSourceVerification(entry);", ""],
  [
    "contains",
    "assertCropContainsInstance({ bbox: v.instanceBbox }, v.sourceBbox);",
    "",
  ],
  ["exact-hash", "historical.get(file.pr) === sha", "historical.has(file.pr)"],
])
  await edit("source-policy-" + id, policy, from, to, [all[1]]);
const io = "evals/draw/repin-io.mjs";
await source(io);
await edit(
  "preview-requires-source",
  io,
  original.get(io).match(/checkSourceReferences\(file\.value,[\s\S]*?\);/)[0],
  "",
  ["evals/draw/repin-source-integration.test.mjs"],
);
await edit(
  "preview-report-binding",
  io,
  "checkReportedSources(file.value, reports);",
  "undefined;",
  ["evals/draw/repin.test.mjs"],
);
const record = "evals/draw/repin-record.mjs";
await source(record);
await edit(
  "record-requires-source",
  record,
  original
    .get(record)
    .match(/const sourceVerification = checkSourceReferences\([\s\S]*?\);/)[0],
  'const sourceVerification = "disabled";',
  ["evals/draw/repin-source-integration.test.mjs"],
);
await edit(
  "receipt-source-binding",
  "evals/draw/repin-record-crosscheck.mjs",
  "sourceVerification: x.sourceVerification,",
  "",
  ["evals/draw/repin-source-integration.test.mjs"],
);
const stamp = "scripts/stamp-drawing-crop.mjs";
for (const [id, from, to] of [
  [
    "contains",
    "assertCropContainsInstance(geometry?.instance, geometry?.cropBbox);",
    "",
  ],
  ["cli-instance", "values.instance &&", ""],
  ["cli-bbox", 'values["source-bbox"]', "true"],
])
  await edit("stamper-" + id, stamp, from, to, [
    "scripts/stamp-drawing-crop.test.mjs",
  ]);
await edit(
  "bind-carries-computed-source",
  "evals/draw/repin-bind-crops.mjs",
  "entry.sourceVerification = proofs.get(crop.path);",
  "entry.sourceVerification = undefined;",
  ["evals/draw/repin-drawing-bindings.test.mjs"],
);
await edit(
  "source-metadata-allowed",
  "evals/draw/repin-policy.mjs",
  '"sourceVerification",',
  "",
  ["evals/draw/repin-succession.test.mjs"],
);
await edit(
  "pixels-header-validates",
  "evals/draw/crop-source-pixels.mjs",
  "drawingHash(cropBytes, headerPixels);",
  "",
  [all[2]],
);
await edit(
  "bind-report-callsite",
  "evals/draw/repin-bind-crops.mjs",
  "checkIndexedEntries(file.value, index.value, reports);",
  "undefined;",
  ["evals/draw/repin-drawing-bindings.test.mjs"],
);
const stampCheck = "evals/draw/crop-stamp-check.mjs";
await source(stampCheck);
const headerGuard = calls(stampCheck, "assert").find((a) =>
  a.message?.includes("Stamped header pixels"),
);
add(
  "stamp-header-pixels",
  stampCheck,
  headerGuard.text,
  `assert(true, ${headerGuard.message})`,
  ["scripts/stamp-drawing-crop.test.mjs"],
);
await edit(
  "bind-stamp-check-callsite",
  "evals/draw/repin-bind-crops.mjs",
  "await verifyStampHeaders(index.value, crops);",
  "",
  ["evals/draw/repin-drawing-bindings.test.mjs"],
);
await edit(
  "preview-stamp-check-callsite",
  "evals/draw/repin-io.mjs",
  "await verifyStampHeaders({ crops: headerRows }, cropBytes);",
  "",
  ["evals/draw/repin-drawing-bindings.test.mjs"],
);
await edit(
  "mixed-rename-changed-text-only",
  "evals/draw/crop-report.mjs",
  "return changed.length ? changed : pairs;",
  "return pairs;",
  ["evals/draw/crop-review.test.mjs"],
);
await edit(
  "builder-pinned-source-callsite",
  "evals/draw/repin-crop-index.mjs",
  "assertSourceBytes(source, sourceRef);",
  "",
  ["evals/draw/repin-source-integration.test.mjs"],
);
await edit(
  "capture-source-SVG-bytes",
  "evals/draw/source-hashes.mjs",
  "hash(await readFile(join(directory, svgFile)))",
  "hash(html)",
  ["evals/draw/source-hashes.test.mjs"],
);
await edit(
  "capture-source-HTML-bytes",
  "evals/draw/source-hashes.mjs",
  "sha256: hash(html)",
  'sha256: hash("unbound")',
  ["evals/draw/source-hashes.test.mjs"],
);
await edit(
  "capture-source-runner-callsite",
  "evals/draw/run.mjs",
  "sourceHashes: await captureSources(",
  "unboundSourceHashes: await captureSources(",
  ["evals/draw/capture.test.mjs"],
);
await edit(
  "header-fitting",
  "scripts/stamp-drawing-crop.mjs",
  "if (width > available)",
  "if (false)",
  ["scripts/stamp-drawing-crop.test.mjs"],
);
// Deliberately harmless mutation must survive; it proves survivors are observable.
await edit(
  "benign-comment-control",
  "evals/draw/crop-source-pixels.mjs",
  "// A measured envelope",
  "// A harmless comment before a measured envelope",
  [all[2]],
);
if (v.list) {
  await writeFile(
    out,
    JSON.stringify(
      vectors.map(({ id, file, tests }) => ({ id, file, tests })),
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await rm(copy, { recursive: true, force: true });
  console.log("Validated " + vectors.length + " mutation anchors");
  process.exit(0);
}
const before = loadavg(),
  start = performance.now(),
  results = [];
function executeTests(tests, label) {
  const report = join(copy, "evals/out/results.json");
  try {
    require("node:fs").unlinkSync(report);
  } catch {}
  const p = spawnSync(
    "bun",
    [
      join(copy, "node_modules/vitest/vitest.mjs"),
      "run",
      ...tests,
      "--maxWorkers=2",
      "--reporter=json",
      "--outputFile=" + report,
    ],
    {
      cwd: copy,
      encoding: "utf8",
      env: {
        ...process.env,
        THERMITE_DRAW_CHROMIUM: "/nonexistent/x",
        THERMITE_DRAW_PDFKIT: "0",
      },
    },
  );
  let data;
  try {
    data = JSON.parse(require("node:fs").readFileSync(report, "utf8"));
  } catch {}
  const failed = (data?.testResults ?? []).flatMap((r) =>
    (r.assertionResults ?? [])
      .filter((t) => t.status === "failed")
      .map((t) => ({
        test: t.fullName,
        message: t.failureMessages.join("\n").slice(0, 1600),
      })),
  );
  const brokenSuite = (data?.testResults ?? []).some(
    (r) => r.status === "failed" && !r.assertionResults?.length,
  );
  const status =
    p.status === 0 && data?.numPassedTests > 0
      ? "survived"
      : !brokenSuite && failed.length
        ? "killed"
        : "invalid";
  return {
    id: label,
    status,
    failed,
    exit: p.status,
    passed: data?.numPassedTests,
    stderr: status === "invalid" ? p.stderr.slice(-3000) : undefined,
  };
}
try {
  const control = executeTests(all, "unmodified-control");
  assert(
    control.status === "survived",
    "Mutation control must pass: " + JSON.stringify(control),
  );
  results.push(control);
  console.log("Green control: " + control.passed + " tests");
  for (const [n, m] of vectors.entries()) {
    await writeFile(
      join(copy, m.file),
      original.get(m.file).replace(m.from, m.to),
    );
    const r = executeTests(m.tests, m.id);
    results.push(r);
    console.log(`${n + 1}/${vectors.length} ${r.status}: ${m.id}`);
    await writeFile(join(copy, m.file), original.get(m.file));
  }
} finally {
  await rm(copy, { recursive: true, force: true });
}
const data = {
  total: vectors.length,
  killed: results.filter((r) => r.status === "killed").length,
  survived: results.filter(
    (r) => r.status === "survived" && r.id !== "unmodified-control",
  ).length,
  invalid: results.filter((r) => r.status === "invalid").length,
  seconds: (performance.now() - start) / 1000,
  loadBefore: before,
  loadAfter: loadavg(),
  results,
};
await writeFile(out, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...data, results: undefined }));
assert(!data.invalid, "Invalid mutation runs are not kills");
