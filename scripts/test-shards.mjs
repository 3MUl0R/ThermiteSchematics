import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

const { files: DURATIONS } = JSON.parse(
  readFileSync(new URL("./test-durations.json", import.meta.url), "utf8"),
);
const DEFAULT_SHARD_WEIGHT = 2;

export function parseShard(spec) {
  if (typeof spec !== "string" || !/^[1-9]\d*\/[1-9]\d*$/.test(spec)) {
    throw new Error(
      `Invalid --shard value "${spec}"; expected <index>/<count> with 1 <= index <= count.`,
    );
  }
  const [index, count] = spec.split("/").map(Number);
  if (index > count) {
    throw new Error(
      `Invalid --shard value "${spec}"; shard index ${index} exceeds shard count ${count}.`,
    );
  }
  return { index, count };
}

function durationEntry(relativePath, platform = process.platform) {
  const normalized = relativePath.replaceAll("\\", "/");
  const entry = DURATIONS[normalized];
  if (!entry) return undefined;
  return platform === "win32" ? entry[1] : entry[0];
}

export function sortDuration(relativePath, platform = process.platform) {
  return durationEntry(relativePath, platform) ?? 0;
}

export function shardWeight(relativePath, platform = process.platform) {
  return durationEntry(relativePath, platform) ?? DEFAULT_SHARD_WEIGHT;
}

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function partitionShard(
  items,
  index,
  count,
  { key = (item) => String(item), weight = () => 1, group = () => "" } = {},
) {
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    index > count
  ) {
    throw new Error(`Invalid shard ${index}/${count}.`);
  }
  const buckets = Array.from({ length: count }, () => []);
  const groups = new Map();
  for (const item of items) {
    const name = group(item);
    const list = groups.get(name);
    if (list) list.push(item);
    else groups.set(name, [item]);
  }
  for (const name of [...groups.keys()].sort(compareStrings)) {
    const loads = Array(count).fill(0);
    const ordered = [...groups.get(name)].sort(
      (a, b) => weight(b) - weight(a) || compareStrings(key(a), key(b)),
    );
    for (const item of ordered) {
      let target = 0;
      for (let i = 1; i < count; i++) {
        if (loads[i] < loads[target]) target = i;
      }
      buckets[target].push(item);
      loads[target] += weight(item);
    }
  }
  return buckets[index - 1];
}

export function extractShardArg(args) {
  let shard;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list-files") continue;
    if (arg.startsWith("--shard=")) {
      shard = arg.slice("--shard=".length);
      continue;
    }
    if (arg === "--shard" && i + 1 < args.length) {
      shard = args[++i];
      continue;
    }
    rest.push(arg);
  }
  if (shard !== undefined) parseShard(shard);
  return { shard, filters: rest };
}

export async function listTestFiles(args, { cwd = process.cwd() } = {}) {
  const { shard, filters } = extractShardArg(args);
  const { createVitest } = await import("vitest/node");
  const runner = await createVitest("test", {
    root: cwd,
    watch: false,
    ...(shard ? { shard } : {}),
  });
  try {
    let specs = await runner.globTestSpecifications(filters);
    if (runner.config.shard) {
      const Sequencer = runner.config.sequence.sequencer;
      const sequencer = new Sequencer(runner);
      specs = await sequencer.shard(Array.from(specs));
    }
    return specs
      .map((spec) =>
        relative(runner.config.root, spec.moduleId).split(sep).join("/"),
      )
      .sort(compareStrings);
  } finally {
    await runner.close();
  }
}
