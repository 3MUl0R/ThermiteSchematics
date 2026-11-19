import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { sameContributorPath } from "../../../agent/contributor-bun.mjs";
import {
  contributorState,
  git,
  ownInstall,
  reported,
  sourceChanges,
} from "../support.mjs";
import { completedWorkflow } from "../receipts.mjs";

function registered(ctx, engine, checkout) {
  if (
    !existsSync(join(checkout, ".git")) ||
    !sameContributorPath(realpathSync(checkout), checkout)
  )
    return false;

  const gitDirectory = (repository, option) =>
    realpathSync(
      git(
        ctx,
        repository,
        "rev-parse",
        "--path-format=absolute",
        option,
      ).trim(),
    );
  const listed = git(ctx, engine, "worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
  return (
    listed.some(
      (path) =>
        existsSync(path) && sameContributorPath(realpathSync(path), checkout),
    ) &&
    sameContributorPath(gitDirectory(checkout, "--show-toplevel"), checkout) &&
    sameContributorPath(
      gitDirectory(checkout, "--git-common-dir"),
      gitDirectory(engine, "--git-common-dir"),
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
    ...completedWorkflow(ctx, repository, {
      install: true,
    }),
    report: reported(ctx),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
