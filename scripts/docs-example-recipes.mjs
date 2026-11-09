// These are executable bindings, not labels for similar tests. Every recipe
// receives the current Markdown body and runs/consumes it in a temporary tree.
const run = (name) =>
  Object.assign(
    async (context, fence) => {
      const runner = await import("./docs-example-runner.mjs");
      return runner[name](context, fence);
    },
    {
      testFile: "packages/cli/test/docs-examples.test.ts",
      testName: (file, recipe) =>
        `executes Markdown fences in ${file} [${recipe}]`,
    },
  );
export const recipes = {
  "cabinets-shell": run("cabinetsShell"),
  "repo-shell": run("repoShell"),
  "agent-workflow": run("agentWorkflow"),
  "json-project": run("jsonProject"),
  "json-packet": run("jsonPacket"),
  "json-source": run("jsonSource"),
};
