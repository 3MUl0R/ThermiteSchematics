import { readFile } from "node:fs/promises";
import { compileProject } from "@thermite/compiler";
import { expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import type { SchematicPacketRequest } from "../src/packet/types.js";
import { authoredTerminalIncidence } from "../src/off-view/incidence.js";
import { cardRowKey } from "../src/off-view/card-destinations.js";
import { verifyPrintedPeerDestinations } from "../src/packet/terminal-peer-references.js";
import { escapeXmlAttribute as attr } from "../src/svg/escape.js";
import { parseSvg } from "./off-view-fixtures.js";
import { createTerminalIr } from "../../query/test/fixtures.js";

import { conveyorRequest } from "./packet-navigation-review-fixture.js";
import { repeatRequest } from "./wire-column-search-fixture.js";

it.each([
  {
    project: "conveyor-line",
    request: conveyorRequest(),
    pages: 20,
    token: "→ CB2.5/L3 04.D3",
  },
  {
    project: "machine-demo",
    request: repeatRequest("left-to-right"),
    pages: 37,
    token: "→ CB1.3/L2 02.B4",
  },
])(
  "retains the issued Letter portrait $project packet with peer notes",
  async ({ project, request, pages, token }) => {
    const c = await compileProject(`examples/${project}`);
    if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
    const r = await renderSchematicPacket(
      c.ir,
      {
        ...request,
        layout: "standard",
        page: { size: "letter", orientation: "portrait" },
      },
      c.presentation,
    );
    if (!r.ok) throw Error(JSON.stringify(r.error));
    expect(r.value.sheets).toHaveLength(pages);
    const texts = r.value.sheets.flatMap((sheet) => {
      const doc = parseSvg(sheet.svg);
      return [
        ...Array.from(
          doc.querySelectorAll("[data-peer-reference]"),
          (t) => t.textContent?.replace(/\s+/gu, " ").trim() ?? "",
        ),
        ...Array.from(
          doc.querySelectorAll("g.off-view-annotation"),
          (g) => g.textContent?.replace(/\s+/gu, " ").trim() ?? "",
        ),
      ];
    });
    expect(texts.some((text) => text.includes(token))).toBe(true);
    // Card-backed endpoints carry their destination inside the card, never as a duplicate free note.
    expect(
      r.value.sheets.every((sheet) => {
        const doc = parseSvg(sheet.svg);
        const cardSources = new Set(
          [...doc.querySelectorAll("g.off-view-annotation")].flatMap((g) => {
            const term = g.getAttribute("data-off-view-terminal-id");
            const raw: unknown = JSON.parse(
              g.getAttribute("data-off-view-conductors") ?? "[]",
            );
            const conds = Array.isArray(raw) ? raw : [];
            return term
              ? conds.map((c) => JSON.stringify([JSON.parse(term), c]))
              : [];
          }),
        );
        return [
          ...doc.querySelectorAll('[data-peer-reference="conductor-peer"]'),
        ].every((n) => {
          const [from, cond] = JSON.parse(
            n.getAttribute("data-peer-source") ?? "[]",
          );
          return !cardSources.has(JSON.stringify([from, cond]));
        });
      }),
    ).toBe(true);
  },
);

async function example(name: string, file = "packet.json") {
  const root = `examples/${name}`;
  const source = await compileProject(root);
  if (!source.ok) throw Error(JSON.stringify(source.diagnostics));
  const request: SchematicPacketRequest = JSON.parse(
    await readFile(`${root}/${file}`, "utf8"),
  );
  return async (change = (value: SchematicPacketRequest) => value) => {
    const output = await renderSchematicPacket(
      source.ir,
      change(request),
      source.presentation,
    );
    if (!output.ok) throw Error(JSON.stringify(output.error));
    return output.value.sheets.map((sheet) => ({
      ...sheet,
      document: parseSvg(sheet.svg),
    }));
  };
}

it("points to the actual selected attachment and its reciprocal port (#397)", async () => {
  const render = await example("topology-coverage");
  const sheets = await render();
  const refs = (sheet: number) =>
    [
      ...sheets[sheet - 1]!.document.querySelectorAll(
        '[data-peer-reference="attachment"]',
      ),
    ].map((el) => el.textContent?.trim());
  expect(refs(1)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^R1\.X2 · CAP-X2 → 02\.[A-D][1-6]$/u),
      expect.stringMatching(/^R1\.X4 · W2 → 03\.[A-D][1-6]$/u),
    ]),
  );
  expect(refs(2)).toContainEqual(
    expect.stringMatching(/^R1\.X2 · CAP-X2 → 01\./u),
  );
  expect(refs(4)).toContainEqual(expect.stringMatching(/^Y1\.IN · W2 → 03\./u));
  expect(refs(3)).toContainEqual(expect.stringMatching(/^Y1\.IN · W2 → 04\./u));
});

it.each(["left-to-right", "top-to-bottom"] as const)(
  "prints reciprocal conductor endpoints in the rooted packet (%s, #397)",
  async (flow) => {
    const source = await compileProject("examples/motor-starter");
    if (!source.ok) throw Error(JSON.stringify(source.diagnostics));
    const request: SchematicPacketRequest = JSON.parse(
      await readFile("examples/alpha/motor-starter.packet.json", "utf8"),
    );
    const result = await renderSchematicPacket(
      source.ir,
      { ...request, views: request.views.map((v) => ({ ...v, flow })) },
      source.presentation,
    );
    if (!result.ok) throw Error(JSON.stringify(result.error));
    const cards = result.value.sheets.flatMap((sheet) =>
      [...parseSvg(sheet.svg).querySelectorAll("g.off-view-annotation")].map(
        (g) => g.textContent?.replace(/\s+/gu, " ").trim() ?? "",
      ),
    );
    expect(cards).toContainEqual(
      expect.stringMatching(/W-CTL-004 → TB1\.4 \d+\.[A-D][1-6]/u),
    );
    expect(cards).toContainEqual(
      expect.stringMatching(
        /W-CTL-004 → PS1\.- \d+\.[A-D][1-6] \(also shown \d+\.[A-D][1-6]\)/u,
      ),
    );
    const freeWctl004 = result.value.sheets.flatMap((sheet) =>
      [
        ...parseSvg(sheet.svg).querySelectorAll(
          '[data-peer-reference="conductor-peer"]',
        ),
      ].filter((n) => n.textContent?.includes("W-CTL-004")),
    );
    expect(freeWctl004).toEqual([]);
  },
);

it.each(["left-to-right", "top-to-bottom"] as const)(
  "links a cable card with the painted circuit boundary terminal in %s (#397)",
  async (flow) => {
    const render = await example(
      "motor-starter",
      "../alpha/motor-starter-documentation.packet.json",
    );
    const sheets = await render((request) => ({
      ...request,
      views: request.views.map((view) =>
        view.format === "schematic-view-request/0.1" ||
        view.format === "circuit-view-request/0.1"
          ? { ...view, flow }
          : view,
      ),
    }));
    const circuit = sheets.find((sheet) => sheet.view.kind === "circuit");
    const cable = sheets.find(
      (sheet) => "intent" in sheet.view && sheet.view.intent === "conductors",
    );
    expect(circuit).toBeDefined();
    expect(cable).toBeDefined();
    const notes = (sheet: typeof circuit) =>
      [
        ...sheet!.document.querySelectorAll(
          '[data-peer-reference="conductor-peer"]',
        ),
      ].map((entry) => entry.textContent);
    expect(notes(circuit)).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^W-CTL-004 · PS1\\.- → TB1\\.4 ${String(cable!.number).padStart(2, "0")}\\.[A-D][1-6]$`,
          "u",
        ),
      ),
    );
    const cableCards = [
      ...cable!.document.querySelectorAll("g.off-view-annotation"),
    ].map((g) => g.textContent?.replace(/\s+/gu, " ").trim() ?? "");
    expect(cableCards).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `W-CTL-004 → PS1\\.- ${String(circuit!.number).padStart(2, "0")}\\.[A-D][1-6]`,
          "u",
        ),
      ),
    );
    expect(notes(cable)).toEqual([]);
  },
);

it("uses counterpart relay terminals in wiring views (#397)", async () => {
  const render = await example("operator-console", "packet.request.json");
  const sheets = await render();
  const notes = (n: number) =>
    [
      ...sheets[n - 1]!.document.querySelectorAll(
        '[data-peer-reference="terminal-interface"]',
      ),
    ].map((el) => el.textContent);
  expect(notes(5)).toContainEqual(
    expect.stringMatching(
      /^K-R · coil terminal A1 → contact terminal 14 07\./u,
    ),
  );
  expect(notes(7)).toContainEqual(
    expect.stringMatching(
      /^K-R · contact terminal 14 → coil terminal A1 05\./u,
    ),
  );
  // #483: K-Y uses the same full wording family as K-R on sheet 7 (never mixed compact).
  const s7Groups = [
    ...sheets[6]!.document.querySelectorAll(
      '[data-peer-reference="terminal-interface"]',
    ),
  ];
  const s7Texts = s7Groups.map((el) =>
    el.tagName.toLowerCase() === "g"
      ? [...el.querySelectorAll("text")].map((t) => t.textContent).join(" ")
      : (el.textContent ?? ""),
  );
  expect(s7Texts).toContainEqual(
    expect.stringMatching(
      /^K-Y · contact terminal 14 → coil terminal A1 05\./u,
    ),
  );
  // #409: multi-line peer notes never split after "→".
  for (const el of s7Groups) {
    if (el.tagName.toLowerCase() !== "g") continue;
    const lines = [...el.querySelectorAll("text")].map(
      (t) => t.textContent ?? "",
    );
    expect(lines.slice(0, -1).every((l) => !/(?:→|->)\s*$/u.test(l))).toBe(
      true,
    );
  }
});

it("points an undrawn assembly at its exact issued inventory row (#429)", async () => {
  const render = await example("cap-pagination");
  const sheets = await render();
  const note = [
    ...sheets[1]!.document.querySelectorAll(
      '[data-peer-reference="assembly-inventory"]',
    ),
  ].find((el) => el.textContent?.includes("R1.X09"));
  expect(note?.textContent).toMatch(/^R1\.X09 · CBL1 inventory → 04\.D3$/u);
  expect(
    sheets[1]!.document.querySelector('[data-connector-port="X09"]')
      ?.textContent,
  ).toContain("outside view");
});

it("prints the matching inventory sheet alongside every strip row key (#431)", async () => {
  const render = await example("operator-console", "packet.request.json");
  const sheets = await render();
  const inventories = sheets.filter(
    (s) =>
      s.view.kind === "terminals" && s.view.title === "XT-HMI terminal plan",
  );
  expect(inventories).toHaveLength(2);
  const strips = sheets.filter((s) => s.view.kind === "terminal-strip");
  expect(strips).toHaveLength(2);
  const referenced = new Set<number>();
  for (const sheet of strips) {
    const terminals = [
      ...sheet.document.querySelectorAll("[data-strip-terminal]"),
    ];
    expect(terminals.length).toBeGreaterThan(0);
    for (const terminal of terminals) {
      const key = terminal.getAttribute("data-strip-terminal");
      const ref = terminal.getAttribute("data-strip-ref");
      const target = inventories.find((s) =>
        [...s.document.querySelectorAll("[data-strip-row]")].some(
          (el) =>
            el.getAttribute("data-strip-row") === key && el.textContent === ref,
        ),
      );
      expect(target).toBeDefined();
      const token = `S${String(target!.number).padStart(2, "0")}`;
      expect(
        terminal.querySelector("[data-strip-inventory]")?.textContent,
      ).toBe(token);
      referenced.add(target!.number);
    }
  }
  expect([...referenced]).toEqual(inventories.map((s) => s.number));
});

it("fits a long inventory key and its sheet locator at 2.5 mm (#431)", async () => {
  const keys = Array.from({ length: 105 }, (_, i) => String(i + 1));
  const ir = createTerminalIr(
    Array.from({ length: 10 }, (_, i) => ({
      uid: `strip-${i}`,
      designation: `XT${String(i + 1).padStart(2, "0")}`,
      terminalKeys: i === 9 ? keys : ["1"],
    })),
  );
  const type = ir.deviceTypes[0]!;
  type.category = "terminal-strip";
  type.terminals = [{ key: "1", source: type.source }];
  type.terminalOrder = ["1"];
  ir.deviceTypes.push({
    ...type,
    id: "type:wide-strip",
    terminals: keys.map((key) => ({ key, source: type.source })),
    terminalOrder: keys,
  });
  ir.devices[9]!.typeId = "type:wide-strip";
  const result = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    page: { size: "tabloid", orientation: "landscape" },
    index: false,
    views: [{ format: "documentation-view-request/0.1", kind: "terminals" }],
  });
  if (!result.ok) throw Error(JSON.stringify(result.error));
  const key = "T10/R100";
  const inventory = result.value.sheets.find((sheet) =>
    [...parseSvg(sheet.svg).querySelectorAll("[data-strip-row]")].some(
      (t) => t.textContent === key,
    ),
  );
  const body = result.value.sheets
    .map((sheet) =>
      parseSvg(sheet.svg).querySelector(
        `[data-strip-ref="${key}"][data-strip-terminal]`,
      ),
    )
    .find((value) => value);
  expect(result.value.sheets).toHaveLength(9);
  expect(inventory).toBeDefined();
  expect(body).toBeDefined();
  const labels = Array.from(body!.querySelectorAll("text"));
  expect(labels.map((label) => label.textContent)).toEqual([
    "100",
    key,
    `S${String(inventory!.number).padStart(2, "0")}`,
  ]);
  expect(labels.map((label) => label.getAttribute("font-size"))).toEqual([
    "2.5",
    "2.5",
    "2.5",
  ]);
  expect(new Set(labels.map((label) => label.getAttribute("y"))).size).toBe(3);
});

it("only names device and function references after they are issued (#434)", async () => {
  const render = await example("self-loop-labels");
  for (const change of [
    (r: SchematicPacketRequest) => ({ ...r, index: false }),
    (r: SchematicPacketRequest) => ({
      ...r,
      index: true,
      references: false as const,
    }),
    (r: SchematicPacketRequest) => ({ ...r, index: true }),
  ]) {
    const sheets = await render(change);
    const target = sheets.find((s) => s.view.kind === "references");
    for (const sheet of sheets.filter((s) => s.view.kind === "circuit")) {
      const ink = [...sheet.document.querySelectorAll("text")]
        .map((t) => t.textContent)
        .join(" ");
      expect(ink).toContain(
        "Source-selected circuits · [+N]: connections outside group",
      );
      expect(ink).not.toContain("device/function references in index");
      if (target) {
        expect(ink).toContain(
          `Device and function references S${String(target.number).padStart(2, "0")}`,
        );
      } else expect(ink).not.toContain("Device and function references");
    }
  }
});

it("preserves all destinations on repeated views and enforces printed destination invariant", async () => {
  const source = await compileProject("examples/motor-starter");
  if (!source.ok) throw Error(JSON.stringify(source.diagnostics));
  const baseRequest: SchematicPacketRequest = JSON.parse(
    await readFile("examples/alpha/motor-starter.packet.json", "utf8"),
  );
  // Duplicate the CBL1 conductors view (reproduces Codex repeated-view probe).
  const repeatedRequest: SchematicPacketRequest = {
    ...baseRequest,
    views: [...baseRequest.views, baseRequest.views.at(-1)!],
  };
  const result = await renderSchematicPacket(
    source.ir,
    repeatedRequest,
    source.presentation,
  );
  if (!result.ok) throw Error(JSON.stringify(result.error));
  expect(result.value.sheets).toHaveLength(8);
  const cardTexts = (sheetNumber: number) =>
    [
      ...parseSvg(result.value.sheets[sheetNumber - 1]!.svg).querySelectorAll(
        "g.off-view-annotation",
      ),
    ].map((g) => g.textContent?.replace(/\s+/gu, " ").trim() ?? "");
  // Sheet 7 must retain BOTH 03.C5 and 04.B2 (not overwritten by sheet 8's rewrite).
  expect(cardTexts(7)).toContainEqual(
    expect.stringMatching(/W-CTL-004 → PS1\.- 03\.C5 \(also shown 04\.B2\)/u),
  );
  expect(cardTexts(8)).toContainEqual(
    expect.stringMatching(/W-CTL-004 → PS1\.- 03\.C5/u),
  );
  // Renderer-side invariant accepts valid output and throws on dropped or duplicated destinations.
  const tb1 = source.ir.devices.find((d) => d.designation === "TB1")!;
  const wCtl004 = source.ir.wires.find((w) => w.designation === "W-CTL-004")!;
  const byTerminal = authoredTerminalIncidence(source.ir);
  const expected = new Map([
    [
      cardRowKey(
        { deviceUid: tb1.uid, terminalKey: "4" },
        { kind: "wire", uid: wCtl004.uid },
      ),
      ["03.C5", "04.B2"],
    ],
  ]);
  const s7 = result.value.sheets[6]!;
  expect(() =>
    verifyPrintedPeerDestinations(s7, expected, [], byTerminal),
  ).not.toThrow();
  const dropped = { ...s7, svg: s7.svg.replace(" (also shown 04.B2)", "") };
  expect(() =>
    verifyPrintedPeerDestinations(dropped, expected, [], byTerminal),
  ).toThrow(/Peer destination invariant violated/u);
  const duplicated = {
    ...s7,
    svg: s7.svg.replace("04.B2", "03.C5, 04.B2"),
  };
  expect(() =>
    verifyPrintedPeerDestinations(duplicated, expected, [], byTerminal),
  ).toThrow(/Peer destination invariant violated/u);
});

it("parses printed peer destinations structurally when conductor designations resemble sheet.zone", () => {
  const entry = {
    kind: "conductor-peer" as const,
    identity: [
      { deviceUid: "R1", terminalKey: "14" },
      { kind: "wire" as const, uid: "W37" },
      { deviceUid: "S2", terminalKey: "14" },
    ],
    owner: { x: 108, y: 184, w: 1.3, h: 1.3 },
    ownerLabel: "R1.14",
    value: "37.D6 · R1.14 → S2.14 01.A3 (also shown 02.A3)",
    compact: "→ S2.14 01.A3 (also shown 02.A3)",
    destination: "01.A3 (also shown 02.A3)",
  };
  const mkSheet = (text: string) => ({
    number: 5,
    view: {
      format: "documentation-view/0.1" as const,
      kind: "circuit" as const,
      title: "DOL control",
    },
    references: [],
    continuations: [],
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="215.9mm" height="279.4mm" viewBox="0 0 215.9 279.4"><text x="110" y="188" font-size="2.5" data-peer-reference="conductor-peer" data-peer-source="${attr(JSON.stringify(entry.identity))}">${text}</text></svg>`,
  });
  const emptyIncidence = new Map();
  // Designation "37.D6" is never counted as a destination token.
  expect(() =>
    verifyPrintedPeerDestinations(
      mkSheet("37.D6 · R1.14 → S2.14 01.A3 (also shown 02.A3)"),
      new Map(),
      [entry],
      emptyIncidence,
    ),
  ).not.toThrow();
  expect(() =>
    verifyPrintedPeerDestinations(
      mkSheet("R1.14 → 01.A3 (also shown 02.A3)"),
      new Map(),
      [entry],
      emptyIncidence,
    ),
  ).not.toThrow();
  // Real dropped, duplicated, or invented destinations still fail.
  for (const bad of [
    "37.D6 · R1.14 → S2.14 01.A3",
    "37.D6 · R1.14 → S2.14 01.A3 (also shown 01.A3, 02.A3)",
    "37.D6 · R1.14 → S2.14 01.A3 (also shown 02.A3, 99.D6)",
  ])
    expect(() =>
      verifyPrintedPeerDestinations(
        mkSheet(bad),
        new Map(),
        [entry],
        emptyIncidence,
      ),
    ).toThrow(/Peer destination invariant violated/u);
});

it("enforces owner-nearest reach on terminal-label-anchor fallback", async () => {
  const { searchNavigationSlot } =
    await import("../src/packet/navigation-slot-search.js");
  const field = { x: 28, y: 24, w: 360, h: 240 };
  const owner = { x: 50, y: 68, w: 1.3, h: 1.3 };
  const foreign = { x: 50, y: 75, w: 1.3, h: 1.3 };
  const shape = {
    id: "terminal-label-anchor",
    mode: "local" as const,
    inkMm: { x: 0, y: 0, w: 20, h: 2.5 },
    render: () => "",
  };
  const blocked = [{ x: 28, y: 24, w: 360, h: 50 }];
  const rejected = searchNavigationSlot(
    [shape],
    field,
    owner,
    blocked,
    undefined,
    [],
    false,
    undefined,
    undefined,
    false,
    () => ({
      anchors: [{ x: 50, y: 78, w: 10, h: 2.5 }],
      gap: 10,
      foreignOwners: [foreign],
      requireOwnerNearest: true,
      maxOwnerGapMm: 10,
    }),
  );
  expect(rejected).toBeUndefined();
  const accepted = searchNavigationSlot(
    [shape],
    field,
    owner,
    [],
    undefined,
    [],
    false,
    undefined,
    undefined,
    false,
    () => ({
      anchors: [owner],
      gap: 10,
      foreignOwners: [foreign],
      requireOwnerNearest: true,
      maxOwnerGapMm: 10,
    }),
  );
  expect(accepted).toBeDefined();
});

function rectGap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  return Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );
}

function parsePeerSourceEntry(el: Element) {
  const parsed: unknown = JSON.parse(el.getAttribute("data-peer-source")!);
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (
    !first ||
    typeof first !== "object" ||
    typeof first.deviceUid !== "string" ||
    typeof first.terminalKey !== "string"
  )
    throw Error("Invalid data-peer-source");
  return { deviceUid: first.deviceUid, terminalKey: first.terminalKey };
}

async function buildRm3OwnerAudit(svg: string, peers: readonly Element[]) {
  const { navigationGeometry } =
    await import("../src/packet/navigation-walk.js");
  const { project } = await import("../src/device-legend/geometry.js");
  const { printableTextMetrics } = await import("../src/text-metrics.js");
  const terminals = navigationGeometry(svg)
    .filter(
      (g) =>
        g.visible &&
        g.node.name === "circle" &&
        g.node.attrs["data-device-uid"] &&
        g.node.attrs["data-terminal-key"],
    )
    .map((g) => {
      const cx = Number(g.node.attrs.cx),
        cy = Number(g.node.attrs.cy),
        r = Number(g.node.attrs.r ?? 0);
      return {
        deviceUid: g.node.attrs["data-device-uid"]!,
        terminalKey: g.node.attrs["data-terminal-key"]!,
        box: project({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, g.matrix),
      };
    });
  expect(terminals.length).toBeGreaterThan(2);
  const peerBoxes = peers.map((el) => {
    const x = Number(el.getAttribute("x")),
      y = Number(el.getAttribute("y")),
      m = printableTextMetrics(el.textContent ?? "", 2.5);
    return {
      from: parsePeerSourceEntry(el),
      box: {
        x: x + m.left,
        y: y - m.top,
        w: m.right - m.left,
        h: m.top - m.bottom,
      },
    };
  });
  return (shiftXMm = 0) =>
    peerBoxes.map(({ from, box }) => {
      const shifted = { ...box, x: box.x + shiftXMm };
      const isOwn = (t: (typeof terminals)[number]) =>
        t.deviceUid === from.deviceUid && t.terminalKey === from.terminalKey;
      const ownerGap = Math.min(
        ...terminals.filter(isOwn).map((t) => rectGap(shifted, t.box)),
      );
      const foreignGap = Math.min(
        ...terminals
          .filter((t) => !isOwn(t))
          .map((t) => rectGap(shifted, t.box)),
      );
      return {
        ownerGap,
        foreignGap,
        ok: ownerGap <= 6.1 && ownerGap < foreignGap,
      };
    });
}

it("keeps rm3 PLC1.AI0+ and AI0- peer notes owner-associated inside the drawing field", async () => {
  const { rm3CircuitViews, rm3LoopView } =
    await import("../../core-library/test/rm3-drawings.js");
  const compiled = await compileProject(
    "packages/core-library/test/fixtures/rm3",
  );
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const circuit = await rm3CircuitViews(compiled.ir, "left-to-right");
  const loop = await rm3LoopView(
    compiled.ir,
    "packages/core-library/test/fixtures/rm3",
    "left-to-right",
  );
  const net = JSON.parse(
    await readFile(
      "packages/core-library/test/fixtures/rm3/network.request.json",
      "utf8",
    ),
  );
  const packet = await renderSchematicPacket(compiled.ir, {
    format: "schematic-packet-request/0.1",
    page: { size: "a3", orientation: "landscape", marginMm: 10 },
    views: [
      ...circuit.views,
      loop,
      net,
      ...compiled.ir.cables.map((c) => ({
        format: "schematic-view-request/0.2" as const,
        root: { by: "designation" as const, value: c.designation },
        intent: { kind: "conductors" as const },
        flow: "left-to-right" as const,
      })),
    ],
  });
  if (!packet.ok) throw Error(packet.error.message);
  const s1 = packet.value.sheets[0]!;
  const doc = parseSvg(s1.svg);
  expect([...doc.querySelectorAll("[data-peer-reference-fallback]")]).toEqual(
    [],
  );
  const peers = [
    ...doc.querySelectorAll('[data-peer-reference="conductor-peer"]'),
  ];
  expect(peers.map((el) => el.textContent)).toEqual([
    expect.stringContaining("PLC1.AI0+"),
    expect.stringContaining("PLC1.AI0-"),
  ]);
  for (const el of peers) {
    const x = Number(el.getAttribute("x"));
    expect(x).toBeGreaterThanOrEqual(28);
  }
  const [aiPlus, aiMinus] = peers.map((el) => Number(el.getAttribute("y")));
  expect(aiMinus! - aiPlus!).toBeGreaterThanOrEqual(5);

  // Guard bounded owner distance (<= 6.1 mm) and owner-nearest against foreign
  // terminals so shifting notes far from their owners (e.g. +80 mm) must fail.
  const ownerAudit = await buildRm3OwnerAudit(s1.svg, peers);
  for (const row of ownerAudit(0)) {
    expect(row.ownerGap).toBeLessThanOrEqual(6.1);
    expect(row.ownerGap).toBeLessThan(row.foreignGap);
  }
  // Mutant control: shifting both notes 80 mm right must violate owner distance / nearest-owner.
  const shiftedFar = ownerAudit(80);
  expect(shiftedFar.every((r) => !r.ok)).toBe(true);
  expect(shiftedFar.every((r) => r.ownerGap > 30)).toBe(true);
});
