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
let dolIr, dolSheet, dolSvg, r1Uid;
let rm3Ir, rm3Sheet, rm3Svg;
const { withPage, closeActiveContexts } = createPageRunner(() => browser);

const runCatalogObs = (g, ir, sheet = motorSheet) =>
  runCatalogRoleObs("audit", g, ir, sheet);

async function plantBridgeChain(page) {
  await displaySheet(page, motorSvg);
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

async function mutateMotorRole(page, mode) {
  await displaySheet(page, motorSvg);
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

async function addMotorLine(page, parentSel, role, from, to, attrs = {}) {
  await displaySheet(page, motorSvg);
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

async function mutateSourceEnclosure(page, variant) {
  await displaySheet(page, rm3Svg);
  return page.evaluate(
    ({ variant, grey, outlineWidth }) => {
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
      if (variant === "solid-grey") {
        line.setAttribute("stroke", grey);
        line.setAttribute("stroke-width", String(outlineWidth));
      }
      return root.outerHTML;
    },
    {
      variant,
      grey: PRINTABLE_SYMBOL_POLICY.deviceOutlineColor,
      outlineWidth: PRINTABLE_SYMBOL_POLICY.deviceOutlineStrokeMm,
    },
  );
}

async function extendChangeoverTo14(page, cleanSvg, uid) {
  await displaySheet(page, cleanSvg);
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
  const [mRendered, rRendered, dRendered] = await Promise.all([
    renderSchematicPacket(
      motorIr,
      singleGroupReq(
        "Audit controls",
        "ctrl",
        "Control",
        MOTOR_AUDIT_FUNCTIONS,
      ),
    ),
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
  expect(mRendered.ok && rRendered.ok && dRendered.ok).toBe(true);
  motorSheet = mRendered.value.sheets.find((s) =>
    s.svg.includes('data-circuit-mark="coil"'),
  );
  motorSvg = embedPrintableFont(motorSheet.svg);
  rm3Sheet = rRendered.value.sheets[0];
  rm3Svg = embedPrintableFont(rm3Sheet.svg);
  dolSheet = dRendered.value.sheets[0];
  dolSvg = embedPrintableFont(dolSheet.svg);
  r1Uid = dolIr.devices.find((d) => d.designation === "R1").uid;
});

afterEach(closeActiveContexts);

afterAll(async () => {
  await browser?.close();
});

describe("RL5b-2 round-2 failing-first reproductions (H1-H4 + controls, #646)", () => {
  it("H1: indirect bridge-chain via solid gang stroke connecting K1 coil-body and OL1 contact-path FAILS", async () => {
    await withPage(async (page) => {
      const o = runCatalogObs(
        await openSheet(page, await plantBridgeChain(page)),
        motorIr,
      );
      expect(o.status, obsDiagnostic(o, "H1-bridge-chain")).toBe("fail");
      expect(
        o.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(o, "H1-bridge-chain"),
      ).toBe(true);
    });
  });

  it.each(["forged-allowed-role", "forged-blade-as-lead"])(
    "H2: relabeling genuine K1/aux13 role (%s) FAILS",
    async (mode) => {
      await withPage(async (page) => {
        const o = runCatalogObs(
          await openSheet(page, await mutateMotorRole(page, mode)),
          motorIr,
        );
        expect(o.status, obsDiagnostic(o, mode)).toBe("fail");
        expect(
          o.evidence?.findings?.some(
            (f) => f.kind === "forged-electrical-role",
          ),
          obsDiagnostic(o, mode),
        ).toBe(true);
      });
    },
  );

  it("H2: forging K1/aux13 mark to overload with element-body across NO gap FAILS both role and connectivity", async () => {
    await withPage(async (page) => {
      const o = runCatalogObs(
        await openSheet(
          page,
          await mutateMotorRole(page, "forged-mark-and-role"),
        ),
        motorIr,
      );
      expect(o.status, obsDiagnostic(o, "forged-mark-and-role")).toBe("fail");
      const kinds = new Set((o.evidence?.findings ?? []).map((f) => f.kind));
      expect(
        kinds.has("forged-electrical-role"),
        obsDiagnostic(o, "forged-mark-and-role"),
      ).toBe(true);
      expect(
        kinds.has("symbol-primitive-joins-independent-nets"),
        obsDiagnostic(o, "forged-mark-and-role"),
      ).toBe(true);
    });
  });

  it("H2: uncomputable native mark expectation yields not-measured, never PASS", async () => {
    await withPage(async (page) => {
      const o = runCatalogObs(
        await openSheet(page, await mutateMotorRole(page, "uncomputable-mark")),
        motorIr,
      );
      expect(o.status, obsDiagnostic(o, "uncomputable-mark")).not.toBe("pass");
      expect(
        ["not-measured", "fail"],
        obsDiagnostic(o, "uncomputable-mark"),
      ).toContain(o.status);
    });
  });

  it("H3: unowned painted stroke directly inside circuit group joining K1.A1 and K1.13 FAILS on net-join", async () => {
    await withPage(async (page) => {
      const shortSvg = await addMotorLine(
        page,
        "[data-circuit-group]",
        null,
        ["K1", "A1"],
        ["K1", "13"],
      );
      const oShort = runCatalogObs(await openSheet(page, shortSvg), motorIr);
      expect(oShort.status, obsDiagnostic(oShort, "H3-short")).toBe("fail");
      expect(
        oShort.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(oShort, "H3-short"),
      ).toBe(true);
      expect(
        oShort.evidence?.notMeasured?.some(
          (m) => m.reason === "missing-electrical-role",
        ),
        obsDiagnostic(oShort, "H3-short"),
      ).toBe(true);
    });
  });

  it("H3: isolated unowned painted stroke directly inside circuit group yields not-measured", async () => {
    await withPage(async (page) => {
      const isoSvg = await addMotorLine(
        page,
        "[data-circuit-group]",
        null,
        { x: 2, y: 2 },
        { x: 5, y: 2 },
      );
      const oIso = runCatalogObs(await openSheet(page, isoSvg), motorIr);
      expect(oIso.status, obsDiagnostic(oIso, "H3-isolated")).toBe(
        "not-measured",
      );
      expect(
        oIso.evidence?.notMeasured?.some(
          (m) => m.reason === "missing-electrical-role",
        ),
        obsDiagnostic(oIso, "H3-isolated"),
      ).toBe(true);
    });
  });

  it("H4: clean dashed source-enclosure stays exempt and PASSES", async () => {
    await withPage(async (page) => {
      const obs = runCatalogObs(await openSheet(page, rm3Svg), rm3Ir, rm3Sheet);
      expect(obs.status, obsDiagnostic(obs, "H4-clean")).toBe("pass");
    });
  });

  it("H4: solid dark source-enclosure stroke crossing L1 and L2 FAILS", async () => {
    await withPage(async (page) => {
      const solidDarkSvg = await mutateSourceEnclosure(page, "solid-dark");
      const darkObs = runCatalogObs(
        await openSheet(page, solidDarkSvg),
        rm3Ir,
        rm3Sheet,
      );
      expect(darkObs.status, obsDiagnostic(darkObs, "H4-solid-dark")).toBe(
        "fail",
      );
      expect(
        darkObs.evidence?.findings?.some(
          (f) => f.kind === "symbol-primitive-joins-independent-nets",
        ),
        obsDiagnostic(darkObs, "H4-solid-dark"),
      ).toBe(true);
    });
  });

  it("H4: solid enclosure-grey source-enclosure stroke crossing L1 and L2 stays exempt and PASSES", async () => {
    await withPage(async (page) => {
      const solidGreySvg = await mutateSourceEnclosure(page, "solid-grey");
      const obs = runCatalogObs(
        await openSheet(page, solidGreySvg),
        rm3Ir,
        rm3Sheet,
      );
      expect(obs.status, obsDiagnostic(obs, "H4-solid-grey")).toBe("pass");
    });
  });

  it("positive control: changeover shared common 11 PASSES", async () => {
    await withPage(async (page) => {
      const obs = runCatalogObs(await openSheet(page, dolSvg), dolIr, dolSheet);
      expect(obs.status, obsDiagnostic(obs, "changeover-clean")).toBe("pass");
    });
  });

  it("negative control: changeover with stripped data-electrical-role FAILS", async () => {
    await withPage(async (page) => {
      const stripped = dolSvg.replace(/ data-electrical-role="[^"]*"/gu, "");
      const obs = runCatalogObs(
        await openSheet(page, stripped),
        dolIr,
        dolSheet,
      );
      expect(obs.status, obsDiagnostic(obs, "changeover-stripped")).toBe(
        "fail",
      );
    });
  });

  it("negative control: changeover with contact-path extended to terminal 14 FAILS", async () => {
    await withPage(async (page) => {
      const extSvg = await extendChangeoverTo14(page, dolSvg, r1Uid);
      const obs = runCatalogObs(await openSheet(page, extSvg), dolIr, dolSheet);
      expect(obs.status, obsDiagnostic(obs, "changeover-extended")).toBe(
        "fail",
      );
    });
  });

  it("positive control: same-net ganged mechanical-operator join PASSES", async () => {
    await withPage(async (page) => {
      const sameSvg = await addMotorLine(
        page,
        "[data-circuit-functions]",
        "mechanical-operator",
        ["OL1", "96"],
        ["K1", "A1"],
        { "data-mechanical-association": "ganged" },
      );
      const obs = runCatalogObs(await openSheet(page, sameSvg), motorIr);
      expect(obs.status, obsDiagnostic(obs, "same-net-gang")).toBe("pass");
    });
  });

  it("negative control: diff-net ganged mechanical-operator join FAILS", async () => {
    await withPage(async (page) => {
      const diffSvg = await addMotorLine(
        page,
        "[data-circuit-functions]",
        "mechanical-operator",
        ["K1", "A1"],
        ["K1", "13"],
        { "data-mechanical-association": "ganged" },
      );
      const obs = runCatalogObs(await openSheet(page, diffSvg), motorIr);
      expect(obs.status, obsDiagnostic(obs, "diff-net-gang")).toBe("fail");
    });
  });
});
