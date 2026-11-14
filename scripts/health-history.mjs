import { spawnSync } from "node:child_process";
import { inScope, measureSources } from "./health-measure.mjs";
import { createBudget } from "./health-policy.mjs";
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
export function readHistory(root) {
  const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  });
  // Empty repositories are used by the synthetic checker tests, not engine PRs.
  if (head.status !== 0) return undefined;
  const ref = ["refs/heads/dev", "refs/remotes/origin/dev"].find(
    (name) =>
      spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", name])
        .status === 0,
  );
  const revision = ref
    ? git(root, ["merge-base", "HEAD", ref]).toString("utf8").trim()
    : head.stdout.trim();
  const previous = spawnSync(
    "git",
    ["-C", root, "show", `${revision}:scripts/health-budget.json`],
    { encoding: "utf8" },
  );
  if (previous.status !== 0)
    throw Error("Health history: baseline has no committed health budget");
  const metrics = historicalMetrics(root, revision),
    raw = JSON.parse(previous.stdout);
  // The v2 -> v3 scope expansion is authenticated against base source, never HEAD.
  const budget =
    raw.version === 2 ? createBudget(metrics, raw.thresholds) : raw;
  return { revision, metrics, budget };
}
