import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOMParser } from "linkedom";
import { beforeAll, expect, it } from "vitest";
import {
  compileProject,
  lockProject,
  type ElectricalIr,
} from "@thermite/compiler";
import { terminalPassThroughFixture } from "../fixtures/presentation-cases.js";
import { layoutPresentationGraph } from "../src/layout/elk-adapter.js";
import { buildPresentationGraph } from "../src/presentation.js";
import { renderSchematic } from "../src/renderer.js";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";
import { emitSchematicSvg } from "../src/svg/emitter.js";
import { prepareSchematicTitleContext } from "../src/title-block.js";
import { compileCoreFixture } from "./fixtures.js";
import {
  request as seriesRequest,
  seriesFixture,
} from "./series-loop-fixture.js";

let ir: ElectricalIr;
beforeAll(async () => {
  ir = await compileCoreFixture();
});

const parseSvg = (svg: string) =>
  new DOMParser().parseFromString(svg, "image/svg+xml");

async function renderDirectAnalogOutput(
  flow: "left-to-right" | "top-to-bottom",
) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-caption-own-"));
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
        project: { name: "Caption ownership check" },
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
    const baseReq: SchematicPacketRequest = JSON.parse(
      await readFile(
        resolve("packages/cli/fixtures/analog-output/packet.request.json"),
        "utf8",
      ),
    );
    const view = { ...baseReq.views[0]!, flow };
    const req: SchematicPacketRequest = {
      ...baseReq,
      views: [view],
      page:
        flow === "top-to-bottom"
          ? { size: "tabloid", orientation: "portrait" }
          : baseReq.page,
    };
    const rendered = await renderSchematicPacket(compiled.ir, req);
    if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
    return rendered.value.sheets[0]!.svg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it.each(["left-to-right", "top-to-bottom"] as const)(
  "rooted view emits data-terminal-key and data-terminal-caption-body on printed terminal captions (%s)",
  async (flow) => {
    const out = await renderSchematic(ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "K1" },
      family: "control",
      flow,
    });
    if (!out.ok) throw Error(JSON.stringify(out.error));
    const doc = parseSvg(out.value.svg);
    const captions = [...doc.querySelectorAll("text.label-terminal")];
    expect(captions.length).toBeGreaterThan(0);
    for (const text of captions) {
      expect(text.getAttribute("data-terminal-key")).toBe(
        text.textContent?.trim(),
      );
      const body = text.getAttribute("data-terminal-caption-body");
      expect(body).toBeTruthy();
      expect(Array.isArray(JSON.parse(body!))).toBe(true);
    }
    for (const nonTerminal of doc.querySelectorAll(
      "text.label-device,text.label-net,text.label-wire,text.label-function",
    ))
      expect(nonTerminal.hasAttribute("data-terminal-caption-body")).toBe(
        false,
      );

    // Suppressed pass-through placeholders stay empty without ownership attrs.
    const f = terminalPassThroughFixture(ir);
    const built = buildPresentationGraph({
      ir: f.ir,
      selected: { ...f.selected, view: { ...f.selected.view, flow } },
    });
    if (!built.ok) throw Error(JSON.stringify(built));
    const laid = await layoutPresentationGraph(built.value.graph);
    if (!laid.ok) throw Error(JSON.stringify(laid));
    const title = prepareSchematicTitleContext(
      "Pass-through",
      built.value.graph.view,
    );
    if (!title.ok) throw Error(JSON.stringify(title));
    const emitted = emitSchematicSvg(
      built.value.graph,
      laid.value,
      title.value,
    );
    if (!emitted.ok) throw Error(JSON.stringify(emitted));
    const ptDoc = parseSvg(emitted.value);
    const emptyTexts = [...ptDoc.querySelectorAll("text")].filter(
      (t) => t.textContent === "",
    );
    expect(emptyTexts.length).toBeGreaterThan(0);
    for (const empty of emptyTexts)
      expect(empty.hasAttribute("data-terminal-caption-body")).toBe(false);
  },
);

it("wiring view emits data-terminal-key, data-terminal-caption-body, and data-outside-connections on terminal captions", async () => {
  const rendered = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "Wiring ownership probe",
        conductors: ["W-CTL-001", "W-CTL-002"],
      },
    ],
  });
  if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
  const doc = parseSvg(rendered.value.sheets[0]!.svg);
  const owned = [...doc.querySelectorAll("text[data-terminal-caption-body]")];
  expect(owned.length).toBe(4);
  let sawOutside = false;
  for (const text of owned) {
    const key = text.getAttribute("data-terminal-key");
    const body = text.getAttribute("data-terminal-caption-body");
    const outside = text.getAttribute("data-outside-connections");
    expect(key).toBeTruthy();
    expect(body).toMatch(/^d\d+$/u);
    expect(text.closest("[data-device-uid]")).not.toBeNull();
    const label = text.textContent?.trim() ?? "";
    if (outside) {
      sawOutside = true;
      expect(label).toBe(`${key} [ +${outside} ]`);
    } else {
      expect(label).toBe(key);
    }
  }
  expect(sawOutside).toBe(true);
  for (const header of doc.querySelectorAll("text[data-tag-kind='body']"))
    expect(header.hasAttribute("data-terminal-caption-body")).toBe(false);
});

it.each(["left-to-right", "top-to-bottom"] as const)(
  "direct and series signal-loop views emit ownership attributes only on printed terminal captions (%s)",
  async (flow) => {
    const directSvg = await renderDirectAnalogOutput(flow);
    const directDoc = parseSvg(directSvg);
    const directOwned = [
      ...directDoc.querySelectorAll("text[data-terminal-caption-body]"),
    ];
    expect(directOwned.length).toBeGreaterThan(0);
    for (const text of directOwned) {
      expect(text.getAttribute("data-terminal-key")).toBe(
        text.textContent?.trim(),
      );
      expect(text.getAttribute("data-terminal-caption-body")).toMatch(
        /^n\d+$/u,
      );
      expect(text.closest("[data-device-uid]")).not.toBeNull();
    }
    const aux = [...directDoc.querySelectorAll("text")].filter((t) =>
      t.textContent?.includes("feed"),
    );
    expect(aux.length).toBeGreaterThan(0);
    for (const desc of aux)
      expect(desc.hasAttribute("data-terminal-caption-body")).toBe(false);

    const f = await seriesFixture();
    try {
      const res = await renderSchematicPacket(f.ir, {
        format: "schematic-packet-request/0.1",
        views: [seriesRequest({ flow })],
      });
      if (!res.ok) throw Error(JSON.stringify(res.error));
      const seriesDoc = parseSvg(res.value.sheets[0]!.svg);
      const seriesOwned = [
        ...seriesDoc.querySelectorAll("text[data-terminal-caption-body]"),
      ];
      expect(seriesOwned.length).toBeGreaterThan(0);
      for (const text of seriesOwned) {
        expect(text.getAttribute("data-terminal-key")).toBe(
          text.textContent?.trim(),
        );
        expect(text.getAttribute("data-terminal-caption-body")).toBeTruthy();
        expect(text.closest("[data-loop-terminal]")).not.toBeNull();
      }
      for (const header of seriesDoc.querySelectorAll(
        "text[data-tag-kind='body']",
      ))
        expect(header.hasAttribute("data-terminal-caption-body")).toBe(false);
    } finally {
      await f.dispose();
    }
  },
);
