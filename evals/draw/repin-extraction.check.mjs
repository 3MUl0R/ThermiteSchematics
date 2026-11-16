// Read-only extraction parity: use frozen base/head modules, never apply.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assemble, it0, base, mid, A, view } from "./repin-fixture.mjs";

const expectedRefusals = {
  "old version": "Run a fresh full report with the current evals version",
  "missing checker": "Current checker bundle is required",
  "report format": "Unsupported report format",
  "report mode": "Use a full strict report",
  "report registry": "Report registry hash is stale",
  "report bundle": "Report checker bundle is stale",
  "registry keys before report format": "Unknown registry field: extra",
  "marker count": "Invalid existing count",
  "file keys": "Unknown decisions file field: extra",
  "file format": "Unsupported decisions format",
  "empty PR": "Name the merged PR/lane",
  "stale file summarySha256": "Stale decisions binding: summarySha256",
  "stale file registrySha256": "Stale decisions binding: registrySha256",
  "stale file checkerSha256": "Stale decisions binding: checkerSha256",
  "stale file corpusSha256": "Stale decisions binding: corpusSha256",
  "stale file evalsVersion": "Stale decisions binding: evalsVersion",
  "missing baseline": "Bound baseline bytes/hash not supplied",
  unreviewed: "Unreviewed draft entry; inspect it and set reviewed: true",
  "missing rationale": "Record cause class and review rationale",
  "missing signer": "signOff.by must be non-empty",
  "unknown action": "Unknown decision action: guess",
  "unknown entry field": "Unknown decision field: extra",
  "wrong classification": "Explicit policy-gap/drawing classification required",
  "invalid cause": "Retirement cause must be fixed, removed or not-measured",
  "false not-measured": "Retirement cause contradicts measurement availability",
  "unknown source scope":
    "Retirement/rename source must be a stale measured scope",
  "unknown scope field": "Unknown scope field: extra",
  "wrong medium": "Invalid scope selector",
  "empty retirement": "Empty instance retirement",
  "unknown retirement token": "Unknown retirement instance",
  "conflicting retirements": "Conflicting whole-scope retirement",
  "missing crop": "Crop required: supply a non-empty file path and SHA-256",
  "crop mismatch": "Reviewed crop missing or hash mismatch",
  "unknown new token": "Unknown new-defect instance",
  "empty new instances": "List each new finding instance",
  "unknown target scope": "Target finding identity/scope not observed",
  "rename wrong pair": "Rename pair is not in its declared scopes",
  "rename no pairs": "List individual rename pairs",
  "unproved native move":
    "Cannot prove move (source row or locator kind changed); review a no-credit superseded retirement with an observed successor or survivor.",
  "potential move retirement": "Retirement could be a move",
};

const old = it0("old"),
  target = it0("target");
function retirement() {
  return assemble({
    registryItems: [old],
    currentItems: [],
    entries: ({ retire }) => [retire(old, "fixed")],
  });
}
function addition() {
  return assemble({
    registryItems: [],
    currentItems: [target],
    entries: ({ add }) => [add(target)],
  });
}
function rename() {
  return assemble({
    registryItems: [old],
    currentItems: [target],
    entries: ({ before, ref }) => [
      {
        ...base,
        action: "rename",
        from: {
          markerId: mid(old),
          scope: { case: A, sheet: view, medium: "svg" },
        },
        to: { markerId: ref(target).markerId, scope: ref(target).scope },
        pairs: [{ from: before.instances[0].token, to: ref(target).tokens[0] }],
      },
    ],
  });
}
function set(path, value) {
  return (context) => {
    const keys = Array.isArray(path) ? path : path.split(".");
    const parent = keys.slice(0, -1).reduce((item, key) => item[key], context);
    parent[keys.at(-1)] = structuredClone(value);
  };
}
function bindingRefusals() {
  return [
    ["old version", set("report.evalsVersion", "5.15")],
    ["missing checker", set("checkerSha256", "")],
    ["report format", set("report.format", "wrong")],
    ["report mode", set("report.mode", "inventory")],
    [
      "report registry",
      set(["report", "checkers", "expectations.mjs"], "stale"),
    ],
    ["report bundle", set("report.checkerSha256", "stale")],
    [
      "registry keys before report format",
      (c) => {
        c.registry.extra = 1;
        c.report.format = "wrong";
      },
    ],
    ["marker count", set("registry.markers.0.count", [1])],
    ["file keys", set("decisions.0.extra", 1)],
    ["file format", set("decisions.0.format", "wrong")],
    ["empty PR", set("decisions.0.pr", " ")],
    ...[
      "summarySha256",
      "registrySha256",
      "checkerSha256",
      "corpusSha256",
      "evalsVersion",
    ].map((k) => ["stale file " + k, set("decisions.0." + k, "stale")]),
    ["missing baseline", (c) => c.baselines.clear()],
  ].map(([name, mutate]) => ({ name, make: retirement, mutate }));
}
function entryRefusals() {
  const entry = "decisions.0.entries.0.";
  return [
    ["unreviewed", set(entry + "reviewed", false)],
    ["missing rationale", set(entry + "note", " ")],
    ["missing signer", set(entry + "signOff.by", "")],
    ["unknown action", set(entry + "action", "guess")],
    ["unknown entry field", set(entry + "extra", 1)],
    ["wrong classification", set(entry + "classification", "policy-gap")],
    ["invalid cause", set(entry + "cause", "guess")],
    ["false not-measured", set(entry + "cause", "not-measured")],
    ["unknown source scope", set(entry + "scope.sheet", "view:missing")],
    ["unknown scope field", set(entry + "scope.extra", 1)],
    ["wrong medium", set(entry + "scope.medium", "png")],
    ["empty retirement", set(entry + "instances", [])],
    ["unknown retirement token", set(entry + "instances", ["missing"])],
    [
      "conflicting retirements",
      (c) =>
        c.decisions[0].entries.push(structuredClone(c.decisions[0].entries[0])),
    ],
  ].map(([name, mutate]) => ({ name, make: retirement, mutate }));
}
function moveCandidate() {
  const moved = { ...target, src: old.src };
  return assemble({
    registryItems: [old],
    currentItems: [moved],
    entries: ({ retire, add }) => [retire(old, "fixed"), add(moved)],
  });
}
function targetRefusals() {
  const entry = "decisions.0.entries.0.",
    nothing = () => {};
  return [
    ...[
      [
        "missing crop",
        (c) => {
          delete c.decisions[0].entries[0].crop;
        },
      ],
      ["crop mismatch", set(entry + "crop.sha256", "0".repeat(64))],
      ["unknown new token", set(entry + "instances", ["missing"])],
      ["empty new instances", set(entry + "instances", [])],
      ["unknown target scope", set(entry + "to.scope.sheet", "view:missing")],
    ].map(([name, mutate]) => ({ name, make: addition, mutate })),
    ...[
      ["rename wrong pair", set(entry + "pairs.0.from", "missing")],
      ["rename no pairs", set(entry + "pairs", [])],
      ["unproved native move", nothing],
    ].map(([name, mutate]) => ({ name, make: rename, mutate })),
    { name: "potential move retirement", make: moveCandidate, mutate: nothing },
  ];
}
function outcome(prepare, input) {
  try {
    return {
      accepted: true,
      output: JSON.stringify(prepare(structuredClone(input))),
    };
  } catch (error) {
    return {
      accepted: false,
      errorClass: error.constructor.name,
      code: error.code ?? null,
      message: error.message,
    };
  }
}
export async function refusalParity(baseRoot, headRoot) {
  const load = (root) =>
    import(pathToFileURL(join(root, "evals/draw/repin-core.mjs")));
  const before = (await load(baseRoot)).prepareRepin,
    after = (await load(headRoot)).prepareRepin;
  const rows = [];
  for (const make of [retirement, addition]) {
    const input = make(),
      a = outcome(before, input),
      b = outcome(after, input);
    assert(a.accepted, "Positive control refused: " + a.message);
    assert.deepEqual(b, a);
    rows.push({ name: "positive " + make.name, ...a });
  }
  for (const { name, make, mutate } of [
    ...bindingRefusals(),
    ...entryRefusals(),
    ...targetRefusals(),
  ]) {
    const input = structuredClone(make());
    mutate(input);
    const a = outcome(before, input),
      b = outcome(after, input);
    assert(!a.accepted, "Refusing input passed: " + name);
    assert.equal(a.errorClass, "AssertionError", name);
    assert(
      a.message.startsWith(expectedRefusals[name]),
      "Wrong refusal: " + name,
    );
    assert.deepEqual(b, a, name);
    rows.push({ name, ...a });
  }
  return rows;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string" },
      output: { type: "string" },
    },
  });
  assert(
    values.base && values.head && values.output,
    "Supply --base, --head and --output",
  );
  const rows = await refusalParity(resolve(values.base), resolve(values.head));
  await writeFile(values.output, JSON.stringify(rows, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      positive: rows.filter((r) => r.accepted).length,
      refused: rows.filter((r) => !r.accepted).length,
    }),
  );
}
