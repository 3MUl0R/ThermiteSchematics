import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import { uncutFixture } from "./continuation-uncut-fixtures.js";

// Full packet byte digests captured from the independently built round-3
// renderer, including all SVG, HTML, metadata and reciprocal continuations.
const reference = {
  "init-starter": [
    "dde9b5313201efd7985baece36ce68a3dd46bec886110d9ec5749b810d2cf448",
    "34ce54cc75ca21e23ea031b3ca9dcb6bd73acbc617bcb6c03f8d3895fee8b954",
    "dab607cb276ece38eda33cb30ab181dc45dd77d23e475db378b0e306deefc255",
  ],
  "motor-starter": [
    "3a960f9925cea5373eeb16371ee8e5b18756bf54ff87ed3d871b2c84ae58838a",
    "a6f4dc7edcbaefdb57f8630ca4806c40ec223d4cac92d24a91cd11cdb5482036",
    "5f2d523e1a94e9af0b3be5595443de5a8183c1b912e04da0df9498a02b7ff282",
  ],
};

it.each(["init-starter", "motor-starter"] as const)(
  "keeps uncut empty, whitespace and newline labels byte-identical to round 3 (%s)",
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
      const ir = structuredClone(input.ir);
      const changed = ir.wires.filter(
        (w) =>
          !crossed.has(w.uid) &&
          (label !== "" ||
            name === "init-starter" ||
            w.designation === "W-PWR-001"),
      );
      expect(changed.length).toBeGreaterThan(0);
      for (const w of changed) w.properties = { ...w.properties, label };
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
