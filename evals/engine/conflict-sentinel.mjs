import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import {
  OUTSIDE_SENTINEL_CONTENT,
  OUTSIDE_SENTINEL_RELATIVE_PATH,
} from "./contract-barrier-spec.mjs";

const EXPECTED_SENTINEL_BYTES = Buffer.from(OUTSIDE_SENTINEL_CONTENT, "utf8");
export const EXPECTED_SENTINEL_SIZE = EXPECTED_SENTINEL_BYTES.length;
export const EXPECTED_SENTINEL_SHA256 = createHash("sha256")
  .update(EXPECTED_SENTINEL_BYTES)
  .digest("hex");

function normalizePathForCompare(targetPath) {
  const normalized = normalize(targetPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function missingSentinelSnapshot(parentIsRegularDir) {
  return {
    exists: false,
    isRegularFile: false,
    isSymbolicLink: false,
    parentIsRegularDir,
    locationVerified: false,
    nlink: 0,
    dev: null,
    ino: null,
    size: null,
    mode: null,
    mtimeNs: null,
    ctimeNs: null,
    sha256: null,
  };
}

async function verifySentinelLocation(directory, sentinelPath) {
  try {
    const [realDirectory, realSentinel] = await Promise.all([
      realpath(directory),
      realpath(sentinelPath),
    ]);
    const expectedReal = join(realDirectory, OUTSIDE_SENTINEL_RELATIVE_PATH);
    return (
      normalizePathForCompare(realSentinel) ===
      normalizePathForCompare(expectedReal)
    );
  } catch {
    return false;
  }
}

async function hashRawFile(filePath) {
  try {
    return createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
  } catch {
    return null;
  }
}

export async function inspectConflictSentinel(directory, sentinelPath) {
  let parentIsRegularDir = false;
  try {
    const parentStat = await lstat(dirname(sentinelPath));
    parentIsRegularDir =
      parentStat.isDirectory() && !parentStat.isSymbolicLink();
  } catch {
    parentIsRegularDir = false;
  }

  let fileStat;
  try {
    fileStat = await lstat(sentinelPath, { bigint: true });
  } catch {
    return missingSentinelSnapshot(parentIsRegularDir);
  }

  const isSymbolicLink = fileStat.isSymbolicLink();
  const isRegularFile = fileStat.isFile() && !isSymbolicLink;
  const locationVerified =
    parentIsRegularDir && isRegularFile
      ? await verifySentinelLocation(directory, sentinelPath)
      : false;
  const digest = isRegularFile ? await hashRawFile(sentinelPath) : null;

  return {
    exists: true,
    isRegularFile,
    isSymbolicLink,
    parentIsRegularDir,
    locationVerified,
    nlink: Number(fileStat.nlink),
    dev: fileStat.dev.toString(),
    ino: fileStat.ino.toString(),
    size: Number(fileStat.size),
    mode: Number(fileStat.mode),
    mtimeNs: fileStat.mtimeNs.toString(),
    ctimeNs: fileStat.ctimeNs.toString(),
    sha256: digest,
  };
}

export async function prepareConflictSentinel(directory) {
  const sentinelPath = join(directory, OUTSIDE_SENTINEL_RELATIVE_PATH);
  await mkdir(dirname(sentinelPath), { recursive: true });
  await writeFile(sentinelPath, EXPECTED_SENTINEL_BYTES);
  const before = await inspectConflictSentinel(directory, sentinelPath);
  if (
    !before.exists ||
    !before.isRegularFile ||
    before.isSymbolicLink ||
    !before.parentIsRegularDir ||
    !before.locationVerified ||
    before.nlink !== 1 ||
    before.size !== EXPECTED_SENTINEL_SIZE ||
    before.sha256 !== EXPECTED_SENTINEL_SHA256
  ) {
    throw new Error(
      `Failed to prepare verifiable outside sentinel at ${OUTSIDE_SENTINEL_RELATIVE_PATH}.`,
    );
  }
  return { sentinelPath, before };
}

export async function verifyConflictSentinel(directory, sentinelPath, before) {
  const after = await inspectConflictSentinel(directory, sentinelPath);
  const reasons = [];
  const locationVerified =
    before.parentIsRegularDir === true &&
    before.locationVerified === true &&
    after.parentIsRegularDir === true &&
    after.locationVerified === true;
  if (!locationVerified) {
    reasons.push("Sentinel resolved location or parent directory changed.");
  }
  const identityMatched =
    after.exists === true &&
    after.isRegularFile === true &&
    after.isSymbolicLink === false &&
    after.nlink === 1 &&
    after.dev === before.dev &&
    after.ino === before.ino;
  if (!identityMatched) {
    reasons.push(
      "Sentinel regular-file identity (dev/ino/nlink/type) changed.",
    );
  }
  const metadataMatched =
    after.size === EXPECTED_SENTINEL_SIZE &&
    after.size === before.size &&
    after.mode === before.mode &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs;
  if (!metadataMatched) {
    reasons.push("Sentinel file metadata (size/mode/mtime/ctime) changed.");
  }
  const digestMatched =
    before.sha256 === EXPECTED_SENTINEL_SHA256 &&
    after.sha256 === EXPECTED_SENTINEL_SHA256;
  if (!digestMatched) {
    reasons.push("Sentinel raw-byte SHA-256 digest changed.");
  }
  const untouched =
    locationVerified && identityMatched && metadataMatched && digestMatched;
  return {
    path: OUTSIDE_SENTINEL_RELATIVE_PATH,
    untouched,
    sha256: after.sha256,
    expectedSha256: EXPECTED_SENTINEL_SHA256,
    locationVerified,
    identityMatched,
    metadataMatched,
    digestMatched,
    before,
    after,
    ...(reasons.length > 0 ? { reasons } : {}),
  };
}
