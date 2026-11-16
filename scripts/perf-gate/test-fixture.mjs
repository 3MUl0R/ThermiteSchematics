import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const entry = fileURLToPath(
  new URL("../check-perf.mjs", import.meta.url),
);
export const git = (root, ...args) =>
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Perf Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
export function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
  );
}
export function fixture(timing = false) {
  const temporary = mkdtempSync(
    join(realpathSync(tmpdir()), "thermite-perf-test-"),
  );
  const head = join(temporary, "head");
  put(join(head, "package.json"), {
    name: "perf-test",
    type: "module",
    scripts: { build: "bun build.mjs" },
  });
  put(join(head, ".gitignore"), "**/dist/\nnode_modules/\nbun.lock\n");
  put(
    join(head, "build.mjs"),
    `
import { cpSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
if (process.env.PERF_BUILD_ORDER) appendFileSync(process.env.PERF_BUILD_ORDER, basename(process.cwd())+'\\n');
if (process.env.PERF_PAUSE_FILE && basename(process.cwd()) === 'base') {
  writeFileSync(process.env.PERF_PAUSE_FILE, JSON.stringify({base:process.cwd(),pid:process.pid}));
  await new Promise(() => setInterval(() => {}, 1000));
}
for (const name of ['compiler','render']) {
  const p = join('packages', name); mkdirSync(join(p,'dist'),{recursive:true});
  cpSync(join(p,'src/index.js'),join(p,'dist/index.js'));
}
`,
  );
  for (const name of ["compiler", "render"])
    put(join(head, "packages", name, "package.json"), {
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    });
  put(
    join(head, "packages/compiler/src/index.js"),
    timing
      ? "globalThis.perfClock=0;globalThis.perfStep=100;Object.defineProperty(performance,'now',{value:()=>globalThis.perfClock});export async function compileProject(){globalThis.perfClock+=globalThis.perfStep;return {ok:true,ir:{},presentation:{}}}\n"
      : "export async function compileProject(){return {ok:true,ir:{},presentation:{}}}\n",
  );
  put(
    join(head, "packages/render/src/index.js"),
    timing
      ? "export async function renderSchematicPacket(){globalThis.perfClock+=globalThis.perfStep;return {ok:true,value:{sheets:[]}}}\n"
      : "export async function renderSchematicPacket(){return {ok:true,value:{sheets:[]}}}\n",
  );
  put(join(head, "examples/machine-demo/packet.request.json"), {
    views: Array.from({ length: 12 }, () => ({})),
  });
  put(join(head, "examples/conveyor-line/system.json"), {});
  git(head, "init", "--quiet");
  git(head, "add", ".");
  git(head, "commit", "-qm", "base");
  const baseRevision = git(head, "rev-parse", "HEAD");
  git(head, "update-ref", "refs/remotes/origin/dev", baseRevision);
  put(join(head, "pr.txt"), "PR change\n");
  git(head, "add", ".");
  git(head, "commit", "-qm", "head");
  return {
    temporary,
    head,
    baseRevision,
    headRevision: git(head, "rev-parse", "HEAD"),
  };
}
export async function until(predicate, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for perf test child");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
