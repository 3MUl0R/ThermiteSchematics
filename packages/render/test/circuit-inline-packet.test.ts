import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import type { SchematicPacketRequest, RenderedPacket } from "../src/sheets.js";
import { renderSchematicPacket } from "../src/index.js";
import * as inline from "../src/layout/circuit-inline.js";
import { createElkEngine } from "../src/layout/elk-runtime.js";
import { circuitInlineTrace } from "../src/layout/circuit-inline-context.js";
import { circuitPacketGuard } from "../src/layout/circuit-packet-guard.js";

let ir: ElectricalIr, request: SchematicPacketRequest;
beforeAll(async () => {
  const root = new URL(
    "../../../examples/functional-symbols/",
    import.meta.url,
  );
  const compiled = await compileProject(fileURLToPath(root));
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  ir = compiled.ir;
  request = JSON.parse(
    await readFile(new URL("packet-left-to-right.request.json", root), "utf8"),
  );
});
afterEach(() => vi.restoreAllMocks());
async function native(q: SchematicPacketRequest) {
  const spy = vi
    .spyOn(inline, "layoutCircuitGroup")
    .mockImplementation((input) =>
      createElkEngine().layout(structuredClone(input)),
    );
  try {
    return await renderSchematicPacket(ir, q);
  } finally {
    spy.mockRestore();
  }
}
it("keeps the LTR sensor group on the original baseline when W10 pays for W8/W9's repair", async () => {
  const before = await native(request),
    after = await renderSchematicPacket(ir, request);
  if (!before.ok || !after.ok) throw Error(JSON.stringify({ before, after }));
  const groups = (p: RenderedPacket) =>
    p.sheets.flatMap((s) =>
      [
        ...parseHTML(s.svg).document.querySelectorAll(
          '[data-circuit-group="level-sensor"]',
        ),
      ].map((n) => n.outerHTML),
    );
  expect(groups(after.value)).toEqual(groups(before.value));
  expect(after.value.sheets.length).toBe(before.value.sheets.length);
});
it.each(["a3-landscape", "a3-portrait", "letter-landscape"])(
  "rejects the six TTB page-growth settings (%s, both layouts)",
  async (setting) => {
    const [size, orientation] = setting.split("-") as [
      "a3" | "letter",
      "landscape" | "portrait",
    ];
    for (const layout of ["standard", "compact"] as const) {
      const q = {
        ...request,
        page: { size, orientation },
        layout,
        views: request.views.map((v) =>
          v.format === "circuit-view-request/0.1"
            ? { ...v, flow: "top-to-bottom" as const }
            : v,
        ),
      };
      const before = await native(q),
        traces: NonNullable<Parameters<typeof circuitInlineTrace.run>[0]> = [];
      const after = await circuitInlineTrace.run(traces, () =>
        renderSchematicPacket(ir, q),
      );
      expect(after).toEqual(before);
      expect(traces[0]!.selected.size).toBe(0);
      expect(traces[0]!.viewDecisions[0]!.reason).toMatch(
        /growth|composition fit/,
      );
    }
  },
);
function packet(svg: string): RenderedPacket {
  return {
    format: "schematic-packet/0.1",
    page: {
      size: "a3",
      orientation: "landscape",
      widthMm: 420,
      heightMm: 297,
      marginMm: 10,
    },
    sheets: [
      {
        number: 1,
        view: {
          format: "documentation-view/0.1",
          kind: "circuit",
          title: "Circuit",
        },
        svg,
        references: [],
        continuations: [],
      },
    ],
    html: "",
    coverage: {} as RenderedPacket["coverage"],
  };
}
it("rejects packet/view growth and dropped or less-local navigation annotations", () => {
  const before = packet('<svg><g data-navigation-view="view"/></svg>');
  const after = structuredClone(before);
  after.sheets = [...after.sheets, ...after.sheets];
  expect(circuitPacketGuard(after, before)).toBe(false);
  const twoViews = packet(
    '<svg><g data-navigation-view="view"/><g data-navigation-view="other"/></svg>',
  );
  expect(circuitPacketGuard(before, twoViews)).toBe(false);
  const annotation = {
    id: "annotation",
    targets: ["target"],
    locality: { mode: "local", distanceMm: 15 },
  };
  before.navigation = {
    annotations: [annotation],
  } as unknown as RenderedPacket["navigation"];
  const changed = structuredClone(before);
  changed.navigation = {
    annotations: [],
  } as unknown as RenderedPacket["navigation"];
  expect(circuitPacketGuard(changed, before)).toBe(false);
  for (const locality of [
    { mode: "self-located", distanceMm: 14 },
    { mode: "local", distanceMm: 15.2 },
  ]) {
    changed.navigation = {
      annotations: [{ ...annotation, locality }],
    } as unknown as RenderedPacket["navigation"];
    expect(circuitPacketGuard(changed, before)).toBe(false);
  }
});
it("rejects dropped cards and card distance growth on circuit sheets, including transformed geometry", () => {
  const card =
    '<g data-off-view-terminal-id="{&quot;deviceUid&quot;:&quot;dev&quot;,&quot;terminalKey&quot;:&quot;1&quot;}" data-off-view-conductors="[]"><rect class="off-view-card" x="20" y="10" width="20" height="10" stroke-width=".75"/></g>';
  const wrap = (content: string) =>
    `<svg><g transform="translate(5 5)"><circle class="terminal-marker" data-device-uid="dev" data-terminal-key="1" cx="10" cy="15"/>${content}</g></svg>`;
  const before = packet(wrap(card));
  expect(circuitPacketGuard(packet(wrap("")), before)).toBe(false);
  expect(
    circuitPacketGuard(
      packet(wrap(`<g transform="translate(5 0)">${card}</g>`)),
      before,
    ),
  ).toBe(false);
  expect(circuitPacketGuard(structuredClone(before), before)).toBe(true);
});
