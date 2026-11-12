import { expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compileProject, lockProject } from "@thermite/compiler";
import { parseHTML } from "linkedom";
import { prepareSignalLoopDrawing } from "../src/signal-loop.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { routeQuality } from "../../../evals/draw/checks.mjs";
import { flows } from "./direct-loop-fixture.js";

it.each(flows)(
  "keeps the synthetic output loop complete and landed without short internal jogs in %s",
  async (flow) => {
    const dir = await mkdtemp(join(tmpdir(), "thermite-output-jog-"));
    try {
      for (const name of ["field-interfaces", "industrial-pilot"])
        await cp(resolve("libraries", name), join(dir, name), {
          recursive: true,
        });
      await cp(
        resolve("packages/cli/fixtures/analog-output/source.json"),
        join(dir, "source.json"),
      );
      await writeFile(
        join(dir, "system.json"),
        JSON.stringify({
          format: "electrical-system/0.1",
          project: { name: "Synthetic output loop" },
          sources: ["source.json"],
          libraries: ["field-interfaces", "industrial-pilot"].map((name) => ({
            name,
            version: "0.1.0",
            path: name,
          })),
        }),
      );
      expect((await lockProject(dir)).ok).toBe(true);
      const compiled = await compileProject(dir);
      if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
      const ir = compiled.ir,
        before = JSON.stringify(ir);
      const packet = JSON.parse(
        await readFile(
          "packages/cli/fixtures/analog-output/packet.request.json",
          "utf8",
        ),
      );
      const request = { ...packet.views[0], flow };
      const drawing = await prepareSignalLoopDrawing(ir, request);
      const doc = parseHTML(drawing.content).document;
      const paths = [...doc.querySelectorAll("[data-loop-conductor]")];
      expect(paths).toHaveLength(6);
      for (const route of paths) {
        const wire = ir.wires.find(
          (w) => w.uid === route.getAttribute("data-loop-conductor"),
        )!;
        expect(JSON.parse(route.getAttribute("data-terminal-ends")!)).toEqual(
          wire.endpoints.map((e) => e.terminal),
        );
        const points = [
          ...route
            .querySelector("path")!
            .getAttribute("d")!
            .matchAll(/[ML] ([-.\d]+) ([-.\d]+)/g),
        ].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
        expect(
          routeQuality({
            width: 1000,
            height: 1000,
            shapes: [{ conductor: true, stroke: 0.4, points }],
          }),
          wire.designation,
        ).toEqual([]);
      }
      expect(doc.querySelectorAll("[data-cable-assembly]")).toHaveLength(1);
      const rendered = await renderSchematicPacket(ir, {
        ...packet,
        views: [request],
        page: {
          ...packet.page,
          orientation: flow === "top-to-bottom" ? "portrait" : "landscape",
        },
      });
      if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
      expect(rendered.value.sheets).toHaveLength(1);
      expect(JSON.stringify(ir)).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
