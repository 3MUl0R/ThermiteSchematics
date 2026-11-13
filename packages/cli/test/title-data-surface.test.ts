import { expect, it } from "vitest";
import { auditTitleDataSurface } from "./title-data-surface.js";
const hidden = "packages/render/src/internal/title-data/parse.ts";
const hiddenSchema = "packages/schema/src/internal/title-data/schema.ts";
const fixture = (
  file: string,
  source: string,
  extra: [string, string][] = [],
) =>
  new Map([
    [hidden, "export const parse = 1;"],
    [hiddenSchema, "export const shape = 1;"],
    [file, source],
    ...extra,
  ]);
it.each([
  ['import {parse} from "./internal/title-data/parse.js";'],
  ['export * from "./internal/title-data/parse.js";'],
  ['await import("./internal/title-data/parse.js");'],
  ['require("./internal/title-data/parse.js");'],
  ['if(process.env.TB) await import("./internal/title-data/parse.js");'],
  ['const path="./internal/"+"title-data/parse.js"; await import(path);'],
  ["const path=process.env.TB_PATH; require(path);"],
])("refuses static/dynamic/require/env references: %s", (source) =>
  expect(
    auditTitleDataSurface(fixture("packages/render/src/index.ts", source)),
  ).not.toEqual([]),
);
it("follows public and internal barrels", () => {
  expect(
    auditTitleDataSurface(
      fixture(
        "packages/render/src/index.ts",
        'export * from "./internal/index.js";',
        [
          [
            "packages/render/src/internal/index.ts",
            'export * from "./title-data/parse.js";',
          ],
        ],
      ),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "packages/render/src/index.ts: public module or barrel",
      ),
    ]),
  );
});
it.each([
  "packages/cli/src/internal/entry.ts",
  "packages/render/src/internal/entry.ts",
  "packages/schema/src/internal/entry.ts",
  "packages/query/src/internal/title-data/entry.ts",
])("narrows the exemption, including %s", (file) => {
  expect(
    auditTitleDataSurface(
      fixture(file, 'import "@thermite/render/internal/title-data/parse.js";'),
    ),
  ).not.toEqual([]);
});
it("catches env gates in the hidden directory and its dependencies", () => {
  expect(
    auditTitleDataSurface(
      new Map([
        [hidden, 'import "../../env.js";'],
        ["packages/render/src/env.ts", "export const enabled=process.env.TB;"],
      ]),
    ),
  ).not.toEqual([]);
  expect(
    auditTitleDataSurface(
      new Map([[hidden, 'export const enabled=process["env"].TB;']]),
    ),
  ).not.toEqual([]);
});
it("normalizes Windows paths and permits ordinary dynamic imports and unrelated env reads", () => {
  const files = fixture(
    "packages\\render\\src\\index.ts",
    'await import("./renderer.js"); const level=process.env.LOG_LEVEL;',
    [["packages/render/src/renderer.ts", "export const ready = true;"]],
  );
  expect(auditTitleDataSurface(files)).toEqual([]);
  expect(
    auditTitleDataSurface(
      new Map([
        [
          hidden,
          `import "../../../../schema/dist/internal/title-data/schema.js";`,
        ],
        [hiddenSchema, "export const shape = 1;"],
      ]),
    ),
  ).toEqual([]);
});

it("rejects shadowed and reassigned dynamic paths behind env gates", () => {
  for (const source of [
    'let path="./renderer.js"; if(process.env.TB) path="./internal/title-data/parse.js"; import(path);',
    'const path="./renderer.js"; function load(path:string){return import(path)}; load(process.env.TB_PATH);',
    'if(process.env.TB) require("./internal/"+"title-data/parse.js");',
  ])
    expect(
      auditTitleDataSurface(fixture("packages/render/src/index.ts", source)),
    ).not.toEqual([]);
});
it("keeps structural schema dependencies below render", () => {
  expect(
    auditTitleDataSurface(
      new Map([
        [hiddenSchema, 'import "../../../../render/dist/text-metrics.js";'],
        ["packages/render/src/text-metrics.ts", "export const glyph = true;"],
      ]),
    ),
  ).not.toEqual([]);
});
