import { expect, it } from "vitest";
import {
  cachedCircuitLayout,
  circuitInlineContext,
  type CircuitInlineContext,
} from "../src/layout/circuit-inline-context.js";
import { elkWorkLedger, elkWorkScope } from "../src/layout/elk-work.js";
import { InlineLabelFitError } from "../src/layout/inline-label-error.js";

function context(): CircuitInlineContext {
  return {
    cursor: 0,
    runs: [],
    selected: new Set(),
    layouts: new Map(),
    qualityPhase: false,
    permittedInputs: new Set(),
    viewDecisions: [],
  };
}

it("counts actual dispatches, permits hits at 48, and refuses the 49th dispatch", async () => {
  const work = elkWorkLedger("synthetic", 48),
    state = context();
  let dispatches = 0;
  const layout = async (input: { id: string }) => ({
    ...input,
    call: ++dispatches,
  });
  await circuitInlineContext.run(state, () =>
    elkWorkScope.run(work, async () => {
      for (let i = 0; i < 48; i++)
        await cachedCircuitLayout({ id: String(i) }, layout);
      expect(dispatches).toBe(48);
      expect(work.calls).toBe(48);
      expect(await cachedCircuitLayout({ id: "0" }, layout)).toEqual({
        id: "0",
        call: 1,
      });
      expect(work.calls).toBe(48);
      expect(work.cacheHits).toBe(1);
      await expect(
        cachedCircuitLayout({ id: "49" }, layout),
      ).rejects.toBeInstanceOf(InlineLabelFitError);
      expect(dispatches).toBe(48);
      expect(work.calls).toBe(48);
    }),
  );
});

it("counts failed work and uncached dispatches without depending on a packet context", async () => {
  const work = elkWorkLedger("synthetic failure", 48),
    error = new TypeError("native failure");
  await elkWorkScope.run(work, async () => {
    await expect(
      cachedCircuitLayout({}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(work.calls).toBe(1);
    expect(work.cacheHits).toBe(0);
  });
});
