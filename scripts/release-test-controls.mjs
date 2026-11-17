import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  buildFreshRelease,
  releaseInputsFromCommit,
} from "./release-build.mjs";
import { readGitObject } from "./release-common.mjs";
import { collectThirdPartySource } from "./release-third-party-inventory.mjs";

export async function assertUntrackedReleaseSources(
  repositoryRoot,
  sourceCommit,
) {
  for (const extension of ["ts", "d.ts"]) {
    const logical = `packages/schema/src/release-package-untracked.${extension}`;
    const source = join(repositoryRoot, logical);
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "thermite-release-untracked-"),
    );
    const buildRoot = join(temporaryRoot, "build");
    let created = false;
    try {
      await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        source,
        "export {};\ndeclare global { const releasePackageProbe: unique symbol; }\n",
        { flag: "wx" },
      );
      created = true;
      await expect(
        buildFreshRelease({ repositoryRoot, buildRoot, sourceCommit }),
      ).rejects.toThrow(
        `REL021 Release source is untracked or ignored: ${logical}.`,
      );
      await expect(lstat(buildRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (created) await rm(source, { force: false });
      if (created)
        await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(temporaryRoot, { recursive: true, force: false });
    }
  }
}

export async function assertCommittedMarkdownRejected(
  repositoryRoot,
  sourceCommit,
) {
  let injected = 0;
  await expect(
    releaseInputsFromCommit({
      repositoryRoot,
      sourceCommit,
      objectReader: async (root, objectId) => {
        const object = await readGitObject(root, objectId);
        if (
          object.type !== "tree" ||
          !object.bytes.includes(Buffer.from("100644 ajv-validation.ts\0"))
        )
          return object;
        injected += 1;
        return {
          type: "tree",
          bytes: Buffer.concat([
            object.bytes,
            Buffer.from("100644 zz-release-probe.md\0"),
            Buffer.alloc(20, 1),
          ]),
        };
      },
    }),
  ).rejects.toThrow(
    "REL023 Tracked release source is not a .ts file: packages/schema/src/zz-release-probe.md.",
  );
  expect(injected).toBe(1);
}

export async function assertUndeclaredRuntimeRejected(repositoryRoot) {
  const logical = "packages/agent-tools/package.json";
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, logical), "utf8"),
  );
  manifest.dependencies = {
    ...manifest.dependencies,
    "release-undeclared-probe": "1.0.0",
  };
  await expect(
    collectThirdPartySource({
      repositoryRoot,
      workspaceManifestBytes: new Map([
        [logical, Buffer.from(JSON.stringify(manifest))],
      ]),
    }),
  ).rejects.toThrow(
    "PKG001 Unexpected runtime dependency 'release-undeclared-probe'.",
  );
}
