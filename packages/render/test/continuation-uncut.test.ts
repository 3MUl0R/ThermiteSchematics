import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import { uncutFixture } from "./continuation-uncut-fixtures.js";

// Full packet digests reviewed for D2 composition and page-first locality.
// Init remains byte-identical to #154 round 3; motor retains seven sheets,
// the same cut/uncut wire sets and coverage, with intended layout/cut shifts.
const reference = {
  "init-starter": [
    "dde9b5313201efd7985baece36ce68a3dd46bec886110d9ec5749b810d2cf448",
    "34ce54cc75ca21e23ea031b3ca9dcb6bd73acbc617bcb6c03f8d3895fee8b954",
    "dab607cb276ece38eda33cb30ab181dc45dd77d23e475db378b0e306deefc255",
  ],
  "motor-starter": [
    "1a45d9ae49ca32b99f1afea9a7f4f6fa8e496888cfef36e45fa884a80ec957b1",
    "dad30c15a4125549ba98f97eb7c541a01223d81ebc4d729b2836db169d746e93",
    "6d5f3e4f06ebca8b6759f6006db3f7e55ba133994239eba04f7d4a99eb725c57",
  ],
};

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
