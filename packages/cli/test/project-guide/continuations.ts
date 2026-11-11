import { prepareSchematicDrawing } from "../../../render/src/renderer.js";
import { rootedGangSegments } from "../../../render/src/symbols/rooted-gangs.js";
import { emitSchematicSvg } from "../../../render/src/svg/emitter.js";
import { SYMBOL_CATALOG } from "../../../render/src/symbols/catalog.js";
import { continuationFixture } from "../../../render/test/continuation-fixtures.js";
import { expect } from "vitest";
import { compileProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../../../render/src/sheets.js";
import { continuationOracle } from "../../../render/test/continuation-oracle.js";
import { parseSvg } from "../../../render/test/off-view-fixtures.js";
import { noteJson, type FactModule } from "./harness.js";

const module: FactModule = {
  facts: [
    {
      claim: "Power view switch gangs: ink/R006.",
      async check() {
        const c = await compileProject("examples/motor-starter");
        if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
        const p = await prepareSchematicDrawing(c.ir, {
          format: "schematic-view-request/0.1",
          family: "power",
          root: { by: "designation", value: "M1" },
          flow: "top-to-bottom",
        });
        if (!p.ok) throw Error(p.error.message);
        const { graph, layout, titleContext } = p.value,
          good = rootedGangSegments(c.ir, graph, layout);
        if (!good.ok) throw Error(good.error.message);
        expect(good.value).toHaveLength(4);
        const stroke = good.value[0]!,
          blocked = structuredClone(layout);
        const caption = blocked.labels.find((l) =>
          graph.deviceGroups.some((g) => g.label.id === l.id),
        )!;
        caption.x = (stroke.from.x + stroke.to.x) / 2 - caption.width / 2;
        caption.y = (stroke.from.y + stroke.to.y) / 2 - caption.height / 2;
        const result = emitSchematicSvg(
          graph,
          blocked,
          titleContext,
          SYMBOL_CATALOG,
          false,
          undefined,
          c.ir,
        );
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "R006",
            reason: "unprintable-layout",
            details: { reason: "mechanical-gang", groupId: stroke.groupId },
          },
        });
        if (result.ok) throw Error("Expected gang refusal");
        expect(result.error.message).toContain(stroke.groupId);
        noteJson(result.error);
      },
    },
    {
      claim: "Standard spacing may fold onto fewer sheets.",
      async check() {
        const c = await compileProject("examples/motor-starter");
        if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
        const r = await renderSchematicPacket(
          c.ir,
          {
            format: "schematic-packet-request/0.1",
            layout: "standard",
            page: { size: "a3", orientation: "portrait" },
            views: [
              {
                format: "schematic-view-request/0.1",
                family: "power",
                root: { by: "designation", value: "M1" },
                flow: "left-to-right",
              },
            ],
          },
          c.presentation,
        );
        if (!r.ok) throw Error(JSON.stringify(r.error));
        expect(r.value.sheets).toHaveLength(1);
        expect(r.value.html).toContain("Folded circuit sections");
        expect(continuationOracle(c.ir, r.value).sameSheet).toBeGreaterThan(0);
        noteJson({ standardFoldedSheets: r.value.sheets.length });
      },
    },

    {
      claim:
        "Cards name omissions. Continuations print wire ID + peer `sheet.zone` at 2.5 mm; unnamed jumpers use `JUMPER` + full UID.",
      async check() {
        const c = await compileProject("examples/motor-starter");
        if (!c.ok) throw Error(JSON.stringify(c.diagnostics));
        const refused = await renderSchematicPacket(c.ir, {
          format: "schematic-packet-request/0.1",
          views: [
            {
              format: "schematic-view-request/0.1",
              root: { by: "designation", value: "LS1" },
              family: "power",
            },
          ],
        });
        expect(refused).toMatchObject({
          ok: false,
          error: { code: "R001", details: { designation: "LS1" } },
        });
        const r = await renderSchematicPacket(c.ir, {
          format: "schematic-packet-request/0.1",
          views: [
            {
              format: "schematic-view-request/0.1",
              root: { by: "designation", value: "M1" },
              family: "power",
            },
            {
              format: "schematic-view-request/0.2",
              root: { by: "designation", value: "CBL1" },
              family: "control",
              intent: { kind: "conductors" },
            },
          ],
        });
        if (!r.ok) throw Error(JSON.stringify(r.error));
        const jumper = await continuationFixture(true);
        try {
          const j = await renderSchematicPacket(jumper.ir, {
            format: "schematic-packet-request/0.1",
            views: [
              {
                format: "schematic-view-request/0.1",
                root: { by: "designation", value: "K1" },
                family: "control",
              },
            ],
          });
          if (!j.ok) throw Error(JSON.stringify(j.error));
          noteJson(
            j.value.sheets.flatMap((s) =>
              [...parseSvg(s.svg).querySelectorAll("a text")].map(
                (t) => t.textContent,
              ),
            ),
          );
          expect(continuationOracle(jumper.ir, j.value).ends).toBeGreaterThan(
            0,
          );
          expect(j.value.sheets.map((s) => s.svg).join("\n")).toContain(
            ">JUMPER</text>",
          );
        } finally {
          await jumper.dispose();
        }
        expect(continuationOracle(c.ir, r.value).ends).toBeGreaterThan(0);
        const svg = r.value.sheets.map((s) => s.svg).join("\n");
        expect(svg).toContain("Off-view at");
        const texts = r.value.sheets.flatMap((s) => [
          ...parseSvg(s.svg).querySelectorAll(
            "a[data-continuation-id] text, [data-cable-uid][data-conductor-id] text",
          ),
        ]);
        const usage = texts.filter(
          (t) => t.textContent === "ASSIGNED / USAGE UNSPECIFIED",
        );
        expect(usage.length).toBe(4);
        for (const t of [...usage, ...texts.filter((t) => t.closest("a"))])
          expect(Number(t.getAttribute("font-size"))).toBe(2.5);
      },
    },
  ],
  unexecuted: new Map(),
};
export default module;
