import { expect, it } from "vitest";
import { selectSignalLoop } from "../src/signal-loop.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { seriesFixture, request, uid } from "./series-loop-fixture.js";

const cases = [
  {
    name: "supply selected as transmitter by designation",
    extra: { from: { device: "PS1", function: "output" } },
    message:
      "Series loop power source PS1 cannot also be the transmitter; use an explicit circuit view.",
  },
  {
    name: "supply selected as transmitter by UID",
    extra: { from: { device: uid(1), function: "output" } },
    message:
      "Series loop power source PS1 cannot also be the transmitter; use an explicit circuit view.",
  },
  {
    name: "genuine auxiliary pair",
    extra: { auxiliary: [{ from: request().from, to: request().to }] },
    message:
      "Series loop power is supported only for input views without auxiliary pairs.",
  },
];
for (const c of cases)
  it.each(["left-to-right", "top-to-bottom"] as const)(
    `explains ${c.name} in %s`,
    async (flow) => {
      const f = await seriesFixture();
      try {
        const view = request({ ...c.extra, flow });
        expect(() => selectSignalLoop(f.ir, view)).toThrow(c.message);
        const result = await renderSchematicPacket(f.ir, {
          format: "schematic-packet-request/0.1",
          views: [view],
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "R006",
            reason: "unprintable-layout",
            message: `Packet view[0] "Untitled view": ${c.message}`,
          },
        });
        expect(result).not.toHaveProperty("value");
      } finally {
        await f.dispose();
      }
    },
  );
