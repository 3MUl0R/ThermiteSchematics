import { expect, it } from "vitest";
import { existsSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { contributorSourceDigest } from "../../agent/contributor-bun.mjs";
import { bun, focus, ordering } from "./support.mjs";
import {
  copy,
  fixture,
  observeIn,
  observer,
  put,
  root,
} from "./test-fixture.mjs";
import { completedWorkflow, observedCommands } from "./receipts.mjs";

it("records real install and test outcomes for the alternate PATH-shim invocations", () => {
  const f = fixture();
  const project = f.ctx.project;
  // An empty package installs without network access. The test script is a
  // reporter stub so this control can force a nonzero exit and a stale report.
  put(f.repository, "package.json", '{"scripts":{"build":"bun build.mjs"}}');
  expect(bun(f.ctx, f.repository, "install", "--lockfile-only").exit).toBe(0);
  observer(f, "worktree");
  expect(
    observeIn(f, project, "--cwd", "worktree", "i", "--frozen-lockfile").exit,
  ).toBe(0);
  put(
    f.repository,
    "scripts/test.mjs",
    `
    import { mkdirSync, writeFileSync } from "node:fs";
    const flags = process.argv.slice(2);
    if (flags.includes("-t") && flags[flags.indexOf("-t") + 1] !== "focused cases")
      process.exit(3);
    mkdirSync("coverage", { recursive: true });
    if (process.env.THERMITE_TEST_TIMINGS !== "1") process.exit(2);
    writeFileSync("coverage/test-timings.json", JSON.stringify({
      numPassedTests: 7, numTotalTests: 7, numFailedTests: 0,
      testResults: [{ name: process.cwd() + "/${focus}" }],
    }));
  `,
  );
  expect(
    observeIn(f, project, "--cwd=worktree", "./scripts/test.mjs", "./" + focus)
      .exit,
  ).toBe(0);
  expect(
    observeIn(
      f,
      f.repository,
      join(f.repository, "scripts/test.mjs"),
      "-t",
      "focused cases",
      join(f.repository, focus),
    ).exit,
  ).toBe(0);
  put(f.repository, "scripts/test.mjs", "process.exitCode = 1;\n");
  expect(observeIn(f, f.repository, "scripts/test.mjs", focus).exit).toBe(1);
  const rows = observedCommands(f.ctx, f.repository);
  expect(rows.map(({ kind, exit }) => [kind, exit])).toEqual([
    ["install", 0],
    ["focused", 0],
    ["focused", 0],
    ["focused", 1],
  ]);
  expect(rows[2].argv).toEqual([
    "scripts/test.mjs",
    "-t",
    "focused cases",
    focus,
  ]);
  expect(rows[2].tests.passed).toBe(7);
  expect(rows[2].sourceSha256).toBe(contributorSourceDigest(f.repository));
  expect(rows[3].tests).toBeNull();
  f.rows.push(rows[0], rows[3]);
  f.save();
  expect(
    completedWorkflow(f.ctx, f.repository, { install: true }).focused,
  ).toBe(false);
});

it("records and rejects unsupported focused flags before running the test script", () => {
  const f = fixture();
  observer(f, "worktree");
  put(
    f.repository,
    "scripts/test.mjs",
    'await Bun.write("ran-focused", "unexpected invocation");\n',
  );
  const rejected = [
    ["--config", "other.mjs"],
    ["--root=other"],
    ["--outputFile.json=other.json"],
    ["--outputFile", "other.json"],
    ["--setupFiles", "other.mjs"],
    ["-t", "--config=other.mjs"],
    ["other.test.ts"],
  ];
  for (const args of rejected) {
    const run = observeIn(f, f.repository, "scripts/test.mjs", focus, ...args);
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "Unsupported contributor focused test argument",
    );
  }
  expect(existsSync(join(f.repository, "ran-focused"))).toBe(false);
  expect(observedCommands(f.ctx, f.repository)).toMatchObject(
    rejected.map((args) => ({
      kind: "focused",
      exit: 1,
      rejected: args[0],
      requestedArgv: ["scripts/test.mjs", focus, ...args],
    })),
  );
});

function writeTranscript(f, invocations, agent = "codex") {
  const rows = invocations.flatMap(([command, exit], index) =>
    agent === "codex"
      ? [
          {
            type: "item.completed",
            item: {
              id: String(index),
              type: "command_execution",
              command,
              exit_code: exit,
            },
          },
        ]
      : [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Bash",
                  id: String(index),
                  input: { command },
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: String(index),
                  is_error: exit !== 0,
                },
              ],
            },
          },
        ],
  );
  put(
    f.ctx.evidence,
    "transcript.jsonl",
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
}

function prepareDirect(f, checkout) {
  const dir = f.repository;
  observer(f, checkout);
  copy(dir, "scripts/test.mjs");
  put(
    dir,
    "node_modules/vitest/vitest.mjs",
    `
    import { join } from "node:path";
    await Bun.write("coverage/test-timings.json", JSON.stringify({
      numPassedTests: 7, numTotalTests: 7, numFailedTests: 0,
      testResults: [{ name: join(process.cwd(), "${focus}") }],
    }));
  `,
  );
  put(
    dir,
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: { build: "bun node_modules/typescript/lib/tsc.js -b" },
    }),
  );
  const typescript = join(dir, "node_modules/typescript");
  rmSync(typescript, { recursive: true });
  symlinkSync(
    join(root, "node_modules/typescript"),
    typescript,
    process.platform === "win32" ? "junction" : "dir",
  );
  const projects = ["packages/cli", "packages/query"];
  put(
    dir,
    "tsconfig.json",
    JSON.stringify({
      files: [],
      references: projects.map((path) => ({ path })),
    }),
  );
  for (const project of projects)
    put(
      dir,
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          rootDir: "src",
          outDir: "dist",
          types: [],
        },
        include: ["src/*.ts"],
      }),
    );
  put(dir, ordering, "export const rank = 1;\n");
  const build = () => bun(f.ctx, dir, "run", "build");
  const test = (...args) =>
    bun(f.ctx, dir, join(dir, "scripts/test.mjs"), ...args, join(dir, focus));
  return { build, test };
}

// PowerShell uses the call operator for a quoted executable path.
const binary = `${process.platform === "win32" ? "& " : ""}"${process.execPath}"`;

it.each(["codex", "claude"])(
  "binds %s absolute Bun commands to test and build artifacts",
  (agent) => {
    const f = fixture();
    const { build, test } = prepareDirect(f, "worktree");
    const workflow = () =>
      completedWorkflow(f.ctx, f.repository, { install: true });
    const commands = [
      [`${binary} --cwd worktree i --frozen-lockfile`, 0],
      [
        `cd worktree && ${binary} "${join(f.ctx.project, "worktree", "scripts/test.mjs")}" "${join(f.ctx.project, "worktree", focus)}"`,
        0,
      ],
      [`${binary} --cwd=worktree run build`, 0],
    ];
    const write = (rows) =>
      writeTranscript(
        f,
        agent === "codex" && process.platform !== "win32"
          ? rows.map(([command, exit]) => [`/bin/zsh -lc '${command}'`, exit])
          : rows,
        agent,
      );
    write(commands);
    expect(workflow().focused).toBe(false);
    const built = build();
    expect(built.exit, built.stdout + built.stderr).toBe(0);
    expect(
      test("--testNamePattern=focused", "--no-color", "--silent").exit,
    ).toBe(0);
    expect(observedCommands(f.ctx, f.repository).at(-1).argv).toEqual([
      "scripts/test.mjs",
      "--testNamePattern=focused",
      "--no-color",
      "--silent=true",
      focus,
    ]);
    const emitted = join(f.repository, "packages/query/dist/ordering.js");
    utimesSync(emitted, new Date(0), new Date(0));
    expect(workflow()).toEqual({
      installed: true,
      focused: true,
      freshBuild: true,
    });
    write([commands[0], commands[2], commands[1]]);
    expect(workflow().freshBuild).toBe(true);
    write([...commands.slice(0, 2), [commands[2][0], 1]]);
    expect(workflow().freshBuild).toBe(false);
    write([...commands.slice(0, 2), [commands[2][0] + " ; true", 0]]);
    expect(workflow().freshBuild).toBe(false);
    write(commands);
    put(f.repository, "packages/query/dist/ordering.js", "stale output\n");
    const future = new Date(Date.now() + 10000);
    utimesSync(emitted, future, future);
    expect(workflow().freshBuild).toBe(false);
  },
);

it("requires a direct R02 focused receipt from the final source even after a successful rebuild", () => {
  const f = fixture(true);
  const { build, test } = prepareDirect(f, "engine");
  const workflow = () =>
    completedWorkflow(f.ctx, f.repository, { queryRepair: true });
  writeTranscript(f, [
    [`${binary} --cwd=engine scripts/test.mjs "${focus}"`, 0],
    [`${binary} --cwd=engine run build`, 0],
  ]);
  expect(test("--outputFile=other.json").exit).toBe(1);
  expect(observedCommands(f.ctx, f.repository).at(-1).rejected).toBe(
    "--outputFile=other.json",
  );
  expect(test().exit).toBe(0);
  put(f.repository, ordering, "export const rank = 2;\n");
  const built = build();
  expect(built.exit, built.stdout + built.stderr).toBe(0);
  expect(workflow()).toEqual({ focused: false, freshBuild: false });
  expect(test().exit).toBe(0);
  expect(workflow()).toEqual({ focused: true, freshBuild: true });
});
