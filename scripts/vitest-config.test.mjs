import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { BaseSequencer, createVitest } from "vitest/node";

async function resolveProjects(workers) {
  vi.stubEnv("THERMITE_CI_MAX_WORKERS", workers);
  const runner = await createVitest("test", { watch: false });
  try {
    return runner.projects.map(({ name, config }) => ({
      name,
      include: config.include,
      exclude: config.exclude,
      maxWorkers: config.maxWorkers,
      testTimeout: config.testTimeout,
      hookTimeout: config.hookTimeout,
    }));
  } finally {
    await runner.close();
  }
}

it("preserves Vitest defaults and caps workers in both CI projects", async () => {
  vi.stubEnv("CI", "1");
  vi.stubEnv("VITEST_MAX_WORKERS", undefined);
  try {
    const standalone = await resolveProjects("2");
    expect(standalone).toHaveLength(1);
    const [root] = standalone;
    const projects = await resolveProjects("3");
    expect(projects.map(({ name }) => name)).toEqual(["limited", "main"]);
    const [limited, main] = projects;

    expect(root.hookTimeout).toBe(120_000);
    expect(root.testTimeout).toBe(120_000);
    expect(root.maxWorkers).toBe(2);
    expect(limited.maxWorkers).toBe(2);
    expect(main.maxWorkers).toBe(process.platform === "darwin" ? 2 : 3);
    expect(root.exclude).toEqual(
      expect.arrayContaining(["alpha-out/**", "release-out/**"]),
    );
    for (const project of projects) {
      expect(project.hookTimeout, project.name).toBe(root.hookTimeout);
      expect(project.testTimeout, project.name).toBe(root.testTimeout);
    }
    expect(limited.exclude).toEqual(root.exclude);
    expect(main.exclude).toEqual([...root.exclude, ...limited.include]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps default local sequencers and scopes CiSequencer to CI", async () => {
  vi.stubEnv("CI", "");
  try {
    const localDefault = await createVitest("test", { watch: false });
    try {
      expect(localDefault.config.sequence.sequencer).toBe(BaseSequencer);
    } finally {
      await localDefault.close();
    }
    const localShuffle = await createVitest("test", {
      watch: false,
      sequence: { shuffle: { files: true } },
    });
    try {
      expect(localShuffle.config.sequence.sequencer.name).toBe(
        "RandomSequencer",
      );
    } finally {
      await localShuffle.close();
    }
    vi.stubEnv("CI", "1");
    const ciRunner = await createVitest("test", { watch: false });
    try {
      expect(ciRunner.config.sequence.sequencer.name).toBe("CiSequencer");
    } finally {
      await ciRunner.close();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("loads vitest.config.mjs standalone without scripts/test-shards.mjs in CI", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "thermite-vitest-standalone-"));
  vi.stubEnv("CI", "1");
  try {
    cpSync("vitest.config.mjs", join(scratch, "vitest.config.mjs"));
    const deps = join(scratch, "node_modules");
    mkdirSync(deps);
    for (const entry of readdirSync(resolve("node_modules"))) {
      if (entry.startsWith(".")) continue;
      symlinkSync(
        resolve("node_modules", entry),
        join(deps, entry),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    writeFileSync(join(scratch, "a.test.mjs"), "export {};\n");
    writeFileSync(join(scratch, "b.test.mjs"), "export {};\n");
    const runner = await createVitest("test", {
      root: scratch,
      config: join(scratch, "vitest.config.mjs"),
      watch: false,
      shard: "1/2",
    });
    try {
      const specs = await runner.globTestSpecifications([]);
      expect(specs).toHaveLength(2);
      const Sequencer = runner.config.sequence.sequencer;
      const sequencer = new Sequencer(runner);
      const sharded = await sequencer.shard(Array.from(specs));
      const sorted = await sequencer.sort(sharded);
      expect(sorted).toHaveLength(1);
    } finally {
      await runner.close();
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("passes timeouts and archive exclusions to Vitest for config-less runs", async () => {
  const spawnSync = vi.fn().mockReturnValue({ status: 0 });
  const argv = process.argv;
  const exitCode = process.exitCode;
  vi.doMock("node:child_process", () => ({ spawnSync }));
  vi.stubEnv("THERMITE_CONTRIBUTOR_BUN", undefined);
  try {
    process.argv = [process.execPath, "scripts/test.mjs"];
    await import("./test.mjs");
    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "--testTimeout=120000",
        "--hookTimeout=120000",
        "--exclude=alpha-out/**",
        "--exclude=release-out/**",
      ]),
    );
  } finally {
    vi.doUnmock("node:child_process");
    vi.unstubAllEnvs();
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
