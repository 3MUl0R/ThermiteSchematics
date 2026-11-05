import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hash, json } from "./support.mjs";

// Include the complete sorted module inventory, including native helper source.
export const checkerManifestHash = (checkers) =>
  hash(
    json(
      Object.entries(checkers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
export async function readCheckers(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory))
        .filter((p) => p.endsWith(".mjs") || p.endsWith(".swift"))
        .sort()
        .map(async (p) => [p, hash(await readFile(join(directory, p)))]),
    ),
  );
}
