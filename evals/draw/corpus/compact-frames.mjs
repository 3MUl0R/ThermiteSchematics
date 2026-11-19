import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { json, readJson } from "../support.mjs";
import { conveyor } from "./requests.mjs";

const paperVariants = [
  { size: "tabloid", orientation: "landscape", marginMm: 10 },
  { size: "letter", orientation: "portrait", marginMm: 5 },
];

export function compactFrameCases(flows) {
  return [
    ["machine-demo", "examples/machine-demo/packet.request.json"],
    ["conveyor-line", conveyor],
  ].flatMap(([project, request]) =>
    paperVariants.flatMap((page) =>
      ["standard", "compact"].flatMap((layout) =>
        flows.map((flow) => ({
          id: `p03-${project}-${page.size}-${page.orientation}-${layout}-${flow}`,
          project: `examples/${project}`,
          request,
          recipe: "compact-frame",
          frameRequest: { layout, page },
          flow,
        })),
      ),
    ),
  );
}

/** Upgrade only the clone's presentation. Keep the authored title and page data. */
export async function useCompactPresentation(project) {
  const manifest = await readJson(join(project, "system.json"));
  const path = join(project, manifest.presentation);
  const presentation = await readJson(path);
  delete presentation.$schema;
  presentation.format = "project-presentation/0.3";
  await writeFile(path, json(presentation));
}
