import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "@thermite/render";
import { repositoryRoot, type FactModule } from "./harness.js";
const module: FactModule = {
  facts: [
    {
      claim:
        "Packets may append required companion inventories; requested filters stay unchanged.",
      async check() {
        const project = join(repositoryRoot, "examples/report-filtering");
        const compiled = await compileProject(project);
        if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
        const request = JSON.parse(
          await readFile(join(project, "packet.json"), "utf8"),
        );
        const original = JSON.stringify(request);
        const result = await renderSchematicPacket(
          compiled.ir,
          request,
          compiled.presentation,
        );
        if (!result.ok) throw Error(JSON.stringify(result.error));
        expect(result.value.navigation!.autoDocuments!.length).toBeGreaterThan(
          0,
        );
        const authored = result.value.documentationSelections!;
        for (const selection of authored)
          expect(selection.filter).toEqual(
            request.views[selection.view - 1].filter,
          );
        expect(JSON.stringify(request)).toBe(original);
        expect(
          result.value.navigation!.autoDocuments!.every((d) => !("view" in d)),
        ).toBe(true);
      },
    },
  ],
  unexecuted: new Map([
    [
      "Include appended sheets when reviewing page counts.",
      "Manual packet review advice; appended pages are exported in navigation.autoDocuments.",
    ],
  ]),
};
export default module;
