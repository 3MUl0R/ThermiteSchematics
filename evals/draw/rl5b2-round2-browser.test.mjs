import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { PRINTABLE_SYMBOL_POLICY } from "../../packages/render/dist/symbols/printable-policy.js";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { catalogRoleObservation } from "./catalog-roles.mjs";

let browser, context, page, motorIr, motorSheet, motorSvg, dolIr, rm3Ir;

const MOTOR_REQ = {
  format: "schematic-packet-request/0.1",
  index: false,
  page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
  views: [
    {
      format: "circuit-view-request/0.1",
      title: "Audit controls",
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

function singleGroupReq(title, id, label, functions) {
  return {
    format: "schematic-packet-request/0.1",
    index: false,
    page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
    views: [
      {
        format: "circuit-view-request/0.1",
        title,
        flow: "left-to-right",
        groups: [{ id, label, functions, conductors: [] }],
      },
    ],
  };
}

function runCatalogObs(g, ir, sheet = motorSheet) {
  return catalogRoleObservation(
    { id: "audit" },
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

const uidByDesignation = (ir) =>
  Object.fromEntries(ir.devices.map((d) => [d.designation, d.uid]));

async function plantBridgeChain() {
  await openSheet(page, motorSvg);
  const uid = uidByDesignation(motorIr);
  return page.evaluate((uid) => {
    const root = document.querySelector("svg");
    const sel = (d, k, r) =>
      [...root.querySelectorAll("[data-function-id]")]
        .find(
          (e) =>
            e.getAttribute("data-function-id") === JSON.stringify([uid[d], k]),
        )
        ?.querySelector(`[data-circuit-mark] [data-electrical-role="${r}"]`);
    const a = sel("K1", "coil", "coil-body");
    const b = sel("OL1", "aux95", "contact-path");
    const el = root.querySelector('[data-mechanical-association="ganged"]');
    el.removeAttribute("stroke-dasharray");
    const p = new DOMPoint(
      +a.getAttribute("x") + +a.getAttribute("width") / 2,
      +a.getAttribute("y"),
    )
      .matrixTransform(a.getScreenCTM())
      .matrixTransform(el.getScreenCTM().inverse());
    const q = new DOMPoint(+b.getAttribute("x1"), +b.getAttribute("y1"))
      .matrixTransform(b.getScreenCTM())
      .matrixTransform(el.getScreenCTM().inverse());
    for (const [k, v] of Object.entries({
      x1: p.x,
      y1: p.y,
      x2: q.x,
      y2: q.y,
    }))
      el.setAttribute(k, String(v));
    return root.outerHTML;
  }, uid);
}

async function mutateMotorRole(mode) {
  await openSheet(page, motorSvg);
  const uid = uidByDesignation(motorIr);
  return page.evaluate(
    ({ mode, uid }) => {
      const root = document.querySelector("svg");
      const fn = [...root.querySelectorAll("[data-function-id]")].find(
        (e) =>
          e.getAttribute("data-function-id") ===
          JSON.stringify([uid.K1, "aux13"]),
      );
      const m = fn.querySelector("[data-circuit-mark]");
      if (mode === "forged-allowed-role") {
        m.querySelector('[data-electrical-role="terminal-lead"]').setAttribute(
          "data-electrical-role",
          "contact-blade",
        );
      } else if (mode === "forged-blade-as-lead") {
        m.querySelector('[data-electrical-role="contact-blade"]').setAttribute(
          "data-electrical-role",
          "terminal-lead",
        );
      } else if (mode === "forged-mark-and-role") {
        m.setAttribute("data-circuit-mark", "overload");
        for (const e of m.querySelectorAll("line"))
          e.setAttribute("data-electrical-role", "terminal-lead");
        const rect = document.createElementNS(root.namespaceURI, "rect");
        m.append(rect);
        for (const [k, v] of Object.entries({
          "data-electrical-role": "element-body",
          x: 4.2,
          y: 4.5,
          width: 3.6,
          height: 3,
        }))
          rect.setAttribute(k, v);
      } else if (mode === "uncomputable-mark") {
        fn.setAttribute(
          "data-function-id",
          JSON.stringify([uid.K1, "nonexistent_fn"]),
        );
      }
      return root.outerHTML;
    },
    { mode, uid },
  );
}

async function addMotorLine(parentSel, role, from, to, attrs = {}) {
  await openSheet(page, motorSvg);
  const uid = uidByDesignation(motorIr);
  return page.evaluate(
    ({ parentSel, role, from, to, attrs, uid }) => {
      const root = document.querySelector("svg");
      const k1Coil = [...root.querySelectorAll("[data-function-id]")].find(
        (e) =>
          e.getAttribute("data-function-id") ===
          JSON.stringify([uid.K1, "coil"]),
      );
      const parent = k1Coil.closest(parentSel);
      const e = document.createElementNS(root.namespaceURI, "line");
      parent.append(e);
      if (role !== null) e.setAttribute("data-electrical-role", role);
      e.setAttribute("stroke", "#17212b");
      e.setAttribute("stroke-width", ".35");
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      const pt = (spec) => {
        if (!Array.isArray(spec)) return spec;
        const t = [...root.querySelectorAll("[data-terminal-marker]")].find(
          (x) =>
            x.getAttribute("data-device-uid") === uid[spec[0]] &&
            x.getAttribute("data-terminal-key") === spec[1],
        );
        return new DOMPoint(+t.getAttribute("cx"), +t.getAttribute("cy"))
          .matrixTransform(t.getScreenCTM())
          .matrixTransform(e.getScreenCTM().inverse());
      };
      const a = pt(from),
        b = pt(to);
      for (const [k, v] of Object.entries({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      }))
        e.setAttribute(k, String(v));
      return root.outerHTML;
    },
    { parentSel, role, from, to, attrs, uid },
  );
}

async function mutateSourceEnclosure(grey) {
  return page.evaluate((grey) => {
    const root = document.querySelector("svg");
    const enc = root.querySelector("[data-source-enclosure]");
    const line = enc.querySelector("line[stroke-dasharray]");
    const uid = enc
      .closest("[data-device-uid]")
      .getAttribute("data-device-uid");
    const pt = (k) => {
      const t = [...root.querySelectorAll("[data-terminal-marker]")].find(
        (m) =>
          m.getAttribute("data-device-uid") === uid &&
          m.getAttribute("data-terminal-key") === k,
      );
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
    const solidDarkSvg = root.outerHTML;
    line.setAttribute("stroke", grey);
    return { solidDarkSvg, solidGreySvg: root.outerHTML };
  }, grey);
}

async function extendChangeoverTo14(cleanSvg, uid) {
  await openSheet(page, cleanSvg);
  return page.evaluate((uid) => {
    const fn = [...document.querySelectorAll("[data-function-id]")].find(
      (g) =>
        g.getAttribute("data-function-id") ===
        JSON.stringify([uid, "contact12"]),
    );
    const stroke = fn.querySelector('[data-electrical-role="contact-path"]');
    const t14 = [...document.querySelectorAll("[data-terminal-marker]")].find(
      (t) =>
        t.getAttribute("data-device-uid") === uid &&
        t.getAttribute("data-terminal-key") === "14",
    );
    const p = new DOMPoint(+t14.getAttribute("cx"), +t14.getAttribute("cy"))
      .matrixTransform(t14.getScreenCTM())
      .matrixTransform(stroke.getScreenCTM().inverse());
    stroke.setAttribute("x2", String(p.x));
    stroke.setAttribute("y2", String(p.y));
    return document.querySelector("svg").outerHTML;
  }, uid);
}

beforeAll(async () => {
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
  const [mRes, dRes, rRes] = await Promise.all([
    compileProject(join(process.cwd(), "examples/motor-starter")),
    compileProject(
      join(process.cwd(), "packages/core-library/test/fixtures/dol-starter"),
    ),
    compileProject(
      join(process.cwd(), "packages/core-library/test/fixtures/rm3"),
    ),
  ]);
  expect(mRes.ok && dRes.ok && rRes.ok).toBe(true);
  motorIr = mRes.ir;
  dolIr = dRes.ir;
  rm3Ir = rRes.ir;
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

describe("RL5b-2 round-2 failing-first reproductions (H1-H4 + controls, #646)", () => {
  it("H1: indirect bridge-chain via solid gang stroke connecting K1 coil-body and OL1 contact-path FAILS", async () => {
    const o = runCatalogObs(
      await openSheet(page, await plantBridgeChain()),
      motorIr,
    );
    expect(o.status).toBe("fail");
    expect(
      o.evidence?.findings?.some(
        (f) => f.kind === "symbol-primitive-joins-independent-nets",
      ),
    ).toBe(true);
  });

  it("H2: relabeling genuine K1/aux13 terminal-lead as contact-blade (and blade as lead) FAILS", async () => {
    const o1 = runCatalogObs(
      await openSheet(page, await mutateMotorRole("forged-allowed-role")),
      motorIr,
    );
    expect(o1.status).toBe("fail");
    expect(
      o1.evidence?.findings?.some((f) => f.kind === "forged-electrical-role"),
    ).toBe(true);

    const o2 = runCatalogObs(
      await openSheet(page, await mutateMotorRole("forged-blade-as-lead")),
      motorIr,
    );
    expect(o2.status).toBe("fail");
    expect(
      o2.evidence?.findings?.some((f) => f.kind === "forged-electrical-role"),
    ).toBe(true);
  });

  it("H2: forging K1/aux13 mark to overload with element-body across NO gap FAILS both role and connectivity", async () => {
    const o = runCatalogObs(
      await openSheet(page, await mutateMotorRole("forged-mark-and-role")),
      motorIr,
    );
    expect(o.status).toBe("fail");
    const kinds = new Set((o.evidence?.findings ?? []).map((f) => f.kind));
    expect(kinds.has("forged-electrical-role")).toBe(true);
    expect(kinds.has("symbol-primitive-joins-independent-nets")).toBe(true);
  });

  it("H2: uncomputable native mark expectation yields not-measured, never PASS", async () => {
    const o = runCatalogObs(
      await openSheet(page, await mutateMotorRole("uncomputable-mark")),
      motorIr,
    );
    expect(o.status).not.toBe("pass");
    expect(["not-measured", "fail"]).toContain(o.status);
  });

  it("H3: unowned painted stroke directly inside circuit group FAILS on net-join and yields not-measured when isolated", async () => {
    const shortSvg = await addMotorLine(
      "[data-circuit-group]",
      null,
      ["K1", "A1"],
      ["K1", "13"],
    );
    const oShort = runCatalogObs(await openSheet(page, shortSvg), motorIr);
    expect(oShort.status).toBe("fail");
    expect(
      oShort.evidence?.findings?.some(
        (f) => f.kind === "symbol-primitive-joins-independent-nets",
      ),
    ).toBe(true);
    expect(
      oShort.evidence?.notMeasured?.some(
        (m) => m.reason === "missing-electrical-role",
      ),
    ).toBe(true);

    const isoSvg = await addMotorLine(
      "[data-circuit-group]",
      null,
      { x: 2, y: 2 },
      { x: 5, y: 2 },
    );
    const oIso = runCatalogObs(await openSheet(page, isoSvg), motorIr);
    expect(oIso.status).toBe("not-measured");
    expect(
      oIso.evidence?.notMeasured?.some(
        (m) => m.reason === "missing-electrical-role",
      ),
    ).toBe(true);
  });

  it("H4: solid dark source-enclosure stroke crossing L1 and L2 FAILS; dashed or enclosure-grey stays exempt", async () => {
    const req = singleGroupReq("Source enclosure audit", "src", "Supply", [
      {
        device: { by: "designation", value: "SRC1" },
        key: "three_phase_source",
      },
    ]);
    const rendered = await renderSchematicPacket(rm3Ir, req);
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    const cleanSvg = embedPrintableFont(sheet.svg);
    expect(
      runCatalogObs(await openSheet(page, cleanSvg), rm3Ir, sheet).status,
    ).toBe("pass");
    const { solidDarkSvg, solidGreySvg } = await mutateSourceEnclosure(
      PRINTABLE_SYMBOL_POLICY.deviceOutlineColor,
    );
    const darkObs = runCatalogObs(
      await openSheet(page, solidDarkSvg),
      rm3Ir,
      sheet,
    );
    expect(darkObs.status).toBe("fail");
    expect(
      darkObs.evidence?.findings?.some(
        (f) => f.kind === "symbol-primitive-joins-independent-nets",
      ),
    ).toBe(true);
    expect(
      runCatalogObs(await openSheet(page, solidGreySvg), rm3Ir, sheet).status,
    ).toBe("pass");
  });

  it("positive controls: changeover shared common 11 and same-net join PASS; stripped/extended/diff-net FAIL", async () => {
    const req = singleGroupReq("Changeover common 11", "co", "Relay", [
      { device: { by: "designation", value: "R1" }, key: "contact12" },
      { device: { by: "designation", value: "R1" }, key: "contact14" },
    ]);
    const rendered = await renderSchematicPacket(dolIr, req);
    expect(rendered.ok).toBe(true);
    const sheet = rendered.value.sheets[0];
    const cleanSvg = embedPrintableFont(sheet.svg);
    const r1Uid = dolIr.devices.find((d) => d.designation === "R1").uid;

    expect(
      runCatalogObs(await openSheet(page, cleanSvg), dolIr, sheet).status,
    ).toBe("pass");
    const stripped = cleanSvg.replace(/ data-electrical-role="[^"]*"/gu, "");
    expect(
      runCatalogObs(await openSheet(page, stripped), dolIr, sheet).status,
    ).toBe("fail");
    const extSvg = await extendChangeoverTo14(cleanSvg, r1Uid);
    expect(
      runCatalogObs(await openSheet(page, extSvg), dolIr, sheet).status,
    ).toBe("fail");

    const sameSvg = await addMotorLine(
      "[data-circuit-functions]",
      "mechanical-operator",
      ["OL1", "96"],
      ["K1", "A1"],
      { "data-mechanical-association": "ganged" },
    );
    expect(runCatalogObs(await openSheet(page, sameSvg), motorIr).status).toBe(
      "pass",
    );
    const diffSvg = await addMotorLine(
      "[data-circuit-functions]",
      "mechanical-operator",
      ["K1", "A1"],
      ["K1", "13"],
      { "data-mechanical-association": "ganged" },
    );
    expect(runCatalogObs(await openSheet(page, diffSvg), motorIr).status).toBe(
      "fail",
    );
  });
});
