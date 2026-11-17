import { posix } from "node:path";
// The sole compound exception: a GET followed by this local JSON projection.
// Match the whole program; do not execute it or merely search for Bun.file.
export function downloadedJson(tail, output) {
  if (
    !output ||
    tail.length !== 3 ||
    posix.basename(tail[0]) !== "bun" ||
    tail[1] !== "-e"
  )
    return false;
  // The recorded CLI transport retains escaped double quotes in its wrapper.
  const program = tail[2].replace(/\\+"/g, '"');
  const match =
    /^const ([A-Za-z_]\w*)\s*=\s*await Bun\.file\(("[^"\\]*"|'[^'\\]*')\)\.json\(\);\s*console\.log\(JSON\.stringify\(\1\.map\(([A-Za-z_]\w*)\s*=>\s*\(\{([^{}]+)\}\)\)(?:,\s*null,\s*2)?\)\);?$/.exec(
      program,
    );
  if (
    !match ||
    posix.normalize(match[2].slice(1, -1)) !== posix.normalize(output)
  )
    return false;
  const field = new RegExp(
    `^[A-Za-z_]\\w*\\s*:\\s*${match[3]}\\.[A-Za-z_]\\w*$`,
  );
  return match[4].split(",").every((entry) => field.test(entry.trim()));
}
