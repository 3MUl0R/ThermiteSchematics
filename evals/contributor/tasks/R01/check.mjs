import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  contributorState,
  git,
  ownInstall,
  reported,
  sourceChanges,
} from "../support.mjs";
import { completedWorkflow, observedCommands } from "../receipts.mjs";

function registered(ctx, engine, checkout) {
  return (
    existsSync(join(checkout, ".git")) &&
    realpathSync(checkout) === checkout &&
    git(ctx, engine, "worktree", "list", "--porcelain", "-z")
      .split("\0")
      .filter((entry) => entry.startsWith("worktree "))
      .map((entry) => entry.slice("worktree ".length))
      .some((path) => existsSync(path) && realpathSync(path) === checkout) &&
    realpathSync(git(ctx, checkout, "rev-parse", "--show-toplevel").trim()) ===
      checkout &&
    git(
      ctx,
      engine,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ) ===
      git(
        ctx,
        checkout,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      )
  );
}

export default function check(ctx) {
  const project = realpathSync(ctx.project),
    engine = join(project, "engine"),
    repository = join(project, "worktree"),
    worktree = registered(ctx, engine, repository);
  if (!worktree) return { pass: false, checks: { worktree } };
  const { revision } = contributorState(ctx);
  const checks = {
    worktree,
    sourceUnchanged: [engine, repository].every(
      (dir) => sourceChanges(ctx, dir, revision).length === 0,
    ),
    ownInstall: ownInstall(repository),
    ...completedWorkflow(observedCommands(ctx, repository), repository, {
      install: true,
    }),
    report: reported(ctx),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
