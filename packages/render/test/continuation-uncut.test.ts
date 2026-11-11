import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import { uncutFixture } from "./continuation-uncut-fixtures.js";

// Full packet digests reviewed for D2 composition and page-first locality.
// Init remains byte-identical to #154 round 3; motor retains seven sheets,
// the same cut/uncut wire sets and coverage, with intended layout/cut shifts.
// Lane B round 2 restores authored gang ink and clears its captions.
const reference = {
  "init-starter": [
    "dde9b5313201efd7985baece36ce68a3dd46bec886110d9ec5749b810d2cf448",
    "34ce54cc75ca21e23ea031b3ca9dcb6bd73acbc617bcb6c03f8d3895fee8b954",
    "dab607cb276ece38eda33cb30ab181dc45dd77d23e475db378b0e306deefc255",
  ],
  "motor-starter": [
    "ffa2eeddfe71cd9ee6b83bbc22105b6f94a2b213c589e835657c32b3d951dd99",
    "21f43edf12c43ba4a181748e513ba216e9a9614a3d5255c5c504025922d72fb6",
    "8fdda145e311dea03dd90151a91b639aafabf834ba93dc41ea2e6970734abbe3",
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
