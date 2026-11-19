import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellCommand } from "../../agent/launch.mjs";
import { focus, run, seedPatch } from "./support.mjs";

export function contributorReference(ctx, seeded) {
  const engine = join(ctx.project, "engine"),
    repository = join(ctx.project, ctx.task.contributor.checkout);
  let calls = 0;
  const command = (cwd, executable, argv, expected = 0, bun = false) => {
    const worker = ctx.env.THERMITE_CONTRIBUTOR_BUN;
    assert(!bun || worker, "Missing contributor command observer");
    // POSIX references also exercise discovery through the recorded PATH.
    // Windows references run the same observer without invoking cmd.exe.
    const result =
      bun && process.platform === "win32"
        ? run(ctx, cwd, process.execPath, [worker, ...argv])
        : run(ctx, cwd, executable, argv);
    console.log(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "contributor-" + ++calls,
          type: "command_execution",
          command: shellCommand([executable, ...argv]),
          exit_code: result.exit,
          aggregated_output: (result.stdout + result.stderr).slice(-4000),
        },
      }),
    );
    assert.equal(result.exit, expected, result.stdout + result.stderr);
    return result;
  };
  const observedBun = (args, expected) =>
    command(repository, "bun", args, expected, true);
  if (seeded) {
    const red = observedBun(["scripts/test.mjs", focus], 1);
    assert.match(red.stdout + red.stderr, /to be less than 0/);
    command(repository, "git", ["apply", "--reverse", seedPatch]);
  } else {
    command(engine, "git", ["worktree", "add", "--detach", "../worktree"]);
    observedBun(["install", "--frozen-lockfile"]);
  }
  observedBun(["scripts/test.mjs", focus]);
  observedBun(["run", "build"]);
  const setup = seeded
    ? "The focused test exposed the reversed comparator. Restored its original ascending behavior."
    : "Created the linked worktree and installed its frozen dependencies with bun install --frozen-lockfile.";
  const message = `${setup}\n\nbun scripts/test.mjs ${focus} passed. bun run build passed.\n`;
  writeFileSync(join(ctx.project, "contributor-friction.md"), message);
  return message;
}
