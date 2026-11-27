import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  compileProject,
  lockProject,
} from "../../packages/compiler/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { buildDocumentation } from "../../packages/query/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { documentIdentity } from "../../packages/render/dist/packet/document-facts.js";
import {
  coreSupply,
  request as seriesRequest,
  seriesFixture,
  withCable,
} from "../../packages/render/test/series-loop-fixture.ts";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import * as corpusRequests from "./corpus/requests.mjs";
import { dependencyFindings } from "./document-dependencies.mjs";
import { evaluateSheet, symbolsFromGeometry } from "./evaluate.mjs";
import { buildSourceTables, scopeTables } from "./m3-documents.mjs";

let browser, context, page;
const disposers = [];

beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
  await page.emulateMedia({ media: "print" });
});

afterAll(async () => {
  for (const fn of disposers) await fn();
  await context?.close();
  await browser?.close();
});

const measure = (svg) => openSheet(page, embedPrintableFont(svg));

async function measurePacket(packet) {
  const geometries = [];
  for (const sheet of packet.sheets) geometries.push(await measure(sheet.svg));
  return geometries;
}

function buildContext(packet, geometries, ir, presentation, request) {
  const binding = documentIdentity(ir, presentation);
  const tables = scopeTables(
    packet,
    geometries,
    ir,
    buildSourceTables(ir, request, buildDocumentation),
    request,
  );
  Object.assign(tables, { binding, request, presentation });
  return { binding, tables };
}

function runM3(packet, geometries, ir, request, ctx, idx) {
  return dependencyFindings(
    packet.sheets[idx],
    packet,
    geometries[idx],
    geometries,
    ir,
    request,
    ctx,
  );
}

async function mutateSvg(svg, fn, arg) {
  await page.setContent(svg);
  return page.evaluate(fn, arg);
}

async function renderSeriesCablePacket(views) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-m3-series-"));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  const built = await seriesFixture(async (m) => {
    withCable(m);
    await coreSupply(m, "0.2.0");
  });
  disposers.push(built.dispose);
  const compiled = await compileProject(built.root);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const req = { format: "schematic-packet-request/0.1", index: false, views };
  const rendered = await renderSchematicPacket(
    compiled.ir,
    req,
    compiled.presentation,
  );
  if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
  const packet = rendered.value;
  const geometries = await measurePacket(packet);
  const ctx = buildContext(
    packet,
    geometries,
    compiled.ir,
    compiled.presentation,
    req,
  );
  return { ...compiled, request: req, packet, geometries, ctx };
}

async function renderCollapsedSignalLoopPacket() {
  const dir = await mkdtemp(join(tmpdir(), "thermite-m3-collapsed-"));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  for (const lib of ["field-interfaces", "industrial-pilot"])
    await cp(resolve("libraries", lib), join(dir, lib), { recursive: true });
  await cp(
    resolve("packages/cli/fixtures/signal-loop/source.json"),
    join(dir, "source.json"),
  );
  await writeFile(
    join(dir, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: "M3 collapsed assembly fixture" },
      sources: ["source.json"],
      libraries: ["field-interfaces", "industrial-pilot"].map((lib) => ({
        name: lib,
        version: "0.1.0",
        path: lib,
      })),
    }),
  );
  expect((await lockProject(dir)).ok).toBe(true);
  const compiled = await compileProject(dir);
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const req = structuredClone(corpusRequests.signal);
  const rendered = await renderSchematicPacket(
    compiled.ir,
    req,
    compiled.presentation,
  );
  if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
  const packet = rendered.value;
  const geometries = await measurePacket(packet);
  const ctx = buildContext(
    packet,
    geometries,
    compiled.ir,
    compiled.presentation,
    req,
  );
  return { ...compiled, request: req, packet, geometries, ctx };
}

async function renderOperatorConsolePacket() {
  const compiled = await compileProject(resolve("examples/operator-console"));
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const req = JSON.parse(
    await readFile(
      resolve("examples/operator-console/packet.request.json"),
      "utf8",
    ),
  );
  const rendered = await renderSchematicPacket(
    compiled.ir,
    req,
    compiled.presentation,
  );
  if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
  const packet = rendered.value;
  const geometries = await measurePacket(packet);
  const ctx = buildContext(
    packet,
    geometries,
    compiled.ir,
    compiled.presentation,
    req,
  );
  return { ...compiled, request: req, packet, geometries, ctx };
}

const mutateFirstCableCore = ({ attr, mode }) => {
  const groups = [...document.querySelectorAll(`[${attr}]`)].filter((e) =>
    e.getAttribute(attr).startsWith("{"),
  );
  if (!groups.length) throw Error(`Missing cable group for ${attr}`);
  if (mode === "remove-all-groups") {
    for (const g of groups) g.remove();
    return document.querySelector("svg").outerHTML;
  }
  const group = groups[0];
  if (mode === "remove-group") {
    group.remove();
    return document.querySelector("svg").outerHTML;
  }
  const paths = [...group.querySelectorAll("path,line,polyline")];
  if (!paths.length) throw Error(`Missing route path for ${attr}`);
  if (mode === "ancestor-opacity-0") group.setAttribute("opacity", "0");
  for (const p of paths) {
    if (mode === "remove-path-only") p.remove();
    else if (mode === "white-stroke") p.setAttribute("stroke", "white");
    else if (mode === "white-stroke-dark-fill") {
      p.setAttribute("stroke", "white");
      p.setAttribute("fill", "#23566d");
    } else if (mode === "transparent-stroke")
      p.setAttribute("stroke-opacity", "0");
    else if (mode === "zero-width") p.setAttribute("stroke-width", "0");
    else if (mode === "zero-length") p.setAttribute("d", "M 10 10 L 10 10");
  }
  return document.querySelector("svg").outerHTML;
};

it("signal-loop individually drawn cable: baseline passes; every missing-core and ink mutant fails M3", async () => {
  const fx = await renderSeriesCablePacket([
    seriesRequest({
      flow: "left-to-right",
      loopPower: { device: "PS1", function: "dc_output" },
    }),
  ]);
  const base = runM3(fx.packet, fx.geometries, fx.ir, fx.request, fx.ctx, 0);
  expect([...base.findings, ...base.targetFindings]).toEqual([]);

  for (const mode of [
    "remove-group",
    "remove-all-groups",
    "remove-path-only",
    "white-stroke",
    "white-stroke-dark-fill",
    "transparent-stroke",
    "zero-width",
    "ancestor-opacity-0",
    "zero-length",
  ]) {
    const svg = await mutateSvg(fx.packet.sheets[0].svg, mutateFirstCableCore, {
      attr: "data-loop-conductor",
      mode,
    });
    const mgs = fx.geometries.slice();
    mgs[0] = await measure(svg);
    const res = runM3(fx.packet, mgs, fx.ir, fx.request, fx.ctx, 0);
    expect(
      res.findings.some((f) => f.need === "core-inventory"),
      `Expected core-inventory failure for mode=${mode}`,
    ).toBe(true);
    expect(
      res.findings.map((f) => f.kind),
      `Expected missing caption/target for mode=${mode}`,
    ).toContain("document-native-need-without-visible-caption");
  }
});

it("collapsed cable assembly: baseline passes; deleting core-inventory rows fails M3", async () => {
  const fx = await renderCollapsedSignalLoopPacket();
  const idx = fx.packet.sheets.findIndex((s) =>
    s.svg.includes("data-cable-assembly"),
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  const base = runM3(fx.packet, fx.geometries, fx.ir, fx.request, fx.ctx, idx);
  expect([...base.findings, ...base.targetFindings]).toEqual([]);

  const dep = fx.packet.navigation.dependencies.find(
    (d) => d.owner.sheet === idx + 1 && d.need === "core-inventory",
  );
  const rowIds = new Set(dep.resolution.flatMap((r) => r.rows));
  const rows = fx.packet.navigation.documents
    .flatMap((d) => d.rows ?? [])
    .filter((r) => rowIds.has(r.id));
  const mgs = fx.geometries.slice();
  for (const si of new Set(rows.map((r) => r.sheet - 1))) {
    const keys = rows.filter((r) => r.sheet === si + 1).map((r) => r.nativeKey);
    const svg = await mutateSvg(
      fx.packet.sheets[si].svg,
      (targetKeys) => {
        for (const e of document.querySelectorAll("[data-report-row]"))
          if (targetKeys.includes(e.getAttribute("data-report-row")))
            e.remove();
        return document.querySelector("svg").outerHTML;
      },
      keys,
    );
    mgs[si] = await measure(svg);
  }
  const mutated = runM3(fx.packet, mgs, fx.ir, fx.request, fx.ctx, idx);
  expect(mutated.findings.map((f) => f.kind)).toContain(
    "printed-document-target-insufficient",
  );
});

it("wiring view with cable cores: baseline passes; orphan legend and every ink mutant fail M3", async () => {
  const fx = await renderSeriesCablePacket([
    {
      format: "wiring-view-request/0.1",
      title: "TX1 cable wiring",
      conductors: ["CB1/A", "CB1/B", "W10", "W11"],
    },
  ]);
  const base = runM3(fx.packet, fx.geometries, fx.ir, fx.request, fx.ctx, 0);
  expect([...base.findings, ...base.targetFindings]).toEqual([]);

  const orphanSvg = await mutateSvg(fx.packet.sheets[0].svg, () => {
    const note = [...document.querySelectorAll("text")].find((t) =>
      t.textContent.includes(
        "Terminal wiring: device internals are not shown.",
      ),
    );
    if (!note) throw Error("Missing wiring legend");
    note.textContent =
      "Terminal wiring: device internals are not shown. [ +N ] = other physical connections at that terminal; see wire schedule.";
    return document.querySelector("svg").outerHTML;
  });
  const orphanGs = fx.geometries.slice();
  orphanGs[0] = await measure(orphanSvg);
  const orphan = runM3(fx.packet, orphanGs, fx.ir, fx.request, fx.ctx, 0);
  expect(orphan.findings.map((f) => f.kind)).toContain(
    "document-visible-caption-without-native-need",
  );

  for (const mode of [
    "remove-path-only",
    "white-stroke",
    "white-stroke-dark-fill",
    "transparent-stroke",
    "zero-width",
    "ancestor-opacity-0",
    "zero-length",
  ]) {
    const svg = await mutateSvg(fx.packet.sheets[0].svg, mutateFirstCableCore, {
      attr: "data-wiring-conductor",
      mode,
    });
    const mgs = fx.geometries.slice();
    mgs[0] = await measure(svg);
    const res = runM3(fx.packet, mgs, fx.ir, fx.request, fx.ctx, 0);
    expect(
      res.findings.some((f) => f.need === "conductor-incidence"),
      `Expected conductor-incidence failure for mode=${mode}`,
    ).toBe(true);
    expect(res.findings.map((f) => f.kind)).toContain(
      "printed-document-target-insufficient",
    );
  }
});

it("missing [+N] marker mutant: full production evaluateSheet() fails via DQ-17 while M3 does not duplicate it", async () => {
  const fx = await renderOperatorConsolePacket();
  const idx = fx.packet.sheets.findIndex(
    (s) =>
      s.view.kind === "wiring" && s.svg.includes("data-outside-connections="),
  );
  expect(idx).toBeGreaterThanOrEqual(0);
  const sheet = fx.packet.sheets[idx];
  const evalOne = (gs) =>
    evaluateSheet(
      { id: "operator-console-left-to-right", flow: "left-to-right" },
      sheet,
      fx.packet,
      gs[idx],
      fx.ir,
      [],
      [],
      symbolsFromGeometry(gs[idx], fx.ir),
      fx.ctx.tables,
      gs,
      fx.request,
      {},
      [],
    );

  const baseObs = evalOne(fx.geometries);
  const baseDq17 = baseObs.find((o) => o.dq === "DQ-17");
  const baseM3 = baseObs.find(
    (o) => o.dq === "DQ-19" && o.id.includes("dependencies-"),
  );
  expect(baseDq17.status).toBe("pass");
  expect(baseM3.status).toBe("pass");

  const mutatedSvg = await mutateSvg(sheet.svg, () => {
    const marker = document.querySelector("text[data-outside-connections]");
    if (!marker) throw Error("Missing outside-connection marker");
    marker.textContent = marker.textContent.replace(/\s*\[\s*\+\d+\s*\]/u, "");
    return document.querySelector("svg").outerHTML;
  });
  const mgs = fx.geometries.slice();
  mgs[idx] = await measure(mutatedSvg);
  const mutatedObs = evalOne(mgs);
  const mutDq17 = mutatedObs.find((o) => o.dq === "DQ-17");
  const mutM3 = mutatedObs.find(
    (o) => o.dq === "DQ-19" && o.id.includes("dependencies-"),
  );
  expect(mutDq17.status).toBe("fail");
  expect(mutDq17.evidence.findings.map((f) => f.kind)).toContain(
    "missing-outside-connection-count",
  );
  expect(mutM3.status).toBe("pass");
});
