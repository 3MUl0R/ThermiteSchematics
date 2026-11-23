import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { compileProject, lockProject } from "@thermite/compiler";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";
import {
  prepareSignalLoopDrawing,
  type SignalLoopViewRequest,
} from "../src/signal-loop.js";
import { signal } from "../../../evals/draw/corpus/requests.mjs";
import { flows } from "./direct-loop-fixture.js";
import { request, seriesFixture, wire } from "./series-loop-fixture.js";

const shippedCases = [
  {
    name: "analog-output",
    fixture: "packages/cli/fixtures/analog-output",
    requestPath: "packages/cli/fixtures/analog-output/packet.request.json",
    passThrough: ["1", "2"],
    singlePort: ["3", "4"],
  },
  {
    name: "signal-loop",
    fixture: "packages/cli/fixtures/signal-loop",
    request: signal,
    passThrough: ["1", "2"],
    singlePort: [],
  },
] as const;

async function renderShippedLoop(
  fixtureDir: string,
  packetRequest: {
    format: "schematic-packet-request/0.1";
    page?: {
      size?: "tabloid" | "a3" | "letter";
      orientation?: "landscape" | "portrait";
    };
    views: readonly SignalLoopViewRequest[];
  },
  flow: (typeof flows)[number],
) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-loop-labels-"));
  try {
    for (const name of ["field-interfaces", "industrial-pilot"])
      await cp(resolve("libraries", name), join(dir, name), {
        recursive: true,
      });
    await cp(resolve(fixtureDir, "source.json"), join(dir, "source.json"));
    await writeFile(
      join(dir, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: "Shipped signal loop" },
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
    const view: SignalLoopViewRequest = { ...packetRequest.views[0]!, flow };
    const req: SchematicPacketRequest = {
      ...packetRequest,
      views: [view],
      page:
        flow === "top-to-bottom"
          ? {
              size: packetRequest.page?.size ?? "tabloid",
              orientation: "portrait",
            }
          : packetRequest.page,
    };
    const rendered = await renderSchematicPacket(compiled.ir, req);
    if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
    return { ir: compiled.ir, svg: rendered.value.sheets[0]!.svg };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function directPortTexts(body: Element, uid: string, terminalKey: string) {
  const key = JSON.stringify([uid, terminalKey]);
  const circles = [
    ...body.querySelectorAll("circle[data-loop-terminal]"),
  ].filter((c) => c.getAttribute("data-loop-terminal") === key);
  const labels = circles.flatMap((c) => {
    const next = c.nextElementSibling;
    return next?.tagName.toLowerCase() === "text" &&
      next.textContent?.trim() === terminalKey
      ? [{ port: c.getAttribute("data-layout-port") ?? "", text: next }]
      : [];
  });
  return { circles, labels };
}

it.each(
  shippedCases.flatMap((entry) => flows.map((flow) => ({ ...entry, flow }))),
)(
  "prints one terminal label per physical pass-through terminal on XT1 in $name ($flow)",
  async (entry) => {
    const packetRequest =
      "requestPath" in entry
        ? JSON.parse(await readFile(resolve(entry.requestPath), "utf8"))
        : entry.request;
    const { ir, svg } = await renderShippedLoop(
      entry.fixture,
      packetRequest,
      entry.flow,
    );
    const xt1 = ir.devices.find((d) => d.designation === "XT1")!;
    const { document } = parseHTML(svg);
    const body = document.querySelector(`g[data-device-uid="${xt1.uid}"]`)!;
    expect(body).toBeTruthy();

    for (const key of entry.passThrough) {
      const { circles, labels } = directPortTexts(body, xt1.uid, key);
      // Both pass-through routing ports remain intact.
      expect(circles).toHaveLength(2);
      // Exactly one terminal-number label prints on the entry ("in") port.
      expect(labels).toHaveLength(1);
      expect(labels[0]!.port).toContain("_in_");
    }
    for (const key of entry.singlePort) {
      const { circles, labels } = directPortTexts(body, xt1.uid, key);
      expect(circles).toHaveLength(1);
      expect(labels).toHaveLength(1);
    }
  },
);

it.each(flows)(
  "prints one terminal label per physical pass-through terminal on a series-loop strip (%s)",
  async (flow) => {
    const f = await seriesFixture((m) => {
      m.objects = m.objects.filter((o) => o.kind !== "wire");
      m.objects.push(
        wire(10, "PS1", "p", "TB1", "1"),
        wire(11, "TB1", "1", "TX1", "p"),
        wire(12, "TX1", "n", "TB1", "2"),
        wire(13, "TB1", "2", "AI1", "p"),
        wire(14, "AI1", "n", "PS1", "n"),
      );
    });
    try {
      const drawing = await prepareSignalLoopDrawing(f.ir, request({ flow }));
      const tb1 = f.ir.devices.find((d) => d.designation === "TB1")!;
      const { document } = parseHTML(drawing.content);
      const body = document.querySelector(`g[data-device-uid="${tb1.uid}"]`)!;
      expect(body).toBeTruthy();
      for (const terminalKey of ["1", "2"]) {
        const key = JSON.stringify([tb1.uid, terminalKey]);
        const ports = [
          ...body.querySelectorAll("g[data-loop-terminal]"),
        ].filter((g) => g.getAttribute("data-loop-terminal") === key);
        expect(ports).toHaveLength(2);
        const labelled = ports.filter((g) => g.querySelector("text"));
        expect(labelled).toHaveLength(1);
        expect(labelled[0]!.getAttribute("data-layout-port")).toMatch(/_in$/);
      }
    } finally {
      await f.dispose();
    }
  },
);
