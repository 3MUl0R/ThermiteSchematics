import assert from "node:assert/strict";
import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const {
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_NOFOLLOW = 0,
  O_NONBLOCK = 0,
  O_RDONLY,
  O_WRONLY,
} = constants;
const stat = (path) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
const fdStat = (fd) => fstatSync(fd, { bigint: true });
const sameFile = (a, b) => a?.dev === b.dev && a?.ino === b.ino;
const ordinaryFile = (s) => s?.isFile() && s.nlink === 1n;
const inputError = "Capture input must be an ordinary file inside project";
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

function openDescendant(rootFd, parts) {
  let dir = rootFd;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openRelative(dir, part, readFlags | O_DIRECTORY);
      if (dir !== rootFd) closeSync(dir);
      dir = next;
    }
    return openRelative(dir, parts.at(-1), readFlags);
  } finally {
    if (dir !== rootFd) closeSync(dir);
  }
}

export function projectReader(project) {
  const root = realpathSync(project);
  const identity = directoryIdentity(root);
  const useOpenat =
    process.platform === "darwin" || process.platform === "linux";
  const rootFd = useOpenat
    ? openSync(root, readFlags | O_DIRECTORY)
    : undefined;
  try {
    if (useOpenat)
      assert(sameFile(fdStat(rootFd), identity), "Project changed");
    return {
      path(name) {
        const rel = relative(root, resolve(root, name));
        assert(
          rel &&
            rel !== ".." &&
            !rel.startsWith(".." + sep) &&
            !isAbsolute(rel) &&
            !rel.includes("\0") &&
            (sep !== "\\" || !rel.includes(":")),
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
        const fd = useOpenat
          ? openDescendant(rootFd, rel.split(sep))
          : openSync(path, readFlags);
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
        if (useOpenat) closeSync(rootFd);
      },
    };
  } catch (error) {
    if (useOpenat) closeSync(rootFd);
    throw error;
  }
}

// Reserve fresh inodes before the agent starts. Later writes and truncation
// use these descriptors exclusively, even if an agent renames an entry.
export function reserveCaptureFiles(directory, names) {
  if (!stat(directory)) mkdirSync(directory);
  const parent = directoryIdentity(directory);
  const slots = new Map();
  const close = () => {
    for (const { fd } of slots.values()) closeSync(fd);
  };
  const verify = ({ path, fd, identity }) => {
    directoryIdentity(directory, parent);
    const current = fdStat(fd);
    assert(
      ordinaryFile(current) &&
        sameFile(current, identity) &&
        sameFile(stat(path), identity),
      "Capture output changed",
    );
  };
  try {
    for (const name of names)
      assert(!stat(join(directory, name)), "Capture output already exists");
    for (const name of names) {
      const path = join(directory, name);
      directoryIdentity(directory, parent);
      const fd = openSync(
        path,
        O_CREAT | O_EXCL | O_NOFOLLOW | O_WRONLY,
        0o600,
      );
      const slot = { path, fd };
      slots.set(name, slot);
      slot.identity = fdStat(fd);
      verify(slot);
    }
    return {
      write(name, bytes) {
        const slot = slots.get(name);
        verify(slot);
        ftruncateSync(slot.fd, 0);
        for (let offset = 0; offset < bytes.length;) {
          const count = writeSync(
            slot.fd,
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          assert(count > 0, "Capture output write made no progress");
          offset += count;
        }
        verify(slot);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
