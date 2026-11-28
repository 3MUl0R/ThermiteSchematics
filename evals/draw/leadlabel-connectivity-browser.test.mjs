import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject, lockProject } from "@thermite/compiler";
import { renderSchematicPacket } from "../../packages/render/dist/sheets.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { parallelCircuitFixture } from "../../packages/render/test/circuit-fixture.ts";
import {
  displaySheet,
  drawingContextOptions,
  launch,
  openSheet,
  sheetMeasurementSource,
} from "./browser.mjs";
import { terminalLabelConductorFindings } from "./caption-mark-clearance.mjs";
import { auditCatalogRoles } from "./catalog-roles.mjs";
import { decodePng } from "./png-ink.mjs";

let browser, page;
const tempDirs = [];

beforeAll(async () => {
  browser = await launch();
  page = await (
    await browser.newContext({ ...drawingContextOptions, deviceScaleFactor: 4 })
  ).newPage();
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function buildRelayLibrary(rows, terminals) {
  const shared = Object.fromEntries(
    terminals.map((k) => [k, { connection_policy: "shared" }]),
  );
  const functions = Object.fromEntries(
    rows.map((r) => [
      r.key,
      { kind: "contact", normal_state: r.state, terminals: r.terminals },
    ]),
  );
  return {
    types: [
      {
        kind: "device_type",
        id: "synth:relay",
        symbol: "thermite:relay",
        terminals: shared,
        functions,
      },
      {
        kind: "device_type",
        id: "synth:load",
        symbol: "thermite:lamp",
        terminals: {
          X1: { connection_policy: "shared" },
          X2: { connection_policy: "shared" },
        },
        functions: { lamp: { kind: "load", terminals: ["X1", "X2"] } },
      },
    ],
  };
}

function buildRelaySource(commons, extras) {
  const uid = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const objects = [
    { kind: "device", uid: uid(1), designation: "R1", type: "synth:relay" },
  ];
  let nextUid = 10;
  for (const [ci, common] of commons.entries()) {
    for (let i = 0; i < extras + 1; i++) {
      const dev = `L${ci}_${i}`;
      objects.push({
        kind: "device",
        uid: uid(nextUid++),
        designation: dev,
        type: "synth:load",
      });
      objects.push({
        kind: "wire",
        uid: uid(nextUid++),
        designation: `W_${ci}_${i}`,
        endpoints: [
          { device: "R1", terminal: common },
          { device: dev, terminal: "X1" },
        ],
        properties: { label: `N${ci}` },
      });
    }
  }
  return { objects };
}

async function compileSynthRelay(rows, terminals, commons, extras) {
  const dir = await mkdtemp(join(tmpdir(), "leadlabel-r2-"));
  tempDirs.push(dir);
  const write = (rel, data) =>
    writeFile(join(dir, rel), JSON.stringify(data, null, 2));
  await mkdir(join(dir, "library"));
  await write("system.json", {
    format: "electrical-system/0.1",
    project: { name: "Synthetic leadlabel connectivity fixture" },
    sources: ["source.json"],
    libraries: [{ name: "synth", version: "0.1.0", path: "library" }],
  });
  await write("library/library.json", {
    name: "synth",
    version: "0.1.0",
    sources: ["types.json"],
  });
  await write("library/types.json", buildRelayLibrary(rows, terminals));
  await write("source.json", buildRelaySource(commons, extras));
  const locked = await lockProject(dir);
  expect(locked.ok).toBe(true);
  const compiled = await compileProject(dir);
  expect(compiled.ok).toBe(true);
  return compiled.ir;
}

function measurePaintedAttachments(options, h) {
  const c = { options: {}, h };
  h.prepareGeometry(c);
  h.prepareTerminals(c);
  h.prepareText(c);
  h.preparePaint(c);
  const { rr, sx, sy, contains, orders, occluders } = c;
  const termKeyOf = (el) => {
    const raw = el
      .closest?.("[data-terminal-attachment]")
      ?.getAttribute("data-terminal-attachment");
    return raw ? JSON.parse(raw)[1] : null;
  };
  const leads = [];
  for (const g of c.root.querySelectorAll("g[data-terminal-attachment]")) {
    const raw = g.getAttribute("data-terminal-attachment");
    const path = g.querySelector('path[data-electrical-role="terminal-lead"]');
    if (!raw || !path) continue;
    const [, termKey] = JSON.parse(raw);
    if (options.terms && !options.terms.includes(termKey)) continue;
    const m = path.getScreenCTM();
    if (!m) continue;
    const inv = m.inverse();
    const order = orders.get(path);
    const covers = occluders.filter((o) => o.order > order);
    const len = path.getTotalLength();
    const count = Math.max(2, Math.ceil(len / (options.stepMm ?? 0.05)));
    const samples = [];
    for (let i = 0; i <= count; i++) {
      const dist = (len * i) / count;
      const screen = path.getPointAtLength(dist).matrixTransform(m);
      const p = { x: (screen.x - rr.x) * sx, y: (screen.y - rr.y) * sy };
      const inStroke = path.isPointInStroke(screen.matrixTransform(inv));
      let top = null;
      for (const o of covers)
        if (h.occluderHit(o, p, screen, contains, "all")) top = o;
      const topKey = top ? termKeyOf(top.e) : null;
      const topIsDarkSameTerm = Boolean(
        top && !top.strokeBackground && !top.hasFill && topKey === termKey,
      );
      samples.push({
        dist,
        x: p.x,
        y: p.y,
        visible: inStroke && (!top || topIsDarkSameTerm),
      });
    }
    leads.push({ termKey, d: path.getAttribute("d"), length: len, samples });
  }
  return leads;
}

const PAINTED_ATTACHMENTS_SOURCE = sheetMeasurementSource(
  measurePaintedAttachments,
);

function minVisibleDistanceMm(leadsA, leadsB) {
  let best = Infinity;
  for (const a of leadsA) {
    for (const pa of a.samples) {
      if (!pa.visible) continue;
      for (const b of leadsB) {
        for (const pb of b.samples) {
          if (!pb.visible) continue;
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

function maxUnpaintedInteriorGapMm(lead, trimStartMm = 0.75) {
  let maxGap = 0;
  let gapStart = null;
  for (const s of lead.samples) {
    if (s.dist < trimStartMm || s.dist > lead.length - 0.05) continue;
    if (!s.visible) {
      gapStart ??= s.dist;
    } else if (gapStart !== null) {
      maxGap = Math.max(maxGap, s.dist - gapStart);
      gapStart = null;
    }
  }
  if (gapStart !== null)
    maxGap = Math.max(maxGap, lead.length - 0.05 - gapStart);
  return maxGap;
}

function rasterPixelsConnected(img, box, ptsA, ptsB) {
  const { width: w, height: h, rgba } = img;
  const dark = (x, y) => {
    const i = (y * w + x) * 4;
    return rgba[i] < 160 && rgba[i + 1] < 160 && rgba[i + 2] < 160;
  };
  const toPx = (q) => [
    Math.max(0, Math.min(w - 1, Math.round(((q.x - box.x) * w) / box.w))),
    Math.max(0, Math.min(h - 1, Math.round(((q.y - box.y) * h) / box.h))),
  ];
  const target = new Uint8Array(w * h);
  for (const q of ptsB) {
    const [px, py] = toPx(q);
    if (dark(px, py)) target[py * w + px] = 1;
  }
  const seen = new Uint8Array(w * h);
  const queue = [];
  for (const q of ptsA) {
    const [px, py] = toPx(q);
    const idx = py * w + px;
    if (dark(px, py) && !seen[idx]) {
      seen[idx] = 1;
      queue.push(idx);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (target[cur]) return true;
    const cx = cur % w,
      cy = (cur - cx) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = cx + dx,
        ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!seen[ni] && dark(nx, ny)) {
        seen[ni] = 1;
        queue.push(ni);
      }
    }
  }
  return false;
}

async function checkRasterNetJoin(p, netA, netB) {
  const ptsA = netA.flatMap((l) => l.samples.filter((s) => s.visible));
  const ptsB = netB.flatMap((l) => l.samples.filter((s) => s.visible));
  const all = [...ptsA, ...ptsB];
  const pad = 2;
  const x0 = Math.min(...all.map((q) => q.x)) - pad;
  const y0 = Math.min(...all.map((q) => q.y)) - pad;
  const x1 = Math.max(...all.map((q) => q.x)) + pad;
  const y1 = Math.max(...all.map((q) => q.y)) + pad;
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const clip = await p.evaluate((b) => {
    const e = document.querySelector("body>svg"),
      r = e.getBoundingClientRect(),
      v = e.viewBox.baseVal;
    return {
      x: r.x + scrollX + (b.x * r.width) / v.width,
      y: r.y + scrollY + (b.y * r.height) / v.height,
      width: (b.w * r.width) / v.width,
      height: (b.h * r.height) / v.height,
    };
  }, box);
  const bytes = await p.screenshot({
    clip,
    fullPage: true,
    scale: "device",
    timeout: 30000,
  });
  return rasterPixelsConnected(decodePng(bytes), box, ptsA, ptsB);
}

function compactLetterTtbRequest(title, id, rows, conductors) {
  return {
    format: "schematic-packet-request/0.1",
    page: { size: "letter", orientation: "landscape", marginMm: 10 },
    layout: "compact",
    index: false,
    views: [
      {
        format: "circuit-view-request/0.1",
        title,
        flow: "top-to-bottom",
        groups: [
          {
            id,
            functions: rows.map((r) => ({
              device: { by: "designation", value: "R1" },
              key: r.key,
            })),
            conductors,
          },
        ],
      },
    ],
  };
}

describe("LEADLABEL round-2 painted connectivity and continuity (#667)", () => {
  it("Finding A: alternating 111111/333333 commons on distinct nets (+12, compact letter, TTB) never touch in painted Chromium ink", async () => {
    const rows = [
      { key: "c1", state: "closed", terminals: ["111111", "12"] },
      { key: "c2", state: "open", terminals: ["333333", "14"] },
      { key: "c3", state: "closed", terminals: ["111111", "16"] },
      { key: "c4", state: "open", terminals: ["333333", "18"] },
    ];
    const ir = await compileSynthRelay(
      rows,
      ["111111", "333333", "12", "14", "16", "18"],
      ["111111", "333333"],
      12,
    );
    const r1 = ir.devices.find((d) => d.designation === "R1");
    const netOf = (tk) =>
      ir.indexes.netIdByTerminal.find(
        (e) => e.key.deviceUid === r1.uid && e.key.terminalKey === tk,
      )?.value;
    expect(netOf("111111")).toBeTruthy();
    expect(netOf("333333")).toBeTruthy();
    expect(netOf("111111")).not.toBe(netOf("333333"));

    const rendered = await renderSchematicPacket(
      ir,
      compactLetterTtbRequest(
        "Alternating distinct commons TTB",
        "alt-commons",
        rows,
        ["W_0_0", "W_1_0"],
      ),
    );
    expect(rendered.ok).toBe(true);
    expect(rendered.value.sheets).toHaveLength(1);
    const svg = embedPrintableFont(rendered.value.sheets[0].svg);
    const g = await openSheet(page, svg);
    expect(terminalLabelConductorFindings(g)).toEqual([]);

    await displaySheet(page, svg);
    const leads = await page.evaluate(
      ({ source, terms }) => (0, eval)(source)({ terms, stepMm: 0.04 }),
      { source: PAINTED_ATTACHMENTS_SOURCE, terms: ["111111", "333333"] },
    );
    const netA = leads.filter((l) => l.termKey === "111111");
    const netB = leads.filter((l) => l.termKey === "333333");
    expect(netA).toHaveLength(2);
    expect(netB).toHaveLength(2);
    expect(minVisibleDistanceMm(netA, netB)).toBeGreaterThanOrEqual(0.35);
    expect(await checkRasterNetJoin(page, netA, netB)).toBe(false);
  });

  it("Finding B: 4-contact shared terminal 111111 [+12] has unbroken painted continuity on every lead (no gap >= 0.1 mm)", async () => {
    const rows = [
      { key: "c1", state: "closed", terminals: ["111111", "12"] },
      { key: "c2", state: "open", terminals: ["111111", "14"] },
      { key: "c3", state: "closed", terminals: ["111111", "16"] },
      { key: "c4", state: "open", terminals: ["111111", "18"] },
    ];
    const ir = await compileSynthRelay(
      rows,
      ["111111", "12", "14", "16", "18"],
      ["111111"],
      12,
    );
    const rendered = await renderSchematicPacket(ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "landscape", marginMm: 10 },
      layout: "compact",
      index: false,
      views: [
        {
          format: "circuit-view-request/0.1",
          title: "Four-contact shared common TTB",
          flow: "top-to-bottom",
          groups: [
            {
              id: "four-common",
              functions: rows.map((r) => ({
                device: { by: "designation", value: "R1" },
                key: r.key,
              })),
              conductors: ["W_0_0"],
            },
          ],
        },
      ],
    });
    expect(rendered.ok).toBe(true);
    expect(rendered.value.sheets).toHaveLength(1);
    const svg = embedPrintableFont(rendered.value.sheets[0].svg);
    const g = await openSheet(page, svg);
    expect(terminalLabelConductorFindings(g)).toEqual([]);

    await displaySheet(page, svg);
    const leads = await page.evaluate(
      ({ source, terms }) => (0, eval)(source)({ terms, stepMm: 0.02 }),
      { source: PAINTED_ATTACHMENTS_SOURCE, terms: ["111111"] },
    );
    expect(leads).toHaveLength(4);
    for (const lead of leads) {
      const gap = maxUnpaintedInteriorGapMm(lead);
      expect(gap, `lead ${lead.d} had painted gap ${gap} mm`).toBeLessThan(0.1);
    }
    expect(auditCatalogRoles(g, ir).findings).toEqual([]);
  });

  it("Finding D: parallelCircuitFixture(true) keeps lateral and vertical cross-side routes clear of terminal labels and unbroken on the shared trunk", async () => {
    const fixture = await parallelCircuitFixture(true);
    try {
      for (const flow of ["left-to-right", "top-to-bottom"]) {
        const rendered = await renderSchematicPacket(fixture.ir, {
          format: "schematic-packet-request/0.1",
          page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
          layout: "standard",
          index: false,
          views: [
            {
              ...fixture.view,
              flow,
              groups: [
                {
                  id: "cross-common",
                  conductors: [],
                  functions: [
                    { device: { by: "designation", value: "K1" }, key: "no" },
                    { device: { by: "designation", value: "K1" }, key: "nc" },
                  ],
                },
              ],
            },
          ],
        });
        expect(rendered.ok).toBe(true);
        const svg = embedPrintableFont(rendered.value.sheets[0].svg);
        const g = await openSheet(page, svg);
        expect(terminalLabelConductorFindings(g), flow).toEqual([]);

        await displaySheet(page, svg);
        const leads = await page.evaluate(
          ({ source, terms }) => (0, eval)(source)({ terms, stepMm: 0.02 }),
          { source: PAINTED_ATTACHMENTS_SOURCE, terms: ["11", "14"] },
        );
        const term11 = leads.filter((l) => l.termKey === "11");
        const term14 = leads.filter((l) => l.termKey === "14");
        expect(term11).toHaveLength(2);
        expect(term14).toHaveLength(1);
        // Same-terminal trunk must not be notched by its own cross-side branch halo.
        const straight11 = term11.reduce((a, b) =>
          a.length <= b.length ? a : b,
        );
        expect(maxUnpaintedInteriorGapMm(straight11)).toBeLessThan(0.1);
        // Distinct nets 11 and 14 must never touch in painted Chromium ink.
        expect(minVisibleDistanceMm(term11, term14)).toBeGreaterThanOrEqual(
          0.35,
        );
        expect(await checkRasterNetJoin(page, term11, term14)).toBe(false);
      }
    } finally {
      await fixture.dispose();
    }
  });
});
