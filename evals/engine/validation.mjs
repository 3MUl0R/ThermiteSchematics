import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileProject, lockProject } from "./engine.mjs";
import { assess } from "./assessment.mjs";
import { assertLocations } from "./diagnostic-policy.mjs";
import { corpus, readJson, temporary, json, probe } from "./support.mjs";

export async function mutationCases() {
  return (await readJson(join(corpus, "mutations.json"))).cases;
}
function at(value, pointer) {
  return pointer
    .slice(1)
    .split("/")
    .reduce(
      (v, part) => v[part.replaceAll("~1", "/").replaceAll("~0", "~")],
      value,
    );
}
export async function mutate(project, scenario) {
  for (const change of scenario.changes) {
    const path = join(project, change.file);
    if (change.raw !== undefined) {
      await writeFile(path, change.raw);
    } else if (change.duplicateMember) {
      const text = await readFile(path, "utf8");
      await writeFile(
        path,
        text.replace('"kind": "device"', '"kind": "device", "kind": "device"'),
      );
    } else {
      const value = await readJson(path);
      const slash = change.pointer.lastIndexOf("/");
      const target =
        slash === 0 ? value : at(value, change.pointer.slice(0, slash));
      const field = change.pointer
        .slice(slash + 1)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      const replacement =
        typeof change.value === "string" && change.value.startsWith("@copy:")
          ? at(value, change.value.slice(6))
          : change.value;
      if (change.op === "delete") delete target[field];
      else if (field === "-") target.push(replacement);
      else target[field] = replacement;
      await writeFile(path, json(value));
    }
  }
  if (scenario.relock) {
    const locked = await lockProject(project);
    assert(locked.ok, JSON.stringify(locked.diagnostics));
  }
}

export function assertDiagnostics(diagnostics, scenario) {
  assert(
    diagnostics.every((d) =>
      scenario.expected.some((e) =>
        Object.entries(e).every(([field, value]) => d[field] === value),
      ),
    ),
    `Unexpected diagnostic: ${JSON.stringify(diagnostics)}`,
  );
  for (const expected of scenario.expected) {
    assert(
      diagnostics.some((d) =>
        Object.entries(expected).every(([field, value]) => d[field] === value),
      ),
      `Missing ${JSON.stringify(expected)}; actual ${JSON.stringify(diagnostics)}`,
    );
  }
}

export function evaluateRatingAssessment(id, result, evidence) {
  assert(
    result.ok && result.ir,
    "Rating assessment fixture must compile successfully",
  );
  const ir = result.ir;
  const nodes = ir.devices.filter((d) => d.designation === "N1");
  assert.equal(nodes.length, 1, "Rating fixture must contain exactly one N1");
  const uid = nodes[0].uid;
  const contains = (net, key) =>
    net.terminalIds.some((t) => t.deviceUid === uid && t.terminalKey === key);
  const net = ir.nets.find((n) => contains(n, "a"));
  assert(net && contains(net, "b"), "N1.a and N1.b must share a derived net");
  const names = new Map(ir.devices.map((d) => [d.uid, d.designation]));
  const ratingConflict = {
    net: net.terminalIds
      .map((t) => `${names.get(t.deviceUid)}.${t.terminalKey}`)
      .sort(),
    ratings: Object.fromEntries(
      ["a", "b"].map((key) => [
        `N1.${key}`,
        ir.terminals.find(
          (t) => t.id.deviceUid === uid && t.id.terminalKey === key,
        )?.rating,
      ]),
    ),
    potentialUids: [
      ...new Set([
        ...net.potentialUids,
        ...ir.potentials.filter((p) => p.netId === net.id).map((p) => p.uid),
      ]),
    ].sort(),
  };
  assert.deepEqual(ratingConflict.net, ["N1.a", "N1.b"]);
  assert.deepEqual(ratingConflict.ratings["N1.a"], {
    nominal_voltage: 24,
    voltage_type: "DC",
  });
  assert.deepEqual(ratingConflict.ratings["N1.b"], {
    nominal_voltage: 48,
    voltage_type: "AC",
  });
  assert.deepEqual(
    ratingConflict.potentialUids,
    [],
    "No potential may cover the conflicting net",
  );
  assert(
    result.diagnostics.every((d) =>
      /rating|voltage|unassessed/i.test(d.message),
    ),
    "Unrelated diagnostic in assessment-gap fixture",
  );
  return assess(
    id,
    { ...evidence, netId: net.id, ratingConflict },
    result.diagnostics.length > 0,
  );
}

export async function validation() {
  const rows = [];
  const baselines = (await readJson(join(corpus, "baselines.json"))).cases;
  assert(baselines.length >= 12, "At least twelve clean baselines required");
  for (const baseline of baselines) {
    rows.push(
      await probe(`baseline/${baseline.id}`, () =>
        temporary(async (project) => {
          await mutate(project, baseline);
          const result = await compileProject(project);
          assert(result.ok);
          assert.deepEqual(
            result.diagnostics,
            [],
            "Unexpected baseline diagnostic",
          );
          return { diagnostics: [] };
        }),
      ),
    );
  }
  const scenarios = await mutationCases();
  assert(scenarios.length >= 50);
  assert(new Set(scenarios.map((s) => s.family)).size >= 19);
  for (const scenario of scenarios) {
    rows.push(
      await probe(`mutation/${scenario.id}`, () =>
        temporary(async (project) => {
          await mutate(project, scenario);
          const result = await compileProject(project);
          assertLocations(result.diagnostics);
          const id = `mutation/${scenario.id}`;
          const evidence = {
            family: scenario.family,
            ok: result.ok,
            exit: result.ok ? 0 : result.toolFailure ? 2 : 1,
            expected: scenario.expected,
            diagnostics: result.diagnostics,
          };
          if (scenario.predicate === "profile-assessment") {
            // P1 is merged: require the exact warning site, independently of
            // the historical corpus row's unprescribed assessment outcome.
            assert(result.ok);
            assertDiagnostics(result.diagnostics, {
              expected: [
                {
                  code: "W111",
                  severity: "warning",
                  file: "library/types/node.json",
                  jsonPointer: "/types/0/symbol",
                },
              ],
            });
            assert.equal(result.diagnostics.length, 1);
            assert.match(
              result.diagnostics[0].message,
              /type "eval:node" symbol "eval:unsupported": unknown profile\./,
            );
            return evidence;
          }
          if (scenario.predicate === "rating-assessment") {
            return evaluateRatingAssessment(id, result, evidence);
          }
          assertDiagnostics(result.diagnostics, scenario);
          assert.equal(
            result.ok,
            !scenario.expected.some((d) => d.severity === "error"),
          );
          return evidence;
        }, scenario.fixture ?? "topology"),
      ),
    );
  }
  return rows;
}
