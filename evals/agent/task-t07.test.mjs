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
import { check } from "./tasks.mjs";
import { score } from "./score-log.mjs";

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

function render(output, view) {
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
  wrongView = render(report, {
    format: "documentation-view-request/0.1",
    kind: "terminals",
  });
  loop = render(artifact, loopView);
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
  const ctx = delivery("wrong-view", [wrongView]);
  rmSync(join(ctx.project, artifact));
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
});

it("rejects a stale hookup PDF following a visible project change", async () => {
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
  const ctx = delivery("no-command", []);
  rmSync(join(ctx.project, report));
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
});

it("rejects a recorded print with no delivered PDF", async () => {
  const ctx = delivery("missing", [loop]);
  rmSync(join(ctx.project, artifact));
  rmSync(join(ctx.project, report));
  const result = await check("T07", ctx);
  expect(result.checks).toEqual({ validates: true, issueOrHookup: false });
  expect(result.pass).toBe(false);
});

it("reports an accepted hookup with an incidental issue file as requiring view guidance", () => {
  const options = {
    final: { files: { "issue.md": "hash" } },
    requiredTopics: [{ topic: "views", before: "hookup" }],
  };
  const draft = { checks: { issueOrHookup: true } };
  expect(
    score({ ...options, taskOutcome: draft }).retrieval[0].applicability,
  ).toBe("draft-only");
  const hookup = { ...draft, hookupPdf: artifact };
  expect(
    score({ ...options, taskOutcome: hookup }).retrieval[0].applicability,
  ).toBe("required");
});
