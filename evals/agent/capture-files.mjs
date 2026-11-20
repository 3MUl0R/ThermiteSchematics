import assert from "node:assert/strict";
import { CString, dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const { O_DIRECTORY, O_NOFOLLOW = 0, O_NONBLOCK = 0, O_RDONLY } = constants;
const { ENOENT } = osConstants.errno;
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

let libc;
const darwin = process.platform === "darwin";
// Intel macOS names the 64-bit-inode directory calls with a suffix.
const inode64 = darwin && process.arch === "x64" ? "$INODE64" : "";
function lib() {
  // This read-only openat call does not take its optional creation mode.
  libc ??= dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
    openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    ["fdopendir" + inode64]: { args: [FFIType.i32], returns: FFIType.ptr },
    ["readdir" + inode64]: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
    [errnoLocation]: { args: [], returns: FFIType.ptr },
  }).symbols;
  return libc;
}
const errnoLocation = darwin ? "__error" : "__errno_location";
let errnoView;
// An openat result and, on failure, its errno.
function tryOpen(dir, name, flags) {
  const symbols = lib();
  errnoView ??= new Int32Array(toArrayBuffer(symbols[errnoLocation](), 0, 4));
  errnoView[0] = 0;
  const fd = symbols.openat(dir, Buffer.from(name + "\0"), flags);
  return { fd, errno: fd < 0 ? errnoView[0] : 0 };
}
function openRelative(dir, name, flags) {
  const { fd } = tryOpen(dir, name, flags);
  assert(fd >= 0, inputError);
  return fd;
}
// Names in an open directory. The directory takes ownership of fd. The name
// follows d_ino, d_seekoff, d_reclen, d_namlen and d_type on macOS, and
// d_ino, d_off, d_reclen and d_type on Linux. readdir returns null both at
// the end and on an error; only an error sets errno, which is cleared first.
function listDescriptor(fd) {
  const symbols = lib(),
    dir = symbols["fdopendir" + inode64](fd);
  if (!dir) {
    closeSync(fd);
    assert.fail("Project directory could not be listed");
  }
  errnoView ??= new Int32Array(toArrayBuffer(symbols[errnoLocation](), 0, 4));
  const errno = errnoView;
  const names = [];
  try {
    for (;;) {
      errno[0] = 0;
      const entry = symbols["readdir" + inode64](dir);
      if (!entry) {
        assert(errno[0] === 0, "Project directory listing failed");
        break;
      }
      const name = new CString(entry, darwin ? 21 : 19).toString();
      if (name !== "." && name !== "..") names.push(name);
    }
  } finally {
    symbols.closedir(dir);
  }
  return names;
}
// Project-relative components, never empty, "." or "..".
function components(rel) {
  const parts = rel.split(sep);
  assert(
    parts.every(
      (part) => part && part !== "." && part !== ".." && !part.includes("\0"),
    ),
    inputError,
  );
  return parts;
}

// Cleanup tracks every descriptor before closing another, so a close that
// throws never strands a child or the opened file.
function openDescendant(rootFd, parts, finalFlags = 0) {
  let dir = rootFd,
    fd;
  try {
    for (const part of parts.slice(0, -1)) {
      const parent = dir;
      dir = openRelative(parent, part, readFlags | O_DIRECTORY);
      if (parent !== rootFd) closeSync(parent);
    }
    fd = openRelative(dir, parts.at(-1), readFlags | finalFlags);
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

// `expected` is a root identity recorded earlier; a different root is refused.
export function projectReader(project, expected) {
  assert(
    process.platform === "darwin" || process.platform === "linux",
    windowsError,
  );
  const root = realpathSync(project);
  const identity = directoryIdentity(root);
  assert(
    !expected ||
      (root === expected.path &&
        String(identity.dev) === expected.dev &&
        String(identity.ino) === expected.ino),
    "Project root was replaced",
  );
  const rootFd = openSync(root, readFlags | O_DIRECTORY);
  try {
    assert(sameFile(fdStat(rootFd), identity), "Project changed");
    return {
      identity: {
        path: root,
        dev: String(identity.dev),
        ino: String(identity.ino),
      },
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
      // The entry's status, or undefined when absent, including below a
      // component that is a file. Any other inspection error throws.
      has(rel) {
        components(rel);
        directoryIdentity(root, identity);
        try {
          return stat(join(root, rel));
        } catch (error) {
          if (error.code === "ENOTDIR") return undefined;
          throw error;
        }
      },
      // Whether the root is still the pinned directory at its path.
      intact() {
        try {
          directoryIdentity(root, identity);
          return true;
        } catch {
          return false;
        }
      },
      // Whether no file is at rel, walking from the root without following
      // links: a component is missing, the entry is a directory, or an
      // intermediate component is a regular file. False leaves the decision
      // to read(), which refuses links and anything else unordinary.
      absentFile(rel) {
        const parts = components(rel);
        directoryIdentity(root, identity);
        let dir = rootFd;
        try {
          for (const [index, part] of parts.entries()) {
            const opened = tryOpen(dir, part, readFlags | O_DIRECTORY);
            if (opened.fd >= 0) {
              if (dir !== rootFd) closeSync(dir);
              dir = opened.fd;
              continue;
            }
            if (opened.errno === ENOENT) return true;
            if (index === parts.length - 1) return false;
            const file = tryOpen(dir, part, readFlags);
            if (file.fd < 0) return false;
            try {
              return fdStat(file.fd).isFile();
            } finally {
              closeSync(file.fd);
            }
          }
          return true;
        } finally {
          if (dir !== rootFd) closeSync(dir);
        }
      },
      read(rel) {
        const parts = components(rel);
        directoryIdentity(root, identity);
        const path = join(root, rel);
        const expected = stat(path);
        assert(
          ordinaryFile(expected) && realpathSync(path) === path,
          inputError,
        );
        const fd = openDescendant(rootFd, parts);
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
      // Names in a project directory reached without following links, read
      // from its descriptor; read() confines each entry.
      list(rel) {
        return listDescriptor(
          openDescendant(rootFd, components(rel), O_DIRECTORY),
        );
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
