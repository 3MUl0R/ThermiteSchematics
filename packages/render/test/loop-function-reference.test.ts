import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { selectSignalLoop } from "../src/signal-loop.js";
import { loopFunctionReference } from "../src/signal-loop/polarity.js";
import { renderSchematicPacket } from "../src/sheets.js";
import {
  directFixture,
  directPacket,
  directView,
  flows,
  roleFree,
} from "./direct-loop-fixture.js";

it.each(flows)(
  "never prints unlabeled selector keys in direct-loop notes in %s",
  async (flow) => {
    const hidden = ["unlabeled_transmitter_228", "unlabeled_channel_228"];
    const f = await directFixture((m) => {
      roleFree(m);
      for (const [i, old, key] of [
        [1, "signal", hidden[0]!],
        [2, "input", hidden[1]!],
      ] as const) {
        m.types[i].functions[key] = m.types[i].functions[old];
        delete m.types[i].functions[old];
      }
    });
    try {
      const view = directView({
        flow,
        from: { device: "TX1", function: hidden[0]! },
        to: { device: "AI1", function: hidden[1]! },
      });
      const result = await renderSchematicPacket(f.ir, directPacket(view));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      for (const sheet of result.value.sheets) {
        const { document } = parseHTML(sheet.svg);
        const text = [...document.querySelectorAll("text, desc")]
          .map((e) => e.textContent)
          .join(" ");
        for (const key of hidden) expect(text).not.toContain(key);
      }
      expect(result.value.sheets[0]!.svg).toContain(
        "polarity not verified: AI1 terminals p/n, TX1 terminals p/n.",
      );
    } finally {
      await f.dispose();
    }
  },
);

it("uses only bound terminals in authored order, falling back to the designation", async () => {
  const f = await directFixture(roleFree);
  try {
    const endpoint = selectSignalLoop(f.ir, directView()).to;
    const reference = (keys: string[]) =>
      loopFunctionReference({
        ...endpoint,
        function: {
          ...endpoint.function,
          terminals: keys.map((terminalKey) => ({
            deviceUid: endpoint.device.uid,
            terminalKey,
          })),
        },
      });
    expect(reference(["9", "13"])).toBe("AI1 terminals 9/13");
    expect(reference(["13", "9"])).toBe("AI1 terminals 13/9");
    expect(reference([])).toBe("AI1");
  } finally {
    await f.dispose();
  }
});
