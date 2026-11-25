import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import {
  prepareSignalLoopDrawing,
  selectSignalLoop,
} from "../src/signal-loop.js";
import { SERIES_LOOP_LTR_FALLBACK_NOTICE } from "../src/signal-loop/series-layout.js";
import { measureText } from "../src/text-metrics.js";
import {
  coreSupply,
  request,
  seriesFixture,
  type SeriesModel,
  uid,
  wire,
  withFeedThroughs,
} from "./series-loop-fixture.js";

function addSupplyBranches(
  model: SeriesModel,
  posCount: number,
  negCount: number,
  posKey = "+",
  negKey = "-",
) {
  let serial = 500;
  for (let i = 0; i < Math.max(posCount, negCount); i++) {
    const loadName = `LD${i + 1}`;
    model.objects.push({
      kind: "device",
      uid: uid(80 + i),
      designation: loadName,
      type: "series:load",
    });
    if (i < posCount)
      model.objects.push(wire(serial++, "PS1", posKey, loadName, "p"));
    if (i < negCount)
      model.objects.push(wire(serial++, "PS1", negKey, loadName, "n"));
  }
}

function fiveStageWithSupplyBranches(model: SeriesModel) {
  model.objects = model.objects.filter(
    (o) => ![uid(11), uid(12)].includes(o.uid),
  );
  model.objects.push(
    { kind: "device", uid: uid(41), designation: "TB2", type: "series:strip" },
    wire(101, "AI1", "n", "TB1", "1"),
    wire(102, "TB1", "1", "TB2", "1"),
    wire(103, "TB2", "1", "TX1", "p"),
    wire(104, "TX1", "n", "TB2", "2"),
    wire(105, "TB2", "2", "TB1", "2"),
    wire(106, "TB1", "2", "PS1", "-"),
  );
  addSupplyBranches(model, 5, 3);
}

function bodyPortGeometry(doc: Document, deviceUid: string) {
  const group = doc.querySelector(`[data-device-uid="${deviceUid}"]`)!;
  const width = Number(group.getAttribute("data-body-width"));
  const circles = [
    ...group.querySelectorAll("circle[data-terminal-marker='true']"),
  ].map((c) => ({
    cx: Number(c.getAttribute("cx")),
    cy: Number(c.getAttribute("cy")),
  }));
  const captions = [
    ...group.querySelectorAll("text[data-terminal-caption-body]"),
  ].map((t) => ({
    key: t.getAttribute("data-terminal-key")!,
    outside: t.getAttribute("data-outside-connections"),
    body: t.getAttribute("data-terminal-caption-body")!,
    text: t.textContent?.trim() ?? "",
    x: Number(t.getAttribute("x")),
    y: Number(t.getAttribute("y")),
  }));
  return { group, width, circles, captions };
}

it("#626: prints key [+N] once per supply terminal body in LTR while preserving pass-through ports", async () => {
  const f = await seriesFixture(async (m) => {
    withFeedThroughs(m);
    await coreSupply(m, "0.2.0");
    addSupplyBranches(m, 5, 3);
  });
  try {
    const loopPower = { device: "PS1", function: "dc_output" };
    const ltr = await renderSchematicPacket(f.ir, {
      format: "schematic-packet-request/0.1",
      index: false,
      views: [request({ flow: "left-to-right", loopPower })],
    });
    expect(ltr.ok, JSON.stringify(ltr)).toBe(true);
    if (!ltr.ok) return;
    const ltrDoc = parseHTML(ltr.value.sheets[0]!.svg).document;
    const ps1Ltr = bodyPortGeometry(ltrDoc, uid(1));
    expect(
      ps1Ltr.captions.map((c) => [c.key, c.text, c.outside]).sort(),
    ).toEqual([
      ["+", "+ [+5]", "5"],
      ["-", "- [+3]", "3"],
    ]);
    // Pass-through TB1 keeps both routing ports and prints one bare label per terminal.
    const tb1Ltr = bodyPortGeometry(ltrDoc, uid(4));
    expect(tb1Ltr.circles).toHaveLength(4);
    expect(
      tb1Ltr.captions.map((c) => [c.key, c.text, c.outside]).sort(),
    ).toEqual([
      ["1", "1", null],
      ["2", "2", null],
    ]);
    expect(ltr.value.sheets[0]!.svg).not.toContain("[+0]");
  } finally {
    await f.dispose();
  }
});

it("#626: prints key [+N] in true TTB and grows pitch/width only for bodies whose full captions need it", async () => {
  const f = await seriesFixture(async (m) => {
    withFeedThroughs(m);
    await coreSupply(m, "0.2.0");
    addSupplyBranches(m, 5, 3);
  });
  try {
    const loopPower = { device: "PS1", function: "dc_output" };
    const ttb = await renderSchematicPacket(f.ir, {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "portrait" },
      views: [request({ flow: "top-to-bottom", loopPower })],
    });
    expect(ttb.ok, JSON.stringify(ttb)).toBe(true);
    if (!ttb.ok) return;
    const ttbSvg = ttb.value.sheets[0]!.svg;
    expect(ttbSvg).not.toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);
    const ttbDoc = parseHTML(ttbSvg).document;
    const ps1Ttb = bodyPortGeometry(ttbDoc, uid(1));
    const tx1Ttb = bodyPortGeometry(ttbDoc, uid(2));
    const tb1Ttb = bodyPortGeometry(ttbDoc, uid(4));
    expect(
      ps1Ttb.captions.map((c) => [c.key, c.text, c.outside]).sort(),
    ).toEqual([
      ["+", "+ [+5]", "5"],
      ["-", "- [+3]", "3"],
    ]);
    // Only PS1 grows pitch (> 12 mm) and body width (> 82 mm); TX1 and TB1 stay at default 12 mm / 82 mm.
    const ps1Xs = [...new Set(ps1Ttb.circles.map((c) => c.cx))].sort(
      (a, b) => a - b,
    );
    const tx1Xs = [...new Set(tx1Ttb.circles.map((c) => c.cx))].sort(
      (a, b) => a - b,
    );
    expect(ps1Xs[1]! - ps1Xs[0]!).toBeGreaterThan(12);
    expect(ps1Ttb.width).toBeGreaterThan(82);
    expect(tx1Xs[1]! - tx1Xs[0]!).toBe(12);
    expect(tx1Ttb.width).toBe(82);
    expect(tb1Ttb.width).toBe(82);
    expect(tb1Ttb.circles).toHaveLength(4);
    expect(tb1Ttb.captions).toHaveLength(2);
    for (const c of ps1Ttb.captions) {
      const right = c.x + measureText(c.text, 2.7).width;
      expect(right).toBeLessThan(ps1Ttb.width - 1);
    }
    const sortedCaps = [...ps1Ttb.captions].sort((a, b) => a.x - b.x);
    expect(
      sortedCaps[0]!.x + measureText(sortedCaps[0]!.text, 2.7).width,
    ).toBeLessThan(ps1Xs[1]! - 1);
  } finally {
    await f.dispose();
  }
});

it("#626: height-bound TTB landscape fallback prints key [+N] on supply terminals", async () => {
  const f = await seriesFixture(async (m) => {
    await coreSupply(m, "0.2.0");
    fiveStageWithSupplyBranches(m);
  }, true);
  try {
    const res = await renderSchematicPacket(f.ir, {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "landscape" },
      views: [
        request({
          flow: "top-to-bottom",
          loopPower: { device: "PS1", function: "dc_output" },
        }),
      ],
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const svg = res.value.sheets[0]!.svg;
    expect(svg).toContain(SERIES_LOOP_LTR_FALLBACK_NOTICE);
    const ps1 = bodyPortGeometry(parseHTML(svg).document, uid(1));
    expect(ps1.captions.map((c) => [c.key, c.text, c.outside]).sort()).toEqual([
      ["+", "+ [+5]", "5"],
      ["-", "- [+3]", "3"],
    ]);
  } finally {
    await f.dispose();
  }
});

it("#626: grows LTR body width only when full supply caption exceeds w/2 - 5 and keeps ports on body edge", async () => {
  const f = await seriesFixture((m) => {
    m.types[0].terminals = {
      "24V+": { role: "dc_positive_output", connection_policy: "shared" },
      "0V-": { role: "dc_return_output", connection_policy: "shared" },
    };
    m.types[0].functions.output.terminals = ["24V+", "0V-"];
    for (const o of m.objects)
      for (const end of o.endpoints ?? [])
        if (end.device === "PS1")
          end.terminal = end.terminal === "p" ? "24V+" : "0V-";
    addSupplyBranches(m, 5, 3, "24V+", "0V-");
  });
  try {
    const d = await prepareSignalLoopDrawing(
      f.ir,
      request({ flow: "left-to-right" }),
    );
    const doc = parseHTML(`<svg>${d.content}</svg>`).document;
    const ps1 = bodyPortGeometry(doc, uid(1));
    const tx1 = bodyPortGeometry(doc, uid(2));
    expect(ps1.width).toBeGreaterThan(36);
    expect(tx1.width).toBe(36);
    expect(ps1.captions.map((c) => [c.key, c.text, c.outside]).sort()).toEqual([
      ["0V-", "0V- [+3]", "3"],
      ["24V+", "24V+ [+5]", "5"],
    ]);
    for (const c of ps1.circles)
      expect(c.cx === 0 || c.cx === ps1.width).toBe(true);
  } finally {
    await f.dispose();
  }
});

it("#626 control: zero outside connections prints no [+0], and non-supply extra branches remain rejected", async () => {
  const clean = await seriesFixture(undefined, false);
  try {
    for (const flow of ["left-to-right", "top-to-bottom"] as const) {
      const d = await prepareSignalLoopDrawing(clean.ir, request({ flow }));
      expect(d.content).not.toContain("[+0]");
      expect(d.content).not.toContain("data-outside-connections=");
    }
  } finally {
    await clean.dispose();
  }

  const branched = await seriesFixture((m) => {
    withFeedThroughs(m);
    m.objects.push(wire(600, "TB1", "1", "PLC1", "p"));
  });
  try {
    expect(() => selectSignalLoop(branched.ir, request())).toThrow(
      "Series loop has an additional connection at TB1.1; use a circuit view that includes the branch.",
    );
  } finally {
    await branched.dispose();
  }
});
