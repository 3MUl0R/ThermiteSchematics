import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "../../agent/snapshot.mjs";
import { contributorBuildOutputs } from "../../agent/contributor-bun.mjs";
import { focus, git, ordering, seedPatch, setup } from "./support.mjs";
import checkR01 from "./R01/check.mjs";
import checkR02 from "./R02/check.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function temp() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "thermite-k-")));
  roots.push(root);
  return root;
}
function put(dir, file, text) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function fixture(seeded = false) {
  const project = temp(),
    evidence = join(project, "evidence"),
    engine = join(project, "engine"),
    ctx = { project, evidence, env: process.env };
  mkdirSync(engine);
  git(ctx, engine, "init", "--quiet");
  const clean = readFileSync(new URL("../../../" + ordering, import.meta.url));
  put(engine, ordering, clean);
  put(
    engine,
    focus,
    'it("ascending", () => expect(compareAlias("A", "B")).toBeLessThan(0));\n',
  );
  put(engine, ".gitignore", "node_modules/\ndist/\n");
  if (seeded) git(ctx, engine, "apply", seedPatch);
  git(ctx, engine, "add", ".");
  git(
    ctx,
    engine,
    "-c",
    "user.name=Eval",
    "-c",
    "user.email=eval@invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture",
  );
  put(
    evidence,
    "contributor-seed.json",
    JSON.stringify({
      revision: git(ctx, engine, "rev-parse", "HEAD").trim(),
      cleanSource: sha256(clean),
    }),
  );
  put(project, "contributor-friction.md", "Run receipts recorded.");
  const repository = seeded ? engine : join(project, "worktree");
  if (!seeded) git(ctx, engine, "worktree", "add", "--detach", repository);
  for (const root of new Set([repository, engine]))
    for (const name of ["typescript", "vitest", "elkjs"])
      put(root, `node_modules/${name}/package.json`, "{}\n");
  const at = Date.now() - 1000;
  for (const { file } of contributorBuildOutputs(repository))
    put(repository, file, "built\n");
  const rows = [
    {
      cwd: repository,
      kind: "install",
      argv: ["install", "--frozen-lockfile"],
      exit: 0,
      started: at,
      ended: at + 1,
    },
    {
      cwd: repository,
      kind: "focused",
      argv: ["scripts/test.mjs", focus],
      exit: 0,
      started: at + 1,
      ended: at + 2,
      tests: {
        total: 7,
        passed: 7,
        failed: 0,
        files: [join(repository, focus)],
      },
    },
    {
      cwd: repository,
      kind: "build",
      argv: ["run", "build"],
      exit: 0,
      started: at + 2,
      outputs: contributorBuildOutputs(repository),
    },
  ];
  const save = () =>
    put(
      evidence,
      "contributor-commands.jsonl",
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  save();
  return { ctx, engine, repository, rows, save, clean };
}

it("R01 accepts a registered checkout with matching test and build receipts", () => {
  expect(checkR01(fixture().ctx).pass).toBe(true);
});

it("R01 accepts an incremental rebuild after a fresh observed build", () => {
  const f = fixture();
  const [install, test, build] = f.rows;
  const latest = Math.max(...build.outputs.map((file) => file.modified)) + 1000;
  f.rows.splice(
    0,
    3,
    install,
    build,
    { ...test, started: latest, ended: latest + 1 },
    { ...build, started: latest + 1 },
  );
  f.save();
  expect(checkR01(f.ctx).pass).toBe(true);
});

it.each([
  [
    "skipped focused test",
    "focused",
    ({ rows, save }) => {
      rows[1].tests.passed--;
      save();
    },
  ],
  [
    "omitted focused test with a report",
    "focused",
    ({ rows, save }) => {
      rows.splice(1, 1);
      save();
    },
  ],
  [
    "symlinked node_modules",
    "ownInstall",
    ({ engine, repository }) => {
      rmSync(join(repository, "node_modules"), { recursive: true });
      symlinkSync(
        join(engine, "node_modules"),
        join(repository, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    },
  ],
  [
    "stale build",
    "freshBuild",
    ({ repository, rows, save }) => {
      const file = join(
        repository,
        contributorBuildOutputs(repository)[0].file,
      );
      utimesSync(file, new Date(0), new Date(0));
      // The successful command also observed stale outputs. Matching hashes
      // alone cannot give them a fresh origin.
      rows[2].outputs = contributorBuildOutputs(repository);
      save();
    },
  ],
])("R01 rejects %s", (_name, key, change) => {
  const f = fixture();
  change(f);
  expect(checkR01(f.ctx)).toMatchObject({
    pass: false,
    checks: { [key]: false },
  });
});

it.each([
  [
    "weakened test",
    "confined",
    (f) => {
      put(f.repository, ordering, f.clean);
      put(
        f.repository,
        focus,
        'it("ascending", () => expect(true).toBe(true));\n',
      );
    },
  ],
  [
    "unrelated untracked edit",
    "confined",
    (f) => {
      put(f.repository, ordering, f.clean);
      put(f.repository, "unrelated.txt", "outside the repair\n");
    },
  ],
  [
    "wrong function",
    "originalBehavior",
    (f) => {
      const seed = readFileSync(join(f.repository, ordering), "utf8");
      put(
        f.repository,
        ordering,
        seed.replace(
          "function compareNumber(left: number, right: number): number {\n  return left < right ? -1 : left > right ? 1 : 0;",
          "function compareNumber(left: number, right: number): number {\n  return right < left ? -1 : right > left ? 1 : 0;",
        ),
      );
    },
  ],
])("R02 rejects %s", (_name, key, change) => {
  const f = fixture(true);
  change(f);
  expect(checkR02(f.ctx)).toMatchObject({
    pass: false,
    checks: { [key]: false },
  });
});

it("rejects a runtime archive in place of a source checkout", () => {
  expect(() => setup({ runtime: temp() })).toThrow("--context source");
});
