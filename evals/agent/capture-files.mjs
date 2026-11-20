import assert from "node:assert/strict";
import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const { O_DIRECTORY, O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY } = constants;
const stat = (path) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const fdStat = (fd) => fstatSync(fd, { bigint: true });
const sameFile = (a, b) => a?.dev === b.dev && a?.ino === b.ino;
const ordinaryFile = (s) => s?.isFile() && s.nlink === 1n;
const inputError = "Capture input must be an ordinary file inside project";
// Node has no descriptor-relative open on Windows, and pathname checks around
// an open cannot stop a concurrent junction swap. Refuse instead.
export const windowsError =
  "Visual capture is unavailable on Windows: project files cannot be opened there without following links";
const readFlags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

function directoryIdentity(path, expected) {
  const current = stat(path);
  assert(
    current?.isDirectory() && realpathSync(path) === path,
    "Capture directory must be ordinary",
  );
  assert(!expected || sameFile(current, expected), "Capture directory changed");
  return current;
}

let openat;
function openRelative(dir, name, flags) {
  // This read-only call does not take openat's optional creation mode.
  openat ??= dlopen(
    process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
    {
      openat: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    },
  ).symbols.openat;
  const fd = openat(dir, Buffer.from(name + "\0"), flags);
  assert(fd >= 0, inputError);
  return fd;
}

// Cleanup tracks every descriptor before closing another, so a close that
// throws never strands a child or the opened file.
function openDescendant(rootFd, parts) {
  let dir = rootFd,
    fd;
  try {
    for (const part of parts.slice(0, -1)) {
      const parent = dir;
      dir = openRelative(parent, part, readFlags | O_DIRECTORY);
      if (parent !== rootFd) closeSync(parent);
    }
    fd = openRelative(dir, parts.at(-1), readFlags);
  } finally {
    try {
      if (dir !== rootFd) closeSync(dir);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      throw error;
    }
  }
  return fd;
}

export function projectReader(project) {
  assert(
    process.platform === "darwin" || process.platform === "linux",
    windowsError,
  );
  const root = realpathSync(project);
  const identity = directoryIdentity(root);
  const rootFd = openSync(root, readFlags | O_DIRECTORY);
  try {
    assert(sameFile(fdStat(rootFd), identity), "Project changed");
    return {
      path(name) {
        const rel = relative(root, resolve(root, name));
        assert(
          rel &&
            rel !== ".." &&
            !rel.startsWith(".." + sep) &&
            !isAbsolute(rel) &&
            !rel.includes("\0"),
          inputError,
        );
        return rel;
      },
      has(rel) {
        directoryIdentity(root, identity);
        return !!stat(join(root, rel));
      },
      read(rel) {
        directoryIdentity(root, identity);
        const path = join(root, rel);
        const expected = stat(path);
        assert(
          ordinaryFile(expected) && realpathSync(path) === path,
          inputError,
        );
        const fd = openDescendant(rootFd, rel.split(sep));
        try {
          const opened = fdStat(fd);
          const verifyPath = () => {
            directoryIdentity(root, identity);
            assert(
              ordinaryFile(opened) &&
                sameFile(opened, expected) &&
                sameFile(stat(path), opened) &&
                realpathSync(path) === path,
              inputError,
            );
          };
          verifyPath();
          const bytes = readFileSync(fd);
          verifyPath();
          const after = fdStat(fd);
          assert(
            after.nlink === 1n &&
              after.size === opened.size &&
              after.mtimeNs === opened.mtimeNs &&
              after.ctimeNs === opened.ctimeNs,
            "Capture input changed during snapshot; request again",
          );
          return bytes;
        } finally {
          closeSync(fd);
        }
      },
      close() {
        closeSync(rootFd);
      },
    };
  } catch (error) {
    closeSync(rootFd);
    throw error;
  }
}
