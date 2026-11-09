import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { watchArguments } from "./docs-example-command.mjs";
import { put, shell } from "./docs-example-context.mjs";

export async function cabinetsShell(c, fence) {
  return shell(c, fence.body);
}
export async function repoShell(c, fence) {
  await c.copy("examples", join(c.work, "examples"));
  await c.copy(
    "scripts/demo-change.mjs",
    join(c.work, "scripts/demo-change.mjs"),
  );
  // The demo script resolves thermite.mjs from its own temporary checkout.
  await put(
    join(c.work, "thermite.mjs"),
    `import ${JSON.stringify(pathToFileURL(c.entry).href)};`,
  );
  await put(join(c.work, "package.json"), {
    scripts: { "demo:change": "bun scripts/demo-change.mjs" },
  });
  if (fence.body.includes(" watch ")) return watchShell(c, fence);
  return shell(c, fence.body);
}
async function watchShell(c, fence) {
  const lines = fence.body.split("\n");
  const args = watchArguments(lines.at(-1)); // Refuse unknown launchers before substitution/work.
  await shell(c, lines.slice(0, -1).join("\n"));
  let output = "";
  const result = await c.run([c.entry, ...args], c.work, process.env, {
    onOutput: (text, interrupt) => {
      output += text;
      if (output.includes("Polling declared") && output.includes("Wrote"))
        interrupt();
    },
  });
  assert.ok(result.code === 0 || result.interrupted, output);
  assert.match(output, /Polling declared/);
  const outputIndex = args.findIndex(
    (arg) => arg === "-o" || arg === "--output",
  );
  assert.ok(outputIndex >= 0, "Watch example must name an output");
  assert.ok((await readFile(join(c.work, args[outputIndex + 1]))).length > 0);
}
export async function agentWorkflow(c, fence) {
  const { agentWorkflow: run } = await import("./docs-example-agent.mjs");
  return run(c, fence);
}
export async function jsonProject(c, fence) {
  const project = join(c.work, "project");
  await c.cli(["init", project]);
  await put(join(project, "system.json"), JSON.parse(fence.body));
  await c.cli(["lock", project]);
  await c.cli(["validate", project]);
}
export async function jsonPacket(c, fence) {
  const { jsonPacket: run } = await import("./docs-example-json.mjs");
  return run(c, fence);
}
export async function jsonSource(c, fence) {
  const { jsonSource: run } = await import("./docs-example-json.mjs");
  return run(c, fence);
}
