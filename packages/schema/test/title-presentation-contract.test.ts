import { expect, it } from "vitest";
import { createAjv2020 } from "../src/ajv-validation.js";
import {
  createInMemoryCanonicalSchemaRegistry,
  loadCanonicalSchemas,
} from "../src/schema-registry.js";
import { parseJson, type JsonValue } from "../src/parser.js";
import { describeSchemaPattern } from "../src/pattern-descriptions.js";

const slots = [
  "project",
  "sheetTitle",
  "drawingNumber",
  "customer",
  "drawnBy",
  "date",
  "checkedBy",
  "approvedBy",
  "revision",
  "sheetNumber",
] as const;
it("closes the fixed slot object and every field record in the public schema", async () => {
  const source = (await loadCanonicalSchemas()).find(
    (s) => s.fileName === "project-presentation.schema.json",
  );
  if (!source) throw Error("Missing presentation schema");
  const validate = createAjv2020().compile(source.schema);
  for (const slot of slots)
    expect(
      validate({
        format: "project-presentation/0.3",
        titleBlock: { fields: { [slot]: { slot, label: "X" } } },
      }),
    ).toBe(true);
  for (const fields of [
    { custom: { slot: "customer", label: "X" } },
    { customer: { slot: "customer", label: "X", geometry: { x: 1 } } },
    { customer: { slot: "unreleased", label: "X" } },
  ])
    expect(
      validate({ format: "project-presentation/0.3", titleBlock: { fields } }),
    ).toBe(false);
});
it("keeps missing/wrong format and malformed compact diagnostics located and specific", () => {
  const registry = createInMemoryCanonicalSchemaRegistry();
  for (const [source, pointer, code, line] of [
    ['{\n "revision":"A","backgroundColor":"#ffffff"\n}', "/format", "E010", 1],
    [
      '{\n "format":"project-presentation/0.4","revision":"A","backgroundColor":"#ffffff"\n}',
      "/format",
      "E014",
      2,
    ],
    [
      '{\n "format":"project-presentation/0.3",\n "titleBlock":{"fields":{"customer":{"slot":"customer","label":42}}}\n}',
      "/titleBlock/fields/customer/label",
      "E011",
      3,
    ],
    [
      '{\n "format":"project-presentation/0.3",\n "titleBlock":{"fields":{"custom":{"slot":"customer","label":"X"}}}\n}',
      "/titleBlock/fields/custom",
      "E012",
      3,
    ],
  ] as const) {
    const parsed = parseJson(source, "contract.json");
    if (parsed.value === undefined) throw Error("Bad diagnostic fixture");
    const diagnostics = registry.validateEntity(
      "project-presentation",
      parsed.value,
      { file: "contract.json", nodes: parsed.nodes },
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code,
        jsonPointer: pointer,
        file: "contract.json",
        line,
      }),
    );
    expect(diagnostics.every((d) => !d.message.includes("Ajv keyword"))).toBe(
      true,
    );
  }
});
it("rejects duplicate slot keys at their authored source position before schema validation", () => {
  const parsed = parseJson(
    '{\n "format":"project-presentation/0.3",\n "titleBlock":{"fields":{\n "customer":{"slot":"customer","label":"X"},\n "customer":{"slot":"customer","label":"Y"}\n }}\n}',
    "duplicate.json",
  );
  expect(parsed.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "E003",
      file: "duplicate.json",
      line: 5,
      jsonPointer: "/titleBlock/fields/customer",
    }),
  );
});
it("leaves the legacy branch diagnostics exact for malformed 0.1 and 0.2", () => {
  const registry = createInMemoryCanonicalSchemaRegistry();
  for (const format of [
    "project-presentation/0.1",
    "project-presentation/0.2",
  ]) {
    const value = {
      format,
      revision: "A",
      backgroundColor: "#ffffff",
      extra: true,
    } as JsonValue;
    expect(
      registry.validateEntity("project-presentation", value, {
        file: "legacy.json",
        nodes: new Map(),
      }),
    ).toEqual([
      {
        code: "E012",
        severity: "error",
        message: 'Unknown property "extra".',
        file: "legacy.json",
        line: 1,
        column: 1,
        jsonPointer: "/extra",
      },
    ]);
  }
});
it("describes the retained public packet metadata key pattern without exposing a regex", () => {
  expect(describeSchemaPattern("^[a-z][A-Za-z0-9_]{0,31}$")).toBe(
    "a lowercase ASCII letter followed by up to 31 ASCII letters, digits or underscores",
  );
});
