import { beforeAll, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { compileCoreProjectFixture, required } from "./fixtures.js";
import { renderSchematicPacket } from "../src/index.js";
import type { RenderedPacket } from "../src/sheets.js";
import {
  foldDecisionTrace,
  foldTrialTrace,
  type FoldDecision,
  type FoldTrialEvidence,
} from "../src/packet/fold-final-context.js";
import {
  circuitInlineTrace,
  circuitInlineContext,
  circuitLayoutContext,
} from "../src/layout/circuit-inline-context.js";
import { nextCircuitLayoutRun } from "../src/layout/circuit-inline.js";
import { cachedCircuitView } from "../src/layout/circuit-view-cache.js";
import { routeGrowth } from "../src/packet/rooted-clipped-routes.js";
import {
  foldCandidateAllowed,
  MAX_FOLD_EXTRA_REQUESTS,
} from "../src/packet/rooted-fold-search.js";
import { proposalRun } from "../src/packet/fold-final-quality.js";
import { chargePowerQualityInput } from "../src/layout/power-quality-budget.js";
import { JOG_NUMERICAL_TOLERANCE_MM } from "../src/packet/route-fragments.js";

// Read issued SVG coordinates and viewport clipping, independently of candidate
// scores, search references and the renderer's route-defect populations.
function printedJogLengths(svg: string, designation: string) {
  const doc = parseHTML(svg).document;
  return [
    ...doc.querySelectorAll(`path[data-designation="${designation}"]`),
  ].flatMap((path) => {
    const source = required(path.closest("svg[data-layout-config-version]"));
    const [x, y, w, h] = required(source.getAttribute("viewBox"))
      .split(" ")
      .map(Number);
    const scale = Number(source.getAttribute("width")) / required(w);
    let px = 0,
      py = 0;
    const points: { x: number; y: number }[] = [];
    for (const match of required(path.getAttribute("d")).matchAll(
      /([MLHV])\s+([\d.-]+)(?:\s+([\d.-]+))?/gu,
    )) {
      px = match[1] === "V" ? px : Number(match[2]);
      py =
        match[1] === "H" ? py : Number(match[1] === "V" ? match[2] : match[3]);
      points.push({ x: px, y: py });
    }
    const lengths = points.slice(1).map((b, i) => {
      const a = required(points[i]);
      const visible =
        Math.max(a.x, b.x) >= required(x) &&
        Math.min(a.x, b.x) <= required(x) + required(w) &&
        Math.max(a.y, b.y) >= required(y) &&
        Math.min(a.y, b.y) <= required(y) + required(h);
      return visible ? Math.hypot(a.x - b.x, a.y - b.y) * scale : 0;
    });
    return lengths
      .slice(1, -1)
      .filter((n) => n > 0.05 && n < 3 - JOG_NUMERICAL_TOLERANCE_MM);
  });
}

let fixture: Awaited<ReturnType<typeof compileCoreProjectFixture>>;
let packet: RenderedPacket;
const trials: FoldTrialEvidence[] = [],
  decisions: FoldDecision[] = [];
const contexts: NonNullable<Parameters<typeof circuitInlineTrace.run>[0]> = [];
beforeAll(async () => {
  fixture = await compileCoreProjectFixture();
  const c = fixture;
  const result = await foldTrialTrace.run(trials, () =>
    foldDecisionTrace.run(decisions, () =>
      circuitInlineTrace.run(contexts, () =>
        renderSchematicPacket(
          c.ir,
          {
            format: "schematic-packet-request/0.1",
            layout: "compact",
            page: { size: "a3", orientation: "portrait" },
            views: [
              {
                format: "schematic-view-request/0.1",
                family: "power",
                flow: "left-to-right",
                root: { by: "designation", value: "M1" },
              },
              {
                format: "schematic-view-request/0.1",
                family: "control",
                flow: "left-to-right",
                root: { by: "designation", value: "K1" },
              },
            ],
          },
          c.presentation,
        ),
      ),
    ),
  );
  if (!result.ok) throw Error(JSON.stringify(result.error));
  packet = result.value;
}, 30000);

it("keeps the final A3 base's L2 source run free of the rejected 1.5 mm fold jog", () => {
  expect(packet.sheets.length).toBe(2);
  expect(
    printedJogLengths(required(packet.sheets[0]).svg, "W-PWR-002"),
  ).toEqual([]);
});

it("rejects both jog-bearing proposals against the final reference and keeps the exact base", () => {
  expect(trials.length).toBe(2);
  expect(decisions).toMatchObject([
    { branchRequests: 2, qualityRequests: 2, accepted: false },
  ]);
  for (const trial of trials) {
    expect(routeGrowth(trial.candidate, trial.reference, false)).toEqual([
      1, 1.5, 0, 0,
    ]);
    expect(routeGrowth(trial.candidate, trial.reference, true)).toEqual([
      1, 1.5, 0, 0,
    ]);
    expect(trial.routesAllowed).toBe(false);
    expect(trial.packetAllowed).toBe(true);
    expect(
      foldCandidateAllowed(
        fixture.ir,
        trial.candidate,
        trial.reference,
        packet.page,
      ),
    ).toBe(false);
  }
  expect(packet).toBe(required(trials[0]).basePacket);
  const run = required(required(contexts[0]).runs[0]),
    state = required(run.power);
  expect(required(state.original.drafts[0]).rootedSections?.length).toBe(3);
  expect(run.qualityAttempts).toBe(3);
  expect(state.work.calls - required(decisions[0]).referenceRequests).toBe(
    MAX_FOLD_EXTRA_REQUESTS,
  );
  expect(state.work.calls).toBeLessThanOrEqual(state.work.limit);
});

it("keys cached views on the selected candidate even while the selection bit stays true", async () => {
  const context = circuitLayoutContext(),
    ir = {},
    source = required(required(contexts[0]).runs[0]);
  const first = proposalRun(source, required(trials[0]).reference);
  context.runs.push(first);
  context.selected.add(0);
  context.qualityPhase = true;
  const work = vi.fn(async () => {
    const run = required(nextCircuitLayoutRun());
    return {
      ok: true as const,
      value: required(required(run.power).selected).grid.xs,
    };
  });
  await circuitInlineContext.run(context, async () => {
    const a = await cachedCircuitView(ir, undefined, [], work);
    required(first.power).selected = required(trials[0]).raw;
    context.cursor = 0;
    const b = await cachedCircuitView(ir, undefined, [], work);
    expect(a).toEqual({
      ok: true,
      value: required(trials[0]).reference.grid.xs,
    });
    expect(b).toEqual({ ok: true, value: required(trials[0]).raw.grid.xs });
    expect(work).toHaveBeenCalledTimes(2);
    context.cursor = 0;
    expect(await cachedCircuitView(ir, undefined, [], work)).toEqual(b);
    expect(work).toHaveBeenCalledTimes(2);
  });
});

it("debits cloned proposals to the original quality budget without resetting its ceiling", () => {
  const source = required(required(contexts[0]).runs[0]);
  const owner = { ...source, qualityAttempts: 3 };
  const first = proposalRun(owner, required(trials[0]).raw);
  const second = proposalRun(owner, required(trials[1]).raw);
  const work = { ...required(owner.power).work };
  chargePowerQualityInput(first, work);
  expect(owner.qualityAttempts).toBe(4);
  expect(first.qualityAttempts).toBe(4);
  expect(() => chargePowerQualityInput(second, work)).toThrow(
    "shared quality budget",
  );
  expect(owner.qualityAttempts).toBe(4);
});
