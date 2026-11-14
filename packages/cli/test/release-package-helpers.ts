import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect } from "vitest";
import { resolveHeadCommit } from "../../../scripts/release-common.mjs";
import { createDeterministicTar } from "../../../scripts/release-package.mjs";
import { auditReleaseOutputs } from "../../../scripts/release-tar-audit.mjs";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const sourceCommit = await resolveHeadCommit(repositoryRoot);
const picomatchError =
  "PKG006 Third-party identity 'picomatch@2.3.2' does not match lock key 'node_modules/micromatch/node_modules/picomatch'.";

function expectBuffersIdentical(
  actual: Buffer | undefined,
  expected: Buffer | undefined,
  label: string,
): void {
  if (!Buffer.isBuffer(actual)) {
    throw new TypeError(label + ": actual value is not a Buffer.");
  }
  if (!Buffer.isBuffer(expected)) {
    throw new TypeError(label + ": expected value is not a Buffer.");
  }
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(
      label +
        ": byte lengths differ (" +
        actual.byteLength +
        " !== " +
        expected.byteLength +
        ").",
    );
  }
  if (actual.equals(expected)) return;

  let offset = 0;
  while (actual[offset] === expected[offset]) offset += 1;
  throw new Error(label + ": bytes differ at offset " + offset + ".");
}

function expectByteMapsIdentical(
  actual: ReadonlyMap<string, Buffer> | undefined,
  expected: ReadonlyMap<string, Buffer> | undefined,
  label: string,
): void {
  if (actual === undefined) {
    throw new TypeError(label + ": actual byte map is undefined.");
  }
  if (expected === undefined) {
    throw new TypeError(label + ": expected byte map is undefined.");
  }
  const actualPaths = [...actual.keys()].sort();
  const expectedPaths = [...expected.keys()].sort();
  expect(actualPaths, label + ": path sets differ").toEqual(expectedPaths);
  for (const path of expectedPaths) {
    expectBuffersIdentical(
      actual.get(path),
      expected.get(path),
      label + ": " + path,
    );
  }
}

function expectByteMapArraysIdentical(
  actual: readonly ReadonlyMap<string, Buffer>[],
  expected: readonly ReadonlyMap<string, Buffer>[] | undefined,
  label: string,
): void {
  if (expected === undefined) {
    throw new TypeError(label + ": expected byte-map array is undefined.");
  }
  expect(actual, label + ": map counts differ").toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expectByteMapsIdentical(
      actual[index],
      expected[index],
      label + "[" + index + "]",
    );
  }
}

function expectDeterministicTarResultsIdentical(
  actual: Awaited<ReturnType<typeof createDeterministicTar>>,
  expected: Awaited<ReturnType<typeof createDeterministicTar>> | undefined,
  label: string,
): void {
  if (expected === undefined) {
    throw new TypeError(label + ": expected tar result is undefined.");
  }
  expect(Object.keys(actual).sort(), label + ": result keys differ").toEqual(
    Object.keys(expected).sort(),
  );
  expectBuffersIdentical(actual.gzip, expected.gzip, label + ": gzip");
  expect(actual.headers, label + ": headers differ").toEqual(expected.headers);
  expect(actual.stageFiles, label + ": stage files differ").toEqual(
    expected.stageFiles,
  );
}

function expectReleaseOutputMapsIdentical(
  actual: ReadonlyMap<string, Buffer | string> | undefined,
  expected: ReadonlyMap<string, Buffer | string> | undefined,
  label: string,
): void {
  if (actual === undefined) {
    throw new TypeError(label + ": actual release-output map is undefined.");
  }
  if (expected === undefined) {
    throw new TypeError(label + ": expected release-output map is undefined.");
  }
  const actualPaths = [...actual.keys()].sort();
  const expectedPaths = [...expected.keys()].sort();
  expect(actualPaths, label + ": path sets differ").toEqual(expectedPaths);
  for (const path of expectedPaths) {
    const actualValue = actual.get(path);
    const expectedValue = expected.get(path);
    if (Buffer.isBuffer(actualValue) && Buffer.isBuffer(expectedValue)) {
      expectBuffersIdentical(actualValue, expectedValue, label + ": " + path);
    } else if (
      typeof actualValue === "string" &&
      typeof expectedValue === "string"
    ) {
      expect(actualValue, label + ": " + path + " differs").toBe(expectedValue);
    } else {
      throw new TypeError(label + ": value types differ at " + path + ".");
    }
  }
}

function expectAuditResultsIdentical(
  actual: Awaited<ReturnType<typeof auditReleaseOutputs>>,
  expected: Awaited<ReturnType<typeof auditReleaseOutputs>>,
  label: string,
): void {
  expect(Object.keys(actual).sort(), label + ": result keys differ").toEqual(
    Object.keys(expected).sort(),
  );
  expect(actual.artifactSha, label + ": artifact SHA differs").toBe(
    expected.artifactSha,
  );
  expect(
    Object.keys(actual.parsed).sort(),
    label + ": parsed keys differ",
  ).toEqual(Object.keys(expected.parsed).sort());
  expect(actual.parsed.entries, label + ": tar entries differ").toEqual(
    expected.parsed.entries,
  );
  expectByteMapsIdentical(
    actual.parsed.files,
    expected.parsed.files,
    label + ": parsed files",
  );
  expect(actual.headers, label + ": headers differ").toEqual(expected.headers);
  expect(actual.stageFiles, label + ": stage files differ").toEqual(
    expected.stageFiles,
  );
  expect(actual.closure, label + ": closure differs").toEqual(expected.closure);
  expect(actual.licenses, label + ": licenses differ").toEqual(
    expected.licenses,
  );
  expect(actual.provenance, label + ": provenance differs").toEqual(
    expected.provenance,
  );
}

function installedPath(modulesRoot: string, lockKey: string, path: string) {
  return join(
    modulesRoot,
    ...lockKey.slice("node_modules/".length).split("/"),
    ...path.split("/"),
  );
}

async function copyRecordedThirdPartyTree(
  modulesRoot: string,
  inventory: {
    packages: {
      lockKey: string;
      files: { path: string }[];
    }[];
  },
) {
  await mkdir(modulesRoot);
  for (const package_ of inventory.packages) {
    for (const file of package_.files) {
      const destination = installedPath(
        modulesRoot,
        package_.lockKey,
        file.path,
      );
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(
        join(
          repositoryRoot,
          "node_modules",
          ...package_.lockKey.slice("node_modules/".length).split("/"),
          ...file.path.split("/"),
        ),
        destination,
      );
    }
  }
}

function shellWithoutCommentsAndHeredocs(source: string): string {
  const activeLines: string[] = [];
  const pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];
  for (const line of source.split("\n")) {
    const pending = pendingHeredocs[0];
    if (pending !== undefined) {
      const candidate = pending.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (candidate === pending.delimiter) {
        expect(line).not.toContain("\t");
        pendingHeredocs.shift();
      }
      activeLines.push("");
      continue;
    }

    let code = "";
    let quote: "single" | "double" | undefined;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) {
        code += character;
        escaped = false;
        continue;
      }
      if (quote === "single") {
        code += character;
        if (character === "'") quote = undefined;
        continue;
      }
      if (quote === "double") {
        code += character;
        if (character?.charCodeAt(0) === 0x5c) escaped = true;
        else if (character === '"') quote = undefined;
        continue;
      }
      if (character === "'") {
        quote = "single";
        code += character;
        continue;
      }
      if (character === '"') {
        quote = "double";
        code += character;
        continue;
      }
      if (
        character === "#" &&
        (index === 0 || /[\s;&|()]/u.test(line[index - 1] ?? ""))
      ) {
        break;
      }
      if (
        character === "<" &&
        line[index + 1] === "<" &&
        line[index + 2] !== "<"
      ) {
        let cursor = index + 2;
        let stripTabs = false;
        if (line[cursor] === "-") {
          stripTabs = true;
          cursor += 1;
        }
        while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
        const delimiterQuote =
          line[cursor] === "'" || line[cursor] === '"'
            ? line[cursor]
            : undefined;
        if (delimiterQuote !== undefined) cursor += 1;
        const delimiterStart = cursor;
        if (delimiterQuote === undefined) {
          while (
            cursor < line.length &&
            !/[\s;&|()<>]/u.test(line[cursor] ?? "")
          ) {
            cursor += 1;
          }
        } else {
          while (cursor < line.length && line[cursor] !== delimiterQuote) {
            cursor += 1;
          }
        }
        const delimiter = line.slice(delimiterStart, cursor);
        expect(delimiter).not.toBe("");
        expect(delimiter).not.toMatch(/[\t\r]/u);
        if (delimiterQuote !== undefined) {
          expect(line[cursor]).toBe(delimiterQuote);
        }
        pendingHeredocs.push({ delimiter, stripTabs });
      }
      code += character;
    }
    activeLines.push(code);
  }
  expect(pendingHeredocs).toEqual([]);
  return activeLines.join("\n");
}

function assertInProcessLauncherSyntax(source: string): void {
  const code = shellWithoutCommentsAndHeredocs(source);
  const substitutions: string[] = [];
  let doubleBrackets = 0;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let tokens = "";
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (escaped) {
      escaped = false;
      tokens += " ";
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      tokens += " ";
      continue;
    }
    if (quote === "double") {
      if (character?.charCodeAt(0) === 0x5c) escaped = true;
      else if (character === '"') quote = undefined;
      tokens += " ";
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokens += " ";
    } else if (character === '"') {
      quote = "double";
      tokens += " ";
    } else if (
      (character === "$" || character === "<") &&
      code[index + 1] === "("
    ) {
      substitutions.push(character + "(");
      tokens += "  ";
      index += 1;
    } else if (character === ")" && substitutions.length !== 0) {
      substitutions.pop();
      tokens += " ";
    } else if (character === "[" && code[index + 1] === "[") {
      doubleBrackets += 1;
      tokens += "  ";
      index += 1;
    } else if (character === "]" && code[index + 1] === "]") {
      expect(doubleBrackets).toBeGreaterThan(0);
      doubleBrackets -= 1;
      tokens += "  ";
      index += 1;
    } else {
      tokens += character;
    }
  }
  expect(escaped).toBe(false);
  expect(quote).toBeUndefined();
  expect(substitutions).toEqual([]);
  expect(doubleBrackets).toBe(0);

  const blocks: { kind: "if" | "loop" | "case"; body: boolean }[] = [];
  for (const match of tokens.matchAll(
    /\b(?:if|then|elif|fi|for|while|do|done|case|esac)\b/gu,
  )) {
    const token = match[0];
    const current = blocks.at(-1);
    if (token === "if") blocks.push({ kind: "if", body: false });
    else if (token === "then") {
      expect(current?.kind).toBe("if");
      current.body = true;
    } else if (token === "elif") {
      expect(current).toMatchObject({ kind: "if", body: true });
      current.body = false;
    } else if (token === "fi") {
      expect(blocks.pop()).toMatchObject({ kind: "if", body: true });
    } else if (token === "for" || token === "while") {
      blocks.push({ kind: "loop", body: false });
    } else if (token === "do") {
      expect(current?.kind).toBe("loop");
      current.body = true;
    } else if (token === "done") {
      expect(blocks.pop()).toMatchObject({ kind: "loop", body: true });
    } else if (token === "case") {
      blocks.push({ kind: "case", body: true });
    } else {
      expect(blocks.pop()?.kind).toBe("case");
    }
  }
  expect(blocks).toEqual([]);
}

function mutateSeamSnapshot(
  value: unknown,
  counts: { maps: number; buffers: number; objects: number },
  seen = new Set<object>(),
): void {
  if (Buffer.isBuffer(value)) {
    value.fill(0x78);
    counts.buffers += 1;
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    counts.maps += 1;
    for (const entry of value.values()) mutateSeamSnapshot(entry, counts, seen);
    value.set(
      "package/UNINVENTORIED-SEAM-MUTATION.txt",
      Buffer.from("seam mutation\n"),
    );
    return;
  }
  counts.objects += 1;
  if (Array.isArray(value)) {
    for (const entry of value) mutateSeamSnapshot(entry, counts, seen);
    Object.assign(value, { seamMutation: true });
    return;
  }
  for (const entry of Object.values(value)) {
    mutateSeamSnapshot(entry, counts, seen);
  }
  Object.assign(value, { seamMutation: true });
}

function gitSha1(bytes: Uint8Array) {
  return createHash("sha1").update(bytes).digest();
}

function gitObjectId(type: string, bytes: Uint8Array) {
  return gitSha1(
    Buffer.concat([
      Buffer.from(`${type} ${bytes.byteLength}\0`),
      Buffer.from(bytes),
    ]),
  ).toString("hex");
}

async function createSyntheticRepository(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".git", "objects", "info"), { recursive: true });
  return root;
}

async function writeLooseObject(
  repository: string,
  type: string,
  body: Buffer,
  storedObjectId = gitObjectId(type, body),
) {
  const canonical = Buffer.concat([
    Buffer.from(`${type} ${body.byteLength}\0`),
    body,
  ]);
  await writeLooseStorage(repository, storedObjectId, deflateSync(canonical));
  return storedObjectId;
}

async function writeLooseStorage(
  repository: string,
  storedObjectId: string,
  compressed: Buffer,
) {
  const path = join(
    repository,
    ".git",
    "objects",
    storedObjectId.slice(0, 2),
    storedObjectId.slice(2),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, compressed);
}

function encodePackHeader(type: number, inputSize: number) {
  let size = inputSize;
  const bytes = [(type << 4) | (size & 0x0f)];
  size = Math.floor(size / 16);
  while (size !== 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(size & 0x7f);
    size = Math.floor(size / 128);
  }
  return Buffer.from(bytes);
}

function encodeDeltaSize(input: number) {
  let value = input;
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function appendDelta(base: Buffer, suffix: Buffer) {
  if (base.byteLength > 0xff || suffix.byteLength > 0x7f) {
    throw new Error("Synthetic delta fixture exceeds its one-byte encoding.");
  }
  return Buffer.concat([
    encodeDeltaSize(base.byteLength),
    encodeDeltaSize(base.byteLength + suffix.byteLength),
    Buffer.from([0x90, base.byteLength, suffix.byteLength]),
    suffix,
  ]);
}

function encodeOffsetDistance(input: number) {
  let value = input;
  const bytes = [value & 0x7f];
  while ((value = Math.floor(value / 128)) !== 0) {
    value -= 1;
    bytes.push(0x80 | (value & 0x7f));
  }
  return Buffer.from(bytes.reverse());
}

type PackedFixtureEntry = {
  objectId: string;
  offset: number;
  packed: Buffer;
};

function createPackIndex(entries: PackedFixtureEntry[], packChecksum: Buffer) {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.objectId, "hex"),
      Buffer.from(right.objectId, "hex"),
    ),
  );
  const headerLength = 8 + 256 * 4;
  const namesLength = sorted.length * 20;
  const crcLength = sorted.length * 4;
  const offsetsLength = sorted.length * 4;
  const bytes = Buffer.alloc(
    headerLength + namesLength + crcLength + offsetsLength + 40,
  );
  Buffer.from([0xff, 0x74, 0x4f, 0x63]).copy(bytes, 0);
  bytes.writeUInt32BE(2, 4);
  for (let fanout = 0; fanout < 256; fanout += 1) {
    bytes.writeUInt32BE(
      sorted.filter(
        (entry) => Number.parseInt(entry.objectId.slice(0, 2), 16) <= fanout,
      ).length,
      8 + fanout * 4,
    );
  }
  const namesStart = headerLength;
  const crcStart = namesStart + namesLength;
  const offsetsStart = crcStart + crcLength;
  sorted.forEach((entry, index) => {
    Buffer.from(entry.objectId, "hex").copy(bytes, namesStart + index * 20);
    bytes.writeUInt32BE(crc32(entry.packed) >>> 0, crcStart + index * 4);
    bytes.writeUInt32BE(entry.offset, offsetsStart + index * 4);
  });
  const trailerStart = offsetsStart + offsetsLength;
  packChecksum.copy(bytes, trailerStart);
  gitSha1(bytes.subarray(0, trailerStart + 20)).copy(bytes, trailerStart + 20);
  return bytes;
}

function createIndexFixture({
  version = 2,
  path = "packages/schema/src/index.ts",
  pathBytes = Buffer.from(path),
  signature = Buffer.from("DIRC"),
  extensions = [],
  primaryFlags = 0,
  extendedFlags,
  declaredLength,
  corruptPadding = false,
}: {
  version?: number;
  path?: string;
  pathBytes?: Buffer;
  signature?: Buffer;
  extensions?: { signature: string | Buffer; bytes?: Buffer }[];
  primaryFlags?: number;
  extendedFlags?: number;
  declaredLength?: number;
  corruptPadding?: boolean;
} = {}) {
  const hasExtended = version === 3 && (primaryFlags & 0x4000) !== 0;
  const fixedLength = 62 + (hasExtended ? 2 : 0);
  const rawLength = fixedLength + pathBytes.byteLength + 1;
  const paddedLength = Math.ceil(rawLength / 8) * 8;
  const entry = Buffer.alloc(paddedLength);
  entry.writeUInt32BE(0o100644, 24);
  Buffer.alloc(20, 0x33).copy(entry, 40);
  entry.writeUInt16BE(
    primaryFlags | (declaredLength ?? Math.min(pathBytes.byteLength, 0x0fff)),
    60,
  );
  if (hasExtended) entry.writeUInt16BE(extendedFlags ?? 0, 62);
  pathBytes.copy(entry, fixedLength);
  if (corruptPadding) entry[fixedLength + pathBytes.byteLength + 1] = 1;
  const header = Buffer.alloc(12);
  signature.copy(header, 0);
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(1, 8);
  const extensionBytes = extensions.map((extension) => {
    const data = extension.bytes ?? Buffer.alloc(0);
    const header = Buffer.alloc(8);
    Buffer.from(extension.signature).copy(header, 0);
    header.writeUInt32BE(data.byteLength, 4);
    return Buffer.concat([header, data]);
  });
  const content = Buffer.concat([header, entry, ...extensionBytes]);
  return Buffer.concat([content, gitSha1(content)]);
}

async function writeRawLooseObject(repository: string, inflated: Buffer) {
  const objectId = gitSha1(inflated).toString("hex");
  await writeLooseStorage(repository, objectId, deflateSync(inflated));
  return objectId;
}

async function writePackedFixture(
  repository: string,
  packedObjects: { objectId: string; packed: Buffer }[],
  signature = Buffer.from("PACK"),
) {
  const packHeader = Buffer.alloc(12);
  signature.copy(packHeader, 0);
  packHeader.writeUInt32BE(2, 4);
  packHeader.writeUInt32BE(packedObjects.length, 8);
  let offset = packHeader.byteLength;
  const entries = packedObjects.map((object) => {
    const entry = { ...object, offset };
    offset += object.packed.byteLength;
    return entry;
  });
  const packContent = Buffer.concat([
    packHeader,
    ...entries.map(({ packed }) => packed),
  ]);
  const packChecksum = gitSha1(packContent);
  const packRoot = join(repository, ".git", "objects", "pack");
  await mkdir(packRoot, { recursive: true });
  const stem = `pack-${packChecksum.toString("hex")}`;
  await writeFile(
    join(packRoot, `${stem}.pack`),
    Buffer.concat([packContent, packChecksum]),
  );
  await writeFile(
    join(packRoot, `${stem}.idx`),
    createPackIndex(entries, packChecksum),
  );
}

async function writeSyntheticPack(
  repository: string,
  {
    corruptRefDelta = false,
    signature = Buffer.from("PACK"),
  }: { corruptRefDelta?: boolean; signature?: Buffer } = {},
) {
  const base = Buffer.from("base-value");
  const ofsSuffix = Buffer.from("-ofs");
  const ofs = Buffer.concat([base, ofsSuffix]);
  const refSuffix = Buffer.from("-ref");
  const ref = Buffer.concat([ofs, refSuffix]);
  const baseId = gitObjectId("blob", base);
  const ofsId = gitObjectId("blob", ofs);
  const refId = gitObjectId("blob", ref);
  const tree = Buffer.concat([
    Buffer.from("100644 payload.txt\0"),
    Buffer.from(refId, "hex"),
  ]);
  const treeId = gitObjectId("tree", tree);
  const commit = Buffer.from(
    `tree ${treeId}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nsynthetic pack\n`,
  );
  const commitId = gitObjectId("commit", commit);

  const packHeader = Buffer.alloc(12);
  signature.copy(packHeader, 0);
  packHeader.writeUInt32BE(2, 4);
  packHeader.writeUInt32BE(5, 8);
  const entries: PackedFixtureEntry[] = [];
  let offset = packHeader.byteLength;
  function add(object: Omit<PackedFixtureEntry, "offset">) {
    entries.push({ ...object, offset });
    offset += object.packed.byteLength;
  }
  add({
    objectId: baseId,
    packed: Buffer.concat([
      encodePackHeader(3, base.byteLength),
      deflateSync(base),
    ]),
  });
  const baseOffset = entries[0].offset;
  const ofsOffset = offset;
  const ofsDelta = appendDelta(base, ofsSuffix);
  add({
    objectId: ofsId,
    packed: Buffer.concat([
      encodePackHeader(6, ofsDelta.byteLength),
      encodeOffsetDistance(ofsOffset - baseOffset),
      deflateSync(ofsDelta),
    ]),
  });
  const refDelta = appendDelta(ofs, refSuffix);
  add({
    objectId: refId,
    packed: Buffer.concat([
      encodePackHeader(7, refDelta.byteLength),
      Buffer.from(ofsId, "hex"),
      corruptRefDelta ? Buffer.from([0]) : deflateSync(refDelta),
    ]),
  });
  add({
    objectId: treeId,
    packed: Buffer.concat([
      encodePackHeader(2, tree.byteLength),
      deflateSync(tree),
    ]),
  });
  add({
    objectId: commitId,
    packed: Buffer.concat([
      encodePackHeader(1, commit.byteLength),
      deflateSync(commit),
    ]),
  });

  const packContent = Buffer.concat([
    packHeader,
    ...entries.map(({ packed }) => packed),
  ]);
  const packChecksum = gitSha1(packContent);
  const pack = Buffer.concat([packContent, packChecksum]);
  const index = createPackIndex(entries, packChecksum);
  const packRoot = join(repository, ".git", "objects", "pack");
  await mkdir(packRoot, { recursive: true });
  const stem = `pack-${packChecksum.toString("hex")}`;
  await writeFile(join(packRoot, `${stem}.pack`), pack);
  await writeFile(join(packRoot, `${stem}.idx`), index);
  return {
    ids: {
      base: baseId,
      ofs: ofsId,
      ref: refId,
      tree: treeId,
      commit: commitId,
    },
    bodies: { base, ofs, ref, tree, commit },
  };
}
export {
  repositoryRoot,
  sourceCommit,
  picomatchError,
  expectBuffersIdentical,
  expectByteMapsIdentical,
  expectByteMapArraysIdentical,
  expectDeterministicTarResultsIdentical,
  expectReleaseOutputMapsIdentical,
  expectAuditResultsIdentical,
  installedPath,
  copyRecordedThirdPartyTree,
  assertInProcessLauncherSyntax,
  mutateSeamSnapshot,
  gitObjectId,
  createSyntheticRepository,
  writeLooseObject,
  writeLooseStorage,
  encodePackHeader,
  encodeDeltaSize,
  encodeOffsetDistance,
  createIndexFixture,
  writeRawLooseObject,
  writePackedFixture,
  writeSyntheticPack,
};
