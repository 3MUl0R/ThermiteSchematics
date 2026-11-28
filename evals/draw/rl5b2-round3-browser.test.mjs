import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { PRINTABLE_SYMBOL_POLICY } from "../../packages/render/dist/symbols/printable-policy.js";
import {
  launch,
  drawingContextOptions,
  displaySheet,
  openSheet,
} from "./browser.mjs";
import { catalogRoleObservation } from "./catalog-roles.mjs";

let browser, context, page, motorIr, motorSheet, motorSvg, rm3Ir, dolIr;

const MOTOR_REQ = {
  format: "schematic-packet-request/0.1",
  index: false,
  page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
  views: [
    {
      format: "circuit-view-request/0.1",
      title: "Round-3 H1/H2 controls",
      flow: "left-to-right",
      groups: [
        {
          id: "ctrl",
          label: "Control",
          functions: [
            ["K1", "coil"],
            ["K1", "aux13"],
            ["PB1", "contact11"],
            ["OL1", "aux95"],
            ["CB1", "pole1"],
            ["CB1", "pole2"],
            ["CB1", "pole3"],
            ["M1", "motor_load"],
          ].map(([value, key]) => ({
            device: { by: "designation", value },
            key,
          })),
          conductors: [],
        },
      ],
    },
  ],
};

function runObs(g, ir, sheet = motorSheet) {
  return catalogRoleObservation(
    { id: "r3" },
    sheet,
    g,
    ir,
    (dq, issues, extra) => ({
      dq,
      status: issues.length ? "fail" : (extra.status ?? "pass"),
      ...extra,
    }),
  );
}

const uidByDesig = (ir) =>
  Object.fromEntries(ir.devices.map((d) => [d.designation, d.uid]));

async function plantUseInk(mode, pair, uid) {
  await displaySheet(page, motorSvg);
  return page.evaluate(
    ({ mode, pair, uid }) => {
      const root = document.querySelector("svg"),
        ns = root.namespaceURI;
      const term = (k) =>
        [...root.querySelectorAll("[data-terminal-marker]")].find(
          (e) =>
            e.getAttribute("data-device-uid") === uid.K1 &&
            e.getAttribute("data-terminal-key") === k,
        );
      const scr = (t) =>
        new DOMPoint(
          +t.getAttribute("cx"),
          +t.getAttribute("cy"),
        ).matrixTransform(t.getScreenCTM());
      const [p, q] = pair.map((k) =>
        scr(term(k)).matrixTransform(root.getScreenCTM().inverse()),
      );
      const add = (parent, tag, attrs) => {
        const el = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs))
          el.setAttribute(k, String(v));
        parent.append(el);
        return el;
      };
      const offset = mode === "defs-use-transform" ? 5 : 0;
      const def = add(root, "defs", {});
      add(def, "line", {
        id: "r3-short-def",
        stroke: "#17212b",
        "stroke-width": ".4",
        fill: "none",
        x1: p.x - offset,
        y1: p.y - offset,
        x2: q.x - offset,
        y2: q.y - offset,
      });
      add(root, "use", {
        href: "#r3-short-def",
        ...(offset ? { transform: `translate(${offset} ${offset})` } : {}),
      });
      return root.outerHTML;
    },
    { mode, pair, uid },
  );
}

const MODE_EXTRAS = {
  "low-opacity-ink": {
    "stroke-opacity": ".19",
    "stroke-width": "1.2",
    stroke: "#000000",
  },
  "zero-opacity": { opacity: 0 },
  "zero-stroke-opacity": { "stroke-opacity": 0 },
  "display-none": { display: "none" },
  "visibility-hidden": { visibility: "hidden" },
};

async function applyRegion(mode, uid, firstKey) {
  return page.evaluate(
    ({ mode, uid, firstKey }) => {
      const root = document.querySelector("svg"),
        ns = root.namespaceURI;
      const add = (parent, tag, attrs = {}) => {
        const el = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs))
          el.setAttribute(k, String(v));
        parent.append(el);
        return el;
      };
      const el = root.querySelector("#r3-planted-line");
      const term = [...root.querySelectorAll("[data-terminal-marker]")].find(
        (e) =>
          e.getAttribute("data-device-uid") === uid.K1 &&
          e.getAttribute("data-terminal-key") === firstKey,
      );
      const r = new DOMPoint(+term.getAttribute("cx"), +term.getAttribute("cy"))
        .matrixTransform(term.getScreenCTM())
        .matrixTransform(root.getScreenCTM().inverse());
      const isClip = mode.includes("clip");
      const reg = add(add(root, "defs"), isClip ? "clipPath" : "mask", {
        id: "r3-region",
        ...(isClip
          ? {}
          : {
              maskUnits: "userSpaceOnUse",
              x: -1000,
              y: -1000,
              width: 3000,
              height: 3000,
            }),
      });
      if (mode === "nonrect-clip-inside-group")
        add(reg, "circle", { cx: 0, cy: 0, r: 1000 });
      else if (mode === "clip-cutoff")
        add(reg, "rect", { x: r.x - 2, y: r.y - 2, width: 4, height: 4 });
      else
        add(reg, "rect", {
          x: -1000,
          y: -1000,
          width: 3000,
          height: 3000,
          fill: "white",
        });
      el.setAttribute(isClip ? "clip-path" : "mask", "url(#r3-region)");
      return root.outerHTML;
    },
    { mode, uid, firstKey },
  );
}

async function plantSheetInk(mode, pair = ["A1", "13"]) {
  const uid = uidByDesig(motorIr);
  if (mode === "defs-use-ink" || mode === "defs-use-transform")
    return plantUseInk(mode, pair, uid);
  await displaySheet(page, motorSvg);
  const svg = await page.evaluate(
    ({ mode, pair, uid, extras }) => {
      const root = document.querySelector("svg"),
        ns = root.namespaceURI;
      const add = (parent, tag, attrs = {}) => {
        const el = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs))
          el.setAttribute(k, String(v));
        parent.append(el);
        return el;
      };
      const term = (k) =>
        [...root.querySelectorAll("[data-terminal-marker]")].find(
          (e) =>
            e.getAttribute("data-device-uid") === uid.K1 &&
            e.getAttribute("data-terminal-key") === k,
        );
      const group = term(pair[0]).closest("[data-circuit-group]");
      const [a, b] = pair.map((k) => {
        const t = term(k);
        return new DOMPoint(
          +t.getAttribute("cx"),
          +t.getAttribute("cy"),
        ).matrixTransform(t.getScreenCTM());
      });
      const parent = [
        "root-ink",
        "clip-ink",
        "clip-cutoff",
        "mask-ink",
      ].includes(mode)
        ? root
        : mode === "sibling-ink"
          ? add(group.parentElement, "g")
          : group;
      const [p, q] = [a, b].map((t) =>
        t.matrixTransform(parent.getScreenCTM().inverse()),
      );
      add(parent, "line", {
        id: "r3-planted-line",
        stroke: "#17212b",
        "stroke-width": ".4",
        fill: "none",
        x1: p.x,
        y1: p.y,
        x2: q.x,
        y2: q.y,
        ...(extras ?? {}),
      });
      return root.outerHTML;
    },
    { mode, pair, uid, extras: MODE_EXTRAS[mode] },
  );
  return /clip|mask/u.test(mode) ? applyRegion(mode, uid, pair[0]) : svg;
}

async function plantEnclosureVariant(cleanSvg, mode) {
  await displaySheet(page, cleanSvg);
  return page.evaluate(
    ({ mode, policy }) => {
      const enc = document.querySelector("[data-source-enclosure]");
      const line = enc.querySelector("line[stroke-dasharray]");
      const uid = enc
        .closest("[data-device-uid]")
        .getAttribute("data-device-uid");
      const terms = [
        ...document.querySelectorAll("[data-terminal-marker]"),
      ].filter((t) => t.getAttribute("data-device-uid") === uid);
      const pt = (k) => {
        const t = terms.find((m) => m.getAttribute("data-terminal-key") === k);
        return new DOMPoint(+t.getAttribute("cx"), +t.getAttribute("cy"))
          .matrixTransform(t.getScreenCTM())
          .matrixTransform(line.getScreenCTM().inverse());
      };
      const a = pt("L1"),
        b = pt("L2");
      a.x -= 4;
      b.x -= 4;
      for (const [k, v] of Object.entries({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      }))
        line.setAttribute(k, String(v));
      line.removeAttribute("stroke-dasharray");
      const styles = {
        "near-grey": { stroke: "#667084" },
        "wide-grey": { stroke: policy.deviceOutlineColor, "stroke-width": "2" },
        opacity: {
          stroke: "#000000",
          "stroke-opacity": ".19",
          "stroke-width": "1.2",
        },
        "zero-gap": { "stroke-dasharray": "0.01 0" },
        "huge-dash": { "stroke-dasharray": "1000 .001" },
        "exact-solid-outline": {
          stroke: policy.deviceOutlineColor,
          "stroke-width": String(policy.deviceOutlineStrokeMm),
        },
        "exact-dashed-enclosure": {
          stroke: policy.color,
          "stroke-width": String(policy.enclosureStrokeMm),
          "stroke-dasharray": policy.enclosureDashMm.join(" "),
        },
      }[mode];
      for (const [k, v] of Object.entries(styles ?? {}))
        line.setAttribute(k, v);
      return document.querySelector("svg").outerHTML;
    },
    {
      mode,
      policy: {
        color: PRINTABLE_SYMBOL_POLICY.color,
        deviceOutlineColor: PRINTABLE_SYMBOL_POLICY.deviceOutlineColor,
        deviceOutlineStrokeMm: PRINTABLE_SYMBOL_POLICY.deviceOutlineStrokeMm,
        enclosureStrokeMm: PRINTABLE_SYMBOL_POLICY.enclosureStrokeMm,
        enclosureDashMm: [...PRINTABLE_SYMBOL_POLICY.enclosureDashMm],
      },
    },
  );
}

async function plantRootBridgeBetweenWires() {
  return page.evaluate(() => {
    const root = document.querySelector("svg"),
      ns = root.namespaceURI;
    const wires = [...root.querySelectorAll("[data-circuit-conductor]")]
      .map((g) => ({
        net: g.getAttribute("data-net-id"),
        path: [...g.querySelectorAll("path")].find(
          (p) => getComputedStyle(p).stroke !== "rgb(255, 255, 255)",
        ),
      }))
      .filter((w) => w.net && w.path);
    const first = wires[0];
    const second = wires.find((w) => w.net !== first.net);
    const mid = (p) =>
      p
        .getPointAtLength(p.getTotalLength() / 2)
        .matrixTransform(p.getScreenCTM())
        .matrixTransform(root.getScreenCTM().inverse());
    const a = mid(first.path),
      b = mid(second.path);
    const el = document.createElementNS(ns, "line");
    for (const [k, v] of Object.entries({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: "#17212b",
      "stroke-width": ".4",
    }))
      el.setAttribute(k, String(v));
    root.append(el);
    return root.outerHTML;
  });
}

async function plantSameNetRootLine(uid) {
  await displaySheet(page, motorSvg);
  return page.evaluate((uid) => {
    const root = document.querySelector("svg"),
      ns = root.namespaceURI;
    const term = (d, k) =>
      [...root.querySelectorAll("[data-terminal-marker]")].find(
        (e) =>
          e.getAttribute("data-device-uid") === uid[d] &&
          e.getAttribute("data-terminal-key") === k,
      );
    const pt = (t) =>
      new DOMPoint(+t.getAttribute("cx"), +t.getAttribute("cy"))
        .matrixTransform(t.getScreenCTM())
        .matrixTransform(root.getScreenCTM().inverse());
    const a = pt(term("OL1", "96")),
      b = pt(term("K1", "A1"));
    const el = document.createElementNS(ns, "line");
    for (const [k, v] of Object.entries({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: "#17212b",
      "stroke-width": ".4",
    }))
      el.setAttribute(k, String(v));
    root.append(el);
    return root.outerHTML;
  }, uid);
}

beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
  const [mRes, rRes, dRes] = await Promise.all([
    compileProject(join(process.cwd(), "examples/motor-starter")),
    compileProject(
      join(process.cwd(), "packages/core-library/test/fixtures/rm3"),
    ),
    compileProject(
      join(process.cwd(), "packages/core-library/test/fixtures/dol-starter"),
    ),
  ]);
  expect(mRes.ok && rRes.ok && dRes.ok).toBe(true);
  motorIr = mRes.ir;
  rm3Ir = rRes.ir;
  dolIr = dRes.ir;
  const rendered = await renderSchematicPacket(motorIr, MOTOR_REQ);
  expect(rendered.ok).toBe(true);
  motorSheet = rendered.value.sheets.find((s) =>
    s.svg.includes('data-circuit-mark="coil"'),
  );
  motorSvg = embedPrintableFont(motorSheet.svg);
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("RL5b-2 round-3 H1/H2/M3 failing-first regressions & positive controls (#646)", () => {
  it("H1: sheet-root, sibling-group, defs/use (including transformed), rect-clipped, and low-opacity ink joining independent nets FAIL", async () => {
    for (const mode of [
      "inside-control",
      "root-ink",
      "sibling-ink",
      "defs-use-ink",
      "defs-use-transform",
      "clip-ink",
      "low-opacity-ink",
    ]) {
      const svg = await plantSheetInk(mode);
      const obs = runObs(await openSheet(page, svg), motorIr);
      expect(obs.status, mode).toBe("fail");
      expect(
        obs.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        mode,
      ).toBe(true);
    }
  });

  it("H1: masks and non-rectangular clip-paths fail closed as not-measured (never PASS); rect clip cutting off second terminal PASSES", async () => {
    for (const mode of [
      "mask-ink",
      "mask-inside-group",
      "nonrect-clip-inside-group",
    ]) {
      const svg = await plantSheetInk(mode);
      const obs = runObs(await openSheet(page, svg), motorIr);
      expect(["not-measured", "fail"], mode).toContain(obs.status);
      expect(obs.status, mode).not.toBe("pass");
    }
    const cutoffSvg = await plantSheetInk("clip-cutoff");
    const cutoffObs = runObs(await openSheet(page, cutoffSvg), motorIr);
    expect(cutoffObs.status).toBe("pass");
  });

  it("H1: legitimate circuit wires PASS; sheet-root ink bridging two independent native wires FAILS", async () => {
    const fRes = await compileProject(
      join(process.cwd(), "examples/functional-symbols"),
    );
    expect(fRes.ok).toBe(true);
    const fReq = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          "examples/functional-symbols/packet-left-to-right.request.json",
        ),
        "utf8",
      ),
    );
    const rendered = await renderSchematicPacket(fRes.ir, fReq);
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets.find((s) =>
      s.svg.includes("data-circuit-conductor="),
    );
    const cleanSvg = embedPrintableFont(sheet.svg);
    expect(runObs(await openSheet(page, cleanSvg), fRes.ir, sheet).status).toBe(
      "pass",
    );
    const bridgedSvg = await plantRootBridgeBetweenWires();
    expect(
      runObs(await openSheet(page, bridgedSvg), fRes.ir, sheet).status,
    ).toBe("fail");
  });

  it("H2: enclosure exemption rejects near-grey, wide-grey, low-opacity, zero-gap, and huge-dash joins; exact renderer styles PASS", async () => {
    const req = {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
      views: [
        {
          format: "circuit-view-request/0.1",
          title: "Source enclosure audit",
          flow: "left-to-right",
          groups: [
            {
              id: "src",
              label: "Supply",
              functions: [
                {
                  device: { by: "designation", value: "SRC1" },
                  key: "three_phase_source",
                },
              ],
              conductors: [],
            },
          ],
        },
      ],
    };
    const rendered = await renderSchematicPacket(rm3Ir, req);
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    const cleanSvg = embedPrintableFont(sheet.svg);
    expect(runObs(await openSheet(page, cleanSvg), rm3Ir, sheet).status).toBe(
      "pass",
    );
    for (const mode of [
      "near-grey",
      "wide-grey",
      "opacity",
      "zero-gap",
      "huge-dash",
    ]) {
      const svg = await plantEnclosureVariant(cleanSvg, mode);
      expect(
        runObs(await openSheet(page, svg), rm3Ir, sheet).status,
        mode,
      ).toBe("fail");
    }
    for (const okMode of ["exact-solid-outline", "exact-dashed-enclosure"]) {
      const svg = await plantEnclosureVariant(cleanSvg, okMode);
      expect(
        runObs(await openSheet(page, svg), rm3Ir, sheet).status,
        okMode,
      ).toBe("pass");
    }
  });

  it("positive controls: zero-opacity, display:none, visibility:hidden, same-native-net root ink, and changeover common-11 PASS", async () => {
    for (const hidden of [
      "zero-opacity",
      "zero-stroke-opacity",
      "display-none",
      "visibility-hidden",
    ]) {
      const svg = await plantSheetInk(hidden);
      expect(runObs(await openSheet(page, svg), motorIr).status, hidden).toBe(
        "pass",
      );
    }
    const sameNetRootSvg = await plantSameNetRootLine(uidByDesig(motorIr));
    expect(runObs(await openSheet(page, sameNetRootSvg), motorIr).status).toBe(
      "pass",
    );
    const coReq = {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
      views: [
        {
          format: "circuit-view-request/0.1",
          title: "Changeover common 11",
          flow: "left-to-right",
          groups: [
            {
              id: "co",
              label: "Relay",
              functions: [
                {
                  device: { by: "designation", value: "R1" },
                  key: "contact12",
                },
                {
                  device: { by: "designation", value: "R1" },
                  key: "contact14",
                },
              ],
              conductors: [],
            },
          ],
        },
      ],
    };
    const coRes = await renderSchematicPacket(dolIr, coReq);
    expect(coRes.ok).toBe(true);
    const coSheet = coRes.value.sheets[0];
    expect(
      runObs(
        await openSheet(page, embedPrintableFont(coSheet.svg)),
        dolIr,
        coSheet,
      ).status,
    ).toBe("pass");
  });
});
