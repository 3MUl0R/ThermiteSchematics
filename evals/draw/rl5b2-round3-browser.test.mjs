import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { PRINTABLE_SYMBOL_POLICY } from "../../packages/render/dist/symbols/printable-policy.js";
import { displaySheet, launch, openSheet } from "./browser.mjs";
import {
  createPageRunner,
  MOTOR_AUDIT_FUNCTIONS,
  obsDiagnostic,
  runCatalogRoleObs,
  singleGroupReq,
  uidByDesignation,
} from "./test-support/rl5b2-browser.mjs";

let browser, motorIr, motorSheet, motorSvg;
let functionalIr, functionalSheet, functionalSvg;
let rm3Ir, rm3Sheet, rm3Svg;
let dolIr, dolSheet, dolSvg;
const { withPage, closeActiveContexts } = createPageRunner(() => browser);

const runObs = (g, ir, sheet = motorSheet) =>
  runCatalogRoleObs("r3", g, ir, sheet);

async function plantUseInk(page, mode, pair, uid) {
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

async function applyRegion(page, mode, uid, firstKey) {
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

async function plantSheetInk(page, mode, pair = ["A1", "13"]) {
  const uid = uidByDesignation(motorIr);
  if (mode === "defs-use-ink" || mode === "defs-use-transform")
    return plantUseInk(page, mode, pair, uid);
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
  return /clip|mask/u.test(mode) ? applyRegion(page, mode, uid, pair[0]) : svg;
}

async function plantEnclosureVariant(page, cleanSvg, mode) {
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

async function plantRootBridgeBetweenWires(page, cleanSvg) {
  await displaySheet(page, cleanSvg);
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

async function plantSameNetRootLine(page, uid) {
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
  const [mRes, fRes, rRes, dRes, fReqRaw] = await Promise.all([
    compileProject(join(process.cwd(), "examples/motor-starter")),
    compileProject(join(process.cwd(), "examples/functional-symbols")),
    compileProject(
      join(process.cwd(), "packages/core-library/test/fixtures/rm3"),
    ),
    compileProject(
      join(process.cwd(), "packages/core-library/test/fixtures/dol-starter"),
    ),
    readFile(
      join(
        process.cwd(),
        "examples/functional-symbols/packet-left-to-right.request.json",
      ),
      "utf8",
    ),
  ]);
  expect(mRes.ok && fRes.ok && rRes.ok && dRes.ok).toBe(true);
  motorIr = mRes.ir;
  functionalIr = fRes.ir;
  rm3Ir = rRes.ir;
  dolIr = dRes.ir;
  const [mRendered, fRendered, rRendered, dRendered] = await Promise.all([
    renderSchematicPacket(
      motorIr,
      singleGroupReq(
        "Round-3 H1/H2 controls",
        "ctrl",
        "Control",
        MOTOR_AUDIT_FUNCTIONS,
      ),
    ),
    renderSchematicPacket(functionalIr, JSON.parse(fReqRaw)),
    renderSchematicPacket(
      rm3Ir,
      singleGroupReq("Source enclosure audit", "src", "Supply", [
        {
          device: { by: "designation", value: "SRC1" },
          key: "three_phase_source",
        },
      ]),
    ),
    renderSchematicPacket(
      dolIr,
      singleGroupReq("Changeover common 11", "co", "Relay", [
        { device: { by: "designation", value: "R1" }, key: "contact12" },
        { device: { by: "designation", value: "R1" }, key: "contact14" },
      ]),
    ),
  ]);
  expect(mRendered.ok && fRendered.ok && rRendered.ok && dRendered.ok).toBe(
    true,
  );
  motorSheet = mRendered.value.sheets.find((s) =>
    s.svg.includes('data-circuit-mark="coil"'),
  );
  motorSvg = embedPrintableFont(motorSheet.svg);
  functionalSheet = fRendered.value.sheets.find((s) =>
    s.svg.includes("data-circuit-conductor="),
  );
  functionalSvg = embedPrintableFont(functionalSheet.svg);
  rm3Sheet = rRendered.value.sheets[0];
  rm3Svg = embedPrintableFont(rm3Sheet.svg);
  dolSheet = dRendered.value.sheets[0];
  dolSvg = embedPrintableFont(dolSheet.svg);
});

afterEach(closeActiveContexts);

afterAll(async () => {
  await browser?.close();
});

describe("RL5b-2 round-3 H1/H2/M3 failing-first regressions & positive controls (#646)", () => {
  it.each([
    "inside-control",
    "root-ink",
    "sibling-ink",
    "defs-use-ink",
    "defs-use-transform",
    "clip-ink",
    "low-opacity-ink",
  ])("H1: planted %s joining independent nets FAILS", async (mode) => {
    await withPage(async (page) => {
      const svg = await plantSheetInk(page, mode);
      const obs = runObs(await openSheet(page, svg), motorIr);
      expect(obs.status, obsDiagnostic(obs, mode)).toBe("fail");
      expect(
        obs.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(obs, mode),
      ).toBe(true);
    });
  });

  it.each(["mask-ink", "mask-inside-group", "nonrect-clip-inside-group"])(
    "H1: %s fails closed as not-measured (never PASS)",
    async (mode) => {
      await withPage(async (page) => {
        const svg = await plantSheetInk(page, mode);
        const obs = runObs(await openSheet(page, svg), motorIr);
        expect(["not-measured", "fail"], obsDiagnostic(obs, mode)).toContain(
          obs.status,
        );
        expect(obs.status, obsDiagnostic(obs, mode)).not.toBe("pass");
      });
    },
  );

  it("H1: rect clip cutting off second terminal PASSES", async () => {
    await withPage(async (page) => {
      const cutoffSvg = await plantSheetInk(page, "clip-cutoff");
      const cutoffObs = runObs(await openSheet(page, cutoffSvg), motorIr);
      expect(cutoffObs.status, obsDiagnostic(cutoffObs, "clip-cutoff")).toBe(
        "pass",
      );
    });
  });

  it("H1: legitimate circuit wires PASS", async () => {
    await withPage(async (page) => {
      const obs = runObs(
        await openSheet(page, functionalSvg),
        functionalIr,
        functionalSheet,
      );
      expect(obs.status, obsDiagnostic(obs, "functional-wires-clean")).toBe(
        "pass",
      );
    });
  });

  it("H1: sheet-root ink bridging two independent native wires FAILS", async () => {
    await withPage(async (page) => {
      const bridgedSvg = await plantRootBridgeBetweenWires(page, functionalSvg);
      const obs = runObs(
        await openSheet(page, bridgedSvg),
        functionalIr,
        functionalSheet,
      );
      expect(obs.status, obsDiagnostic(obs, "functional-wires-bridged")).toBe(
        "fail",
      );
    });
  });

  it("H2: clean source enclosure PASSES", async () => {
    await withPage(async (page) => {
      const obs = runObs(await openSheet(page, rm3Svg), rm3Ir, rm3Sheet);
      expect(obs.status, obsDiagnostic(obs, "enclosure-clean")).toBe("pass");
    });
  });

  it.each(["near-grey", "wide-grey", "opacity", "zero-gap", "huge-dash"])(
    "H2: enclosure exemption rejects %s join",
    async (mode) => {
      await withPage(async (page) => {
        const svg = await plantEnclosureVariant(page, rm3Svg, mode);
        const obs = runObs(await openSheet(page, svg), rm3Ir, rm3Sheet);
        expect(obs.status, obsDiagnostic(obs, mode)).toBe("fail");
      });
    },
  );

  it.each(["exact-solid-outline", "exact-dashed-enclosure"])(
    "H2: enclosure exemption accepts exact renderer style %s",
    async (okMode) => {
      await withPage(async (page) => {
        const svg = await plantEnclosureVariant(page, rm3Svg, okMode);
        const obs = runObs(await openSheet(page, svg), rm3Ir, rm3Sheet);
        expect(obs.status, obsDiagnostic(obs, okMode)).toBe("pass");
      });
    },
  );

  it.each([
    "zero-opacity",
    "zero-stroke-opacity",
    "display-none",
    "visibility-hidden",
  ])("positive control: %s planted ink PASSES", async (hidden) => {
    await withPage(async (page) => {
      const svg = await plantSheetInk(page, hidden);
      const obs = runObs(await openSheet(page, svg), motorIr);
      expect(obs.status, obsDiagnostic(obs, hidden)).toBe("pass");
    });
  });

  it("positive control: same-native-net root ink PASSES", async () => {
    await withPage(async (page) => {
      const sameNetRootSvg = await plantSameNetRootLine(
        page,
        uidByDesignation(motorIr),
      );
      const obs = runObs(await openSheet(page, sameNetRootSvg), motorIr);
      expect(obs.status, obsDiagnostic(obs, "same-net-root")).toBe("pass");
    });
  });

  it("positive control: changeover common-11 PASSES", async () => {
    await withPage(async (page) => {
      const obs = runObs(await openSheet(page, dolSvg), dolIr, dolSheet);
      expect(obs.status, obsDiagnostic(obs, "changeover-common-11")).toBe(
        "pass",
      );
    });
  });
});
