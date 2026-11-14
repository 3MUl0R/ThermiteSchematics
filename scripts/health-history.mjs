import { spawnSync } from "node:child_process";
import { inScope, measureSources } from "./health-measure.mjs";
import { upgradeBudget } from "./health-budget.mjs";
function git(root, args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw Error(`Health history: git ${args[0]} failed`);
  return result.stdout;
}
export function historicalMetrics(root, revision) {
  const paths = git(root, ["ls-tree", "-rz", "--name-only", revision])
    .toString("utf8")
    .split("\0")
    .filter(inScope);
  const bytes = git(root, ["cat-file", "--batch", "-z"], {
    input: paths.map((p) => `${revision}:${p}\0`).join(""),
  });
  let offset = 0;
  const sources = new Map();
  for (const path of paths) {
    const end = bytes.indexOf(10, offset),
      header = bytes.subarray(offset, end).toString("utf8");
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
    if (!match) throw Error(`Health history: cannot read ${revision}:${path}`);
    const size = Number(match[1]);
    sources.set(path, bytes.subarray(end + 1, end + 1 + size).toString("utf8"));
    offset = end + 1 + size + 1;
  }
  return measureSources(paths, (path) => sources.get(path));
}
function resolveRef(root, ref) {
  const result = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function ancestor(root, first, second) {
  return (
    spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", first, second])
      .status === 0
  );
}
export function baselineRef(root, env = process.env) {
  if (env.GITHUB_BASE_REF) {
    const name = `refs/remotes/origin/${env.GITHUB_BASE_REF}`;
    if (resolveRef(root, name)) return name;
    if (env.THERMITE_HEALTH_ALLOW_NO_BASE === "1") return undefined;
    throw Error(
      `Health history: PR baseline ${name} is missing; fetch the PR base with full history (fetch-depth: 0).`,
    );
  }
  const remote = "refs/remotes/origin/dev",
    local = "refs/heads/dev";
  const remoteCommit = resolveRef(root, remote),
    localCommit = resolveRef(root, local);
  if (remoteCommit && localCommit) {
    if (ancestor(root, localCommit, remoteCommit)) return remote;
    if (ancestor(root, remoteCommit, localCommit)) return local;
    throw Error(
      "Health history: dev and origin/dev diverge; fetch/reconcile the baseline refs.",
    );
  }
  if (remoteCommit) return remote;
  if (localCommit) return local;
  if (env.THERMITE_HEALTH_ALLOW_NO_BASE === "1") return undefined;
  throw Error(
    "Health history: no health baseline; fetch the PR base or origin/dev with full history. THERMITE_HEALTH_ALLOW_NO_BASE=1 is only for synthetic test repositories.",
  );
}
export function readHistory(root, env = process.env) {
  const ref = baselineRef(root, env),
    head = resolveRef(root, "HEAD");
  if (!head) {
    if (env.THERMITE_HEALTH_ALLOW_NO_BASE === "1" && !ref) return undefined;
    throw Error(
      "Health history: HEAD is missing; no authenticated baseline is available.",
    );
  }
  const merged = ref
    ? spawnSync("git", ["-C", root, "merge-base", "HEAD", ref], {
        encoding: "utf8",
      })
    : { status: 0, stdout: head };
  if (merged.status !== 0)
    throw Error(
      `Health history: no merge-base with ${ref}; fetch full history (git fetch --unshallow, or actions/checkout fetch-depth: 0).`,
    );
  const revision = merged.stdout.trim();
  const previous = spawnSync(
    "git",
    ["-C", root, "show", `${revision}:scripts/health-budget.json`],
    { encoding: "utf8" },
  );
  if (previous.status !== 0)
    throw Error("Health history: baseline has no committed health budget");
  const metrics = historicalMetrics(root, revision),
    raw = JSON.parse(previous.stdout);
  return {
    revision,
    ref: ref ?? "HEAD (explicit synthetic opt-in)",
    metrics,
    budget: upgradeBudget(raw, metrics),
  };
}
