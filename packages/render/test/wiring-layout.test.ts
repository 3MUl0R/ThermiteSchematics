import { afterEach, expect, it, vi } from "vitest";
import type { ELK } from "elkjs/lib/elk-api.js";
import { layoutWiring } from "../src/layout/wiring-layout.js";
import * as runtime from "../src/layout/elk-runtime.js";

afterEach(() => vi.restoreAllMocks());
it.each([true, false])(
  "keeps fixed-port self-loop compatibility (%s) in one ELK attempt",
  async (selfLoop) => {
    const layout = vi.fn().mockResolvedValue({ id: "wiring" });
    vi.spyOn(runtime, "createElkEngine").mockReturnValue({
      layout,
    } as unknown as ELK);
    const nodes = [
      { id: "a", ports: [{ id: "a1" }, { id: "a2" }] },
      { id: "b", ports: [{ id: "b1" }] },
    ];
    const edges = [
      { id: "e", sources: ["a1"], targets: [selfLoop ? "a2" : "b1"] },
    ];
    await layoutWiring(nodes, edges);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(
      layout.mock.calls[0]![0].layoutOptions[
        "elk.layered.nodePlacement.strategy"
      ],
    ).toBe(selfLoop ? "BRANDES_KOEPF" : "NETWORK_SIMPLEX");
    expect(layout.mock.calls[0]![0].children).toBe(nodes);
    expect(layout.mock.calls[0]![0].edges).toBe(edges);
  },
);
