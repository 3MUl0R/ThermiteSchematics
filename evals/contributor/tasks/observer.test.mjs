import { expect, it } from "vitest";
import { join } from "node:path";
import { bun, focus } from "./support.mjs";
import { fixture, observeIn, observer, put } from "./test-fixture.mjs";
import { completedWorkflow, observedCommands } from "./receipts.mjs";
import checkR01 from "./R01/check.mjs";

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
  expect(rows[3].tests).toBeNull();
  f.rows.push(rows[0], rows[3]);
  f.save();
  expect(
    completedWorkflow(f.ctx, f.repository, { install: true }).focused,
  ).toBe(false);
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

it.each(["codex", "claude"])(
  "binds %s absolute Bun commands to test and build artifacts",
  (agent) => {
    const f = fixture();
    f.rows.splice(0);
    f.save();
    const binary = `"${process.execPath}"`;
    const commands = [
      [`${binary} --cwd worktree i --frozen-lockfile`, 0],
      [`cd worktree && ${binary} ./scripts/test.mjs "./${focus}"`, 0],
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
    expect(checkR01(f.ctx).checks.focused).toBe(false);
    put(
      f.repository,
      "coverage/test-timings.json",
      JSON.stringify({
        numPassedTests: 7,
        numTotalTests: 7,
        numFailedTests: 0,
        testResults: [{ name: join(f.repository, focus) }],
      }),
    );
    expect(checkR01(f.ctx).pass).toBe(true);
    write([commands[0], commands[2], commands[1]]);
    expect(checkR01(f.ctx).checks.freshBuild).toBe(false);
    expect(
      completedWorkflow(f.ctx, f.repository, { queryRepair: true }).freshBuild,
    ).toBe(true);
    write([...commands.slice(0, 2), [commands[2][0], 1]]);
    expect(checkR01(f.ctx).checks.freshBuild).toBe(false);
    write([...commands.slice(0, 2), [commands[2][0] + " ; true", 0]]);
    expect(checkR01(f.ctx).checks.freshBuild).toBe(false);
  },
);
