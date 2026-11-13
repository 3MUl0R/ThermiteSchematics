// Deliberately absent from the canonical/public schema registry.
import { bindings, slots } from "./model.js";
const string = (maxLength: number, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
});
const nullable = (maxLength: number) => ({
  type: ["string", "null"],
  minLength: 1,
  maxLength,
});
const object = (properties: object, required: string[] = []) => ({
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
const key = { pattern: "^[a-z][A-Za-z0-9_]{0,31}$" };
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
      missing: { const: "blank" },
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
      header: object({ text: { type: ["string", "null"] } }, ["text"]),
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
const row = object(
  {
    version: string(32),
    comment: string(160, 0),
    date: string(10),
    drawnBy: string(80),
  },
  ["version"],
);
const recordProperties = {
  values: {
    type: "object",
    propertyNames: key,
    additionalProperties: nullable(160),
  },
  sheetTitle: nullable(160),
  revision: nullable(128),
  revisionRows: { type: "array", maxItems: 6, items: row },
};
export const titleDataSchema = object({
  defaults: object({ ...recordProperties, drawingBase: nullable(128) }),
  byView: {
    type: "array",
    maxItems: 40,
    items: object(
      {
        ...recordProperties,
        viewIndex: { type: "integer", minimum: 1, maximum: 40 },
      },
      ["viewIndex"],
    ),
  },
  bySheet: {
    type: "array",
    maxItems: 100,
    items: object(
      {
        ...recordProperties,
        sheetKey: { type: "string", pattern: "^sheet/1/[0-9a-f]{64}$" },
      },
      ["sheetKey"],
    ),
  },
});
/** View selection is still owned by the existing strict per-view validators.
 * This schema validates the envelope/metadata; it does not replace dispatch. */
export const packetSchema = object(
  {
    format: { const: "schematic-packet-request/0.2" },
    page: pageSchema,
    views: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: { type: "object" },
    },
    layout: { enum: ["standard", "compact"] },
    index: { type: "boolean" },
    references: { type: ["object", "boolean"] },
    titleData: titleDataSchema,
  },
  ["format", "views"],
);
