import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { diagnosticInventory } from "./render-diagnostic-inventory.mjs";

it("all R001–R006 construction sites and context wrappers remain audited", () => {
  const expected = JSON.parse(
    readFileSync(
      new URL("./render-diagnostic-sites.json", import.meta.url),
      "utf8",
    ),
  );
  const actual = diagnosticInventory();
  expect(actual.sites.map(({ line, ...site }) => site)).toEqual(expected.sites);
  expect(actual.wrappers).toEqual(expected.wrappers);
  for (const path of new Set(
    [...actual.sites, ...actual.wrappers].map((site) => site.path),
  ))
    expect(
      expected.scopes[path]?.length,
      `missing native identity policy for ${path}`,
    ).toBeGreaterThan(0);
});
