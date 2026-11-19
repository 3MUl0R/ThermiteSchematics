import { dirname, join } from "node:path";
import ts from "typescript";
import { sameContributorPath } from "../../agent/contributor-bun.mjs";
import { sha256 } from "../../agent/snapshot.mjs";

// Absolute Bun commands can bypass the build observer. Re-emit the required
// artifacts in memory from the delivered source and compare their bytes.
export function matchesDirectBuild(repository, outputs) {
  if (
    !outputs.length ||
    outputs.some(({ sha256, input }) => !sha256 || !input.sha256)
  )
    return false;
  const bySource = Object.groupBy(outputs, ({ input }) => input.file);
  return Object.entries(bySource).every(([input, artifacts]) => {
    const source = join(repository, input);
    const project = dirname(dirname(source));
    const configPath = join(project, "tsconfig.json");
    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error) return false;
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, project);
    if (parsed.errors.length) return false;
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    });
    const file = program.getSourceFile(source);
    if (!file) return false;
    const emitted = new Map();
    const result = program.emit(file, (path, text, bom) => {
      const artifact = artifacts.find(({ file }) =>
        sameContributorPath(path, join(repository, file)),
      );
      if (artifact)
        emitted.set(artifact.file, sha256(bom ? "\ufeff" + text : text));
    });
    return (
      !result.emitSkipped &&
      artifacts.every(({ file, sha256 }) => emitted.get(file) === sha256)
    );
  });
}
