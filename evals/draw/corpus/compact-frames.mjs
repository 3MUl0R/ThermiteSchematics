import assert from "node:assert/strict";
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
    ["machine-demo", "examples/machine-demo/packet.request.json", "M2"],
    ["conveyor-line", conveyor, "M1"],
  ].flatMap(([project, request, frameRoot]) =>
    paperVariants.flatMap((page) =>
      ["standard", "compact"].flatMap((layout) =>
        flows.map((flow) => ({
          id: `p03-${project}-${page.size}-${page.orientation}-${layout}-${flow}`,
          project: `examples/${project}`,
          request,
          recipe: "compact-frame",
          frameRequest: { layout, page },
          frameRoot,
          flow,
        })),
      ),
    ),
  );
}

export function applyCompactFrameRequest(spec, request) {
  const views = request.views.filter(
    (view) => view.family === "power" && view.root?.value === spec.frameRoot,
  );
  assert.equal(
    views.length,
    1,
    `Expected one authored power view for ${spec.id}`,
  );
  Object.assign(request, spec.frameRequest, { views, index: false });
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
