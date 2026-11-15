import { afterEach, expect, it, vi } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import * as runtime from "../src/layout/elk-runtime.js";
import * as layouts from "../src/layout/direct-loop-layout.js";
import * as loops from "../src/signal-loop.js";
import { InlineLabelFitError } from "../src/layout/inline-label-error.js";
import { normalizePaperPage } from "../src/packet/page.js";
import { topologyDrafts } from "../src/packet/topology.js";
import type { Draft, PaperPage } from "../src/packet/types.js";
import { fixture, removeFixtures } from "../../cli/test/analog-output.cases.js";

const names = ["W1XXXXXXX", "W2XXXXXX", "W3XXXXX", "W4XXX", "W5XXXXX", "W6"];
afterEach(async () => {
  vi.restoreAllMocks();
  await removeFixtures();
});

async function mixedLoop() {
  const f = await fixture();
  let index = 0;
  for (const object of f.source.objects)
    if (object.kind === "wire") object.designation = names[index++];
  const ir = await f.compile();
  const request = { ...f.packet.views[0], flow: "top-to-bottom" };
  const native = layouts.layoutDirectLoop;
  const forced = vi
    .spyOn(layouts, "layoutDirectLoop")
    .mockImplementation((children, edges, vertical, ids) =>
      native(children, edges, vertical, ids, () => {
        throw new InlineLabelFitError("synthetic native-only fit veto");
      }),
    );
  const fallback = await loops.prepareSignalLoopDrawing(ir, request);
  forced.mockRestore();
  return { ir, request, fallback };
}
function issuedScale(draft: Draft) {
  const match = draft.content.match(/\) scale\(([^)]+)\)/);
  if (!match) throw new Error("Missing issued diagram scale");
  return Number(match[1]);
}
function captureNativeGraphs() {
  const outputs: ElkNode[] = [];
  let chosen: ElkNode | undefined;
  const factory = runtime.createElkEngine,
    layout = layouts.layoutDirectLoop;
  vi.spyOn(runtime, "createElkEngine").mockImplementation(() => {
    const engine = factory(),
      native = engine.layout.bind(engine);
    engine.layout = async (input, options) => {
      const graph = await native(input, options);
      outputs.push(graph);
      return graph;
    };
    return engine;
  });
  vi.spyOn(layouts, "layoutDirectLoop").mockImplementation(async (...args) => {
    chosen = await layout(...args);
    return chosen;
  });
  return () => ({ outputs, chosen });
}

it.each([141, 132])(
  "retains the identical native fallback at usable width %s without scale loss or refusal",
  async (usableWidth) => {
    const { ir, request, fallback } = await mixedLoop();
    // A synthetic tall page isolates the width constraint in the real composer.
    // 141 lies between the 140 mm fallback and 144 mm stagger; 132 straddles
    // their readable-size thresholds. This adds no public paper size.
    const page: PaperPage = {
      size: "tabloid",
      orientation: "portrait",
      marginMm: 10,
      widthMm: usableWidth + 56,
      heightMm: 500,
    };
    const force = vi
      .spyOn(loops, "prepareSignalLoopDrawing")
      .mockResolvedValueOnce(fallback);
    const baseline = await topologyDrafts(ir, request, undefined, page);
    force.mockRestore();
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error(baseline.error.message);
    const captured = captureNativeGraphs();
    const after = await topologyDrafts(ir, request, undefined, page);
    expect(after.ok, JSON.stringify(after)).toBe(true);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value).toHaveLength(1);
    const beforeDraft = baseline.value[0],
      afterDraft = after.value[0];
    if (!beforeDraft || !afterDraft) throw new Error("Missing issued draft");
    expect(issuedScale(afterDraft)).toBe(issuedScale(beforeDraft));
    expect(after).toEqual(baseline);
    const { outputs, chosen } = captured();
    expect(outputs).toHaveLength(3);
    expect(chosen).toBe(outputs[1]);
  },
);

it("keeps the mixed-width repair when both drawings print at scale one on real tabloid paper", async () => {
  const { ir, request } = await mixedLoop();
  const page = normalizePaperPage({ size: "tabloid", orientation: "portrait" });
  if (!page.ok) throw new Error(page.error.message);
  const captured = captureNativeGraphs();
  const result = await topologyDrafts(ir, request, undefined, page.value);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const draft = result.value[0];
  if (!draft) throw new Error("Missing issued draft");
  expect(issuedScale(draft)).toBe(1);
  const { outputs, chosen } = captured();
  expect(outputs).toHaveLength(3);
  expect(chosen).toBe(outputs[2]);
});
