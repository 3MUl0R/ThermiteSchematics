// Deliberately absent from the canonical/public schema registry.
import { bindings, slots } from "./model.js";
export const string = (maxLength: number, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
export const nullable = (maxLength: number) => ({
  type: ["string", "null"],
  minLength: 1,
  maxLength,
});
export const object = (properties: object, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const grid = object(
  {
    columns: { type: "integer", const: 6 },
    rows: { type: "integer", const: 4 },
  },
  ["columns", "rows"],
);
const orientations = object({ landscape: grid, portrait: grid });
export const pageSchema = object({
  size: { enum: ["letter", "tabloid", "a4", "a3"] },
  orientation: { enum: ["landscape", "portrait"] },
  marginMm: { type: "number", minimum: 5, maximum: 25 },
});
export const key = { pattern: "^[a-z][A-Za-z0-9_]{0,31}$" };
const fields = {
  type: "object",
  propertyNames: key,
  additionalProperties: object(
    {
      slot: { enum: slots },
      label: string(40),
      value: nullable(160),
      bind: { enum: Object.values(bindings) },
      pattern: string(160),
      // Only extras may vary missing policy; compact has no extra slots.
    },
    ["slot", "label"],
  ),
};
export const presentationSchema = object(
  {
    $schema: { type: "string" },
    format: { const: "project-presentation/0.3" },
    revision: string(128),
    backgroundColor: { type: "string", pattern: "^#[0-9a-f]{6}$" },
    page: pageSchema,
    frame: object({
      zones: object({
        default: grid,
        byPaper: object({
          letter: orientations,
          tabloid: orientations,
          a4: orientations,
          a3: orientations,
        }),
      }),
      header: object({ text: string(160) }, ["text"]),
      generatorStamp: { enum: ["title", "border", "metadata"] },
    }),
    titleBlock: object({
      profile: { const: "compact" },
      lines: { type: "array", maxItems: 4, items: string(160) },
      fields,
      // Extended-only logo/staticText/revisionTable are unknown capabilities (E012).
    }),
  },
  ["format"],
);
