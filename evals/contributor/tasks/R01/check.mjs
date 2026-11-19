import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sameContributorPath } from "../../../agent/contributor-bun.mjs";
import {
  contributorState,
  git,
  ownInstall,
  reported,
  sourceChanges,
} from "../support.mjs";
import { completedWorkflow } from "../receipts.mjs";

function gitPath(ctx, repository, option) {
  const path = git(
    ctx,
    repository,
    "rev-parse",
    "--path-format=absolute",
    option,
  ).trimEnd();
  return realpathSync(resolve(repository, path));
}

function registered(ctx, engine, checkout) {
  const marker = join(checkout, ".git");
  if (
    !existsSync(marker) ||
    !lstatSync(checkout).isDirectory() ||
    !lstatSync(marker).isFile()
  )
    return false;

  const engineCommon = gitPath(ctx, engine, "--git-common-dir");
  const admin = gitPath(ctx, checkout, "--absolute-git-dir");
  const backlink = join(admin, "gitdir");
  // A linked checkout has a private Git directory in the engine's registry.
  // Git records a pointer back to the checkout's .git file in that directory.
  if (
    !sameContributorPath(dirname(admin), join(engineCommon, "worktrees")) ||
    !existsSync(backlink) ||
    !lstatSync(backlink).isFile()
  )
    return false;
  const registeredMarker = resolve(
    admin,
    readFileSync(backlink, "utf8").trimEnd(),
  );
  return (
    existsSync(registeredMarker) &&
    sameContributorPath(realpathSync(registeredMarker), realpathSync(marker)) &&
    sameContributorPath(
      gitPath(ctx, checkout, "--show-toplevel"),
      realpathSync(checkout),
    ) &&
    sameContributorPath(
      gitPath(ctx, checkout, "--git-common-dir"),
      engineCommon,
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
