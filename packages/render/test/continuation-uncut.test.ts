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
    "ab0781267c8e2b663e9bca95a23cba50714f45ba1dab2b422aa51f70784949aa",
    "67c0d0408dae8109eaefcea0f5f728badeae23d5d944fa627f0d4cc2ed66c4dd",
    "747842dad27e5f0f3d723bbcdbc74cfb07e9c5096215ea1d575a80df6297ba8a",
  ],
  "motor-starter": [
    "852a1bce264897d1b032cb926ffb4c8b004ae670b969fb3b9f8a536e2df44f9a",
    "ef939d73fa737f3ba3f2eb155c781c05c1f218aa9ed34e4a22bb74e9f58bc7cb",
    "d6cb7415bc66a775fddb54b02ec8f8b2af5e3e2328d9162648708c39bebd91f1",
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
