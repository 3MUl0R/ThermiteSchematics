import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import {
  uncutFixture,
  uncutLabelVariant,
} from "./continuation-uncut-fixtures.js";

// Owned by scripts/update-continuation-uncut-goldens.mjs (--check|--write).
// Keep the page counts, crossed/uncut distinction and wire coverage below.
const reference: Record<string, string[]> = JSON.parse(
  readFileSync(
    new URL("snapshots/continuation-uncut.json", import.meta.url),
    "utf8",
  ),
);

it.each(["init-starter", "motor-starter"] as const)(
  "keeps uncut empty, whitespace and newline labels printable with reviewed layout bytes (%s)",
  async (name) => {
    const input = await uncutFixture(name);
    const base = await renderSchematicPacket(
      input.ir,
      input.request,
      input.presentation,
    );
    if (!base.ok) throw Error(JSON.stringify(base.error));
    const crossed = new Set(
      base.value.sheets.flatMap((s) =>
        s.continuations.map((l) =>
          l.provenance && "uid" in l.provenance ? l.provenance.uid : undefined,
        ),
      ),
    );
    for (const [index, label] of ["", "   ", "A\nB"].entries()) {
      const { ir, changed } = uncutLabelVariant(input.ir, crossed, name, label);
      expect(changed.length).toBeGreaterThan(0);
      const result = await renderSchematicPacket(
        ir,
        input.request,
        input.presentation,
      );
      if (!result.ok) throw Error(JSON.stringify(result.error));
      expect(result.value.sheets).toHaveLength(name === "init-starter" ? 1 : 7);
      expect(
        createHash("sha256").update(JSON.stringify(result.value)).digest("hex"),
      ).toBe(reference[name][index]);
      for (const s of result.value.sheets)
        for (const l of s.continuations)
          expect(
            changed.some(
              (w) =>
                l.provenance &&
                "uid" in l.provenance &&
                w.uid === l.provenance.uid,
            ),
          ).toBe(false);
    }
  },
  30000,
);
