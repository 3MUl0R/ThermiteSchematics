import { afterEach, expect, it, vi } from "vitest";
import type { ElectricalIr } from "@thermite/compiler";
import { repairRootedJogs } from "../src/packet/rooted-jog-repair.js";
import {
  MAX_PLACEMENT_LAYOUTS,
  type RootedSearch,
} from "../src/packet/rooted-search.js";
import { STANDARD_ECONOMY_ATTEMPTS } from "../src/packet/rooted-economy.js";
import * as prepared from "../src/off-view/prepared.js";
import * as build from "../src/packet/rooted-build.js";
import * as compose from "../src/packet/rooted-compose.js";
import * as fit from "../src/packet/composition-fit.js";
import * as score from "../src/packet/rooted-score.js";
import { sideCandidate, sidePage } from "./helpers/side-candidate.js";

const ir = {} as ElectricalIr;
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const original = sideCandidate(1);
  original.prepared = {
    ...original.prepared,
    view: { ...original.prepared.view, family: "power" },
  };
  original.jogs = new Map([["wire", 1]]);
  original.prepared.layout.edges[0]!.points = [
    { x: 100, y: 60 },
    { x: 150, y: 60 },
    { x: 150, y: 68 },
    { x: 170, y: 68 },
  ];
  const candidate = structuredClone(original);
  candidate.jogs = new Map();
  candidate.prepared.layout.edges[0]!.points = [
    { x: 100, y: 60 },
    { x: 170, y: 60 },
    { x: 170, y: 68 },
  ];
  const run = { attempts: 0 } as RootedSearch;
  const layout = vi
    .spyOn(prepared, "repositionDrawing")
    .mockResolvedValue({ ok: true, value: candidate.prepared });
  vi.spyOn(build, "buildRootedCandidates").mockReturnValue({
    ok: true,
    value: [candidate],
  });
  vi.spyOn(build, "materializeRootedCandidate").mockReturnValue({
    ok: true,
    value: candidate.drafts,
  });
  const check = vi.spyOn(fit, "compositionFits").mockReturnValue(true);
  vi.spyOn(compose, "composeRootedWinner").mockImplementation((_ir, c) => c);
  return { original, candidate, run, layout, check };
}
it("charges the retry to the existing budget and keeps the source drawing immutable", async () => {
  const { original, candidate, run, layout } = fixture(),
    before = structuredClone(original);
  expect(
    await repairRootedJogs(ir, original, original, sidePage, run, 42),
  ).toBe(candidate);
  expect(run.attempts).toBe(1);
  expect(layout).toHaveBeenCalledTimes(1);
  expect(build.buildRootedCandidates).toHaveBeenCalledWith(
    ir,
    candidate.prepared,
    sidePage,
    undefined,
    false,
    false,
    42,
  );
  expect(original).toEqual(before);
});
it.each(["placement", "economy"])(
  "does not extend the %s budget",
  async (budget) => {
    const { original, run, layout } = fixture();
    run.attempts =
      budget === "placement"
        ? MAX_PLACEMENT_LAYOUTS
        : STANDARD_ECONOMY_ATTEMPTS;
    if (budget === "economy") run.economyStartedAt = 0;
    expect(await repairRootedJogs(ir, original, original, sidePage, run)).toBe(
      original,
    );
    expect(layout).not.toHaveBeenCalled();
  },
);
it.each(["pages", "composed-pages", "sparse", "worse-jog", "fit", "gang"])(
  "retains the original on a %s regression",
  async (failure) => {
    const { original, candidate, run, layout, check } = fixture();
    if (failure === "pages")
      candidate.drafts.push(structuredClone(candidate.drafts[0]!));
    if (failure === "worse-jog")
      candidate.prepared.layout.edges[0]!.points = [
        { x: 100, y: 60 },
        { x: 150, y: 60 },
        { x: 150, y: 64 },
        { x: 170, y: 64 },
      ];
    if (failure === "composed-pages")
      vi.mocked(compose.composeRootedWinner).mockImplementation((_ir, c) =>
        c.prepared === candidate.prepared
          ? { ...c, drafts: [...c.drafts, ...c.drafts] }
          : c,
      );
    if (failure === "fit") check.mockReturnValue(false);
    if (failure === "sparse") {
      run.standardEconomy = false;
      vi.spyOn(score, "candidateUtilisation").mockReturnValue(0.399999);
    }
    if (failure === "gang")
      layout.mockResolvedValue({
        ok: false,
        error: {
          code: "R006",
          root: "fixture",
          reason: "unprintable-layout",
          message: "Mechanical gang cannot paint all links",
        },
      });
    expect(await repairRootedJogs(ir, original, original, sidePage, run)).toBe(
      original,
    );
    expect(run.attempts).toBe(1);
  },
);
