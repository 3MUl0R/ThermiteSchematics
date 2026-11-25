import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { launch, openSheet, drawingContextOptions } from "./browser.mjs";
import {
  createNavigationProject,
  renderNavigationFixture,
} from "./check6-navigation-fixture.mjs";
import { elementNavigationAudit } from "./element-navigation-oracle.mjs";

let browser, context, page, project, baseFixture;

beforeAll(async () => {
  project = await createNavigationProject();
  browser = await launch();
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
  baseFixture = await renderNavigationFixture(project, "left-to-right");
  baseFixture.geometries = [];
  for (const sheet of baseFixture.packet.sheets)
    baseFixture.geometries.push(await openSheet(page, sheet.svg));
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (project) await rm(project.directory, { recursive: true, force: true });
});

function locateAuxSheet(fixture) {
  const audit = elementNavigationAudit(
    fixture.packet,
    fixture.geometries,
    fixture.ir,
    fixture.request,
  );
  const ol1 = fixture.ir.devices.find((d) => d.designation === "OL1");
  const aux = audit.appearances.find(
    (a) => a.uid === ol1.uid && a.functionKey.includes("aux"),
  );
  if (!aux) throw Error("Expected OL1 auxiliary contact appearance");
  return { ol1, aux, sheetIndex: aux.geometryIndex };
}

function rewriteOl1Locator(
  svg,
  { dx = 0, dy = 0, transformHeader, transformRow },
) {
  const document = parseHTML(svg).document;
  const group = [...document.querySelectorAll("[data-navigation-role]")].find(
    (e) => /OL1/u.test(e.textContent) && /→/u.test(e.textContent),
  );
  if (!group) throw Error("Expected OL1 element locator group on aux sheet");
  const texts = [...group.querySelectorAll("text")];
  for (const [i, node] of texts.entries()) {
    if (dx) node.setAttribute("x", String(Number(node.getAttribute("x")) + dx));
    if (dy) node.setAttribute("y", String(Number(node.getAttribute("y")) + dy));
    if (i === 0 && transformHeader)
      node.textContent = transformHeader(node.textContent);
    if (transformRow) node.textContent = transformRow(node.textContent, i);
  }
  return document.querySelector("svg").outerHTML;
}

async function auditMutatedAuxSheet(mutator, irMutator) {
  const { sheetIndex, aux, ol1 } = locateAuxSheet(baseFixture);
  const packet = structuredClone(baseFixture.packet);
  // Strip renderer navigation metadata to prove oracle measures printed SVG only.
  delete packet.navigation;
  const ir = structuredClone(baseFixture.ir);
  const request = structuredClone(baseFixture.request);
  const mutatedSvg = mutator(packet.sheets[sheetIndex].svg, { aux, ol1 });
  packet.sheets[sheetIndex].svg = mutatedSvg;
  if (irMutator) irMutator(ir, request, { aux, ol1, sheetIndex });
  const geometries = baseFixture.geometries.slice();
  geometries[sheetIndex] = await openSheet(page, mutatedSvg);
  return elementNavigationAudit(packet, geometries, ir, request);
}

describe("DQ-08 self-located element navigation controls (#625)", () => {
  it("passes a distant self-located annotation with independently validated prefix", async () => {
    const result = await auditMutatedAuxSheet((svg, { aux }) => {
      const token = `${String(aux.sheet).padStart(2, "0")}.${aux.zone}`;
      return rewriteOl1Locator(svg, {
        dx: 160,
        dy: 80,
        transformHeader: (text) => text.replace(/^OL1:/u, `OL1 (${token}):`),
      });
    });
    expect(result.findings).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.eligible).toBe(6);
  });

  it("fails when a self-located prefix names the wrong zone or wrong sheet", async () => {
    for (const [label, dx, dy, makeToken] of [
      [
        "distant wrong zone",
        160,
        80,
        (aux) =>
          `${String(aux.sheet).padStart(2, "0")}.${aux.zone === "D6" ? "A1" : "D6"}`,
      ],
      ["distant wrong sheet", 160, 80, (aux) => `09.${aux.zone}`],
      [
        "local wrong zone cannot fall back to local",
        0,
        0,
        (aux) =>
          `${String(aux.sheet).padStart(2, "0")}.${aux.zone === "D6" ? "A1" : "D6"}`,
      ],
    ]) {
      const result = await auditMutatedAuxSheet((svg, { aux }) =>
        rewriteOl1Locator(svg, {
          dx,
          dy,
          transformHeader: (text) =>
            text.replace(/^OL1:/u, `OL1 (${makeToken(aux)}):`),
        }),
      );
      expect(
        result.findings.map((f) => f.kind),
        label,
      ).toContain("detached-element-reference-missing-or-wrong");
    }
  });

  it("fails when a self-located prefix names the wrong designation", async () => {
    const result = await auditMutatedAuxSheet((svg, { aux }) => {
      const token = `${String(aux.sheet).padStart(2, "0")}.${aux.zone}`;
      return rewriteOl1Locator(svg, {
        dx: 160,
        dy: 80,
        transformHeader: (text) =>
          text.replace(/^OL1:/u, `OL2 (${token}): OL1`),
      });
    });
    expect(result.findings.map((f) => f.kind)).toContain(
      "detached-element-reference-missing-or-wrong",
    );
  });

  it("fails when ownership of the self-located prefix is ambiguous on the sheet", async () => {
    const result = await auditMutatedAuxSheet(
      (svg, { aux, ol1 }) => {
        const token = `${String(aux.sheet).padStart(2, "0")}.${aux.zone}`;
        const relocated = rewriteOl1Locator(svg, {
          dx: 160,
          dy: 80,
          transformHeader: (text) => text.replace(/^OL1:/u, `OL1 (${token}):`),
        });
        const document = parseHTML(relocated).document;
        const ownerNode = [
          ...document.querySelectorAll(`[data-device-uid="${ol1.uid}"]`),
        ].find((e) => e.hasAttribute("data-circuit-functions"));
        if (!ownerNode) throw Error("Expected OL1 circuit node on aux sheet");
        const clone = ownerNode.cloneNode(true);
        const dupUid = "00000000-0000-4000-8000-000000000999";
        clone.setAttribute("id", "ambiguous-ol1-copy");
        clone.setAttribute("data-device-uid", dupUid);
        if (clone.hasAttribute("data-circuit-tag-lane"))
          clone.setAttribute("data-circuit-tag-lane", dupUid);
        clone.setAttribute(
          "data-circuit-functions",
          clone
            .getAttribute("data-circuit-functions")
            .replaceAll(ol1.uid, dupUid),
        );
        for (const el of clone.querySelectorAll("[data-device-uid]"))
          el.setAttribute("data-device-uid", dupUid);
        for (const el of clone.querySelectorAll("[data-function-id]"))
          el.setAttribute(
            "data-function-id",
            el.getAttribute("data-function-id").replaceAll(ol1.uid, dupUid),
          );
        for (const el of clone.querySelectorAll("[data-terminal-id]"))
          el.setAttribute(
            "data-terminal-id",
            el.getAttribute("data-terminal-id").replaceAll(ol1.uid, dupUid),
          );
        ownerNode.parentNode.appendChild(clone);
        return document.querySelector("svg").outerHTML;
      },
      (ir, _request, { ol1 }) => {
        const dupUid = "00000000-0000-4000-8000-000000000999";
        ir.devices.push({ ...structuredClone(ol1), uid: dupUid });
        for (const fn of ir.functions.filter((f) => f.id.deviceUid === ol1.uid))
          ir.functions.push({
            ...structuredClone(fn),
            id: { deviceUid: dupUid, functionKey: fn.id.functionKey },
            terminals: fn.terminals.map((t) => ({ ...t, deviceUid: dupUid })),
          });
      },
    );
    const { aux } = locateAuxSheet(baseFixture);
    const sameZoneOl1 = result.appearances.filter(
      (a) => a.sheet === aux.sheet && a.zone === aux.zone,
    );
    expect(sameZoneOl1.length).toBeGreaterThanOrEqual(2);
    expect([...result.findings, ...result.failures].length).toBeGreaterThan(0);
    expect(result.findings.map((f) => f.kind)).toContain(
      "detached-element-reference-missing-or-wrong",
    );
  });

  it("fails when a self-located annotation has a correct prefix but a wrong destination", async () => {
    for (const mode of ["wrong-zone", "source-zone-as-destination"]) {
      const result = await auditMutatedAuxSheet((svg, { aux }) => {
        const token = `${String(aux.sheet).padStart(2, "0")}.${aux.zone}`;
        return rewriteOl1Locator(svg, {
          dx: 160,
          dy: 80,
          transformHeader: (text) => text.replace(/^OL1:/u, `OL1 (${token}):`),
          transformRow: (text, i) =>
            i === 1
              ? text.replace(
                  /\d{2}\.[A-D][1-6]\b/u,
                  mode === "wrong-zone" ? "01.D6" : token,
                )
              : text,
        });
      });
      expect(
        result.findings.map((f) => f.kind),
        mode,
      ).toContain("detached-element-reference-missing-or-wrong");
    }
  });

  it("still fails an unprefixed distant annotation without relaxing locality", async () => {
    const result = await auditMutatedAuxSheet((svg) =>
      rewriteOl1Locator(svg, { dx: 160, dy: 80 }),
    );
    expect(result.findings.map((f) => f.kind)).toContain(
      "detached-element-reference-missing-or-wrong",
    );
  });

  function renameOl1InSvg(svg, tag) {
    const document = parseHTML(svg).document;
    for (const node of document.querySelectorAll("text")) {
      const spans = [...node.querySelectorAll("tspan")];
      if (spans.length) {
        for (const span of spans)
          span.textContent = span.textContent.replace(/\bOL1\b/gu, tag);
      } else {
        node.textContent = node.textContent.replace(/\bOL1\b/gu, tag);
      }
    }
    return document.querySelector("svg").outerHTML;
  }

  function renameOl1InRequest(request, tag) {
    for (const view of request.views ?? []) {
      if (view.root?.by === "designation" && view.root.value === "OL1")
        view.root.value = tag;
      for (const group of view.groups ?? [])
        for (const fn of group.functions ?? [])
          if (fn.device?.by === "designation" && fn.device.value === "OL1")
            fn.device.value = tag;
    }
  }

  async function auditRenamedOl1(tag, mutator) {
    const { sheetIndex, aux, ol1 } = locateAuxSheet(baseFixture);
    const packet = structuredClone(baseFixture.packet);
    delete packet.navigation;
    const ir = structuredClone(baseFixture.ir);
    const request = structuredClone(baseFixture.request);
    ir.devices.find((d) => d.uid === ol1.uid).designation = tag;
    renameOl1InRequest(request, tag);
    const geometries = [];
    for (const [i, sheet] of packet.sheets.entries()) {
      let svg = renameOl1InSvg(sheet.svg, tag);
      if (i === sheetIndex && mutator) svg = mutator(svg, { aux, ol1, tag });
      sheet.svg = svg;
      geometries.push(await openSheet(page, svg));
    }
    return elementNavigationAudit(packet, geometries, ir, request);
  }

  it("preserves opaque parenthesized designations for local, valid self-located, and wrong-zone headers", async () => {
    const tag = "OL1(A)";

    // Local nearest-owner "OL1(A): Overload element" stays local and passes with 0 findings.
    let seenLocalHeader = "";
    const localResult = await auditRenamedOl1(tag, (svg) =>
      rewriteOl1Locator(svg, {
        transformHeader: (text) => {
          seenLocalHeader = text;
          return text;
        },
      }),
    );
    expect(seenLocalHeader).toMatch(/^OL1\(A\): Overload element\b/u);
    expect(localResult.findings).toEqual([]);
    expect(localResult.failures).toEqual([]);
    expect(localResult.eligible).toBe(6);

    // Valid self-located "OL1(A) (<SS>.<ZN>): Overload element" at distant placement passes.
    let seenSelfLocatedHeader = "";
    const validResult = await auditRenamedOl1(tag, (svg, { aux }) => {
      const token = `${String(aux.sheet).padStart(2, "0")}.${aux.zone}`;
      return rewriteOl1Locator(svg, {
        dx: 160,
        dy: 80,
        transformHeader: (text) => {
          seenSelfLocatedHeader = text.replace(
            /^OL1\(A\):/u,
            `OL1(A) (${token}):`,
          );
          return seenSelfLocatedHeader;
        },
      });
    });
    expect(seenSelfLocatedHeader).toMatch(
      /^OL1\(A\) \(\d{2}\.[A-Z]\d\): Overload element\b/u,
    );
    expect(validResult.findings).toEqual([]);
    expect(validResult.failures).toEqual([]);
    expect(validResult.eligible).toBe(6);

    // Wrong-zone "OL1(A) (<SS>.B3)" fails both when distant and when local.
    for (const [label, dx, dy] of [
      ["distant wrong zone", 160, 80],
      ["local wrong zone", 0, 0],
    ]) {
      const wrongZoneResult = await auditRenamedOl1(tag, (svg, { aux }) => {
        const wrongZone = aux.zone === "B3" ? "A1" : "B3";
        const wrongToken = `${String(aux.sheet).padStart(2, "0")}.${wrongZone}`;
        return rewriteOl1Locator(svg, {
          dx,
          dy,
          transformHeader: (text) =>
            text.replace(/^OL1\(A\):/u, `OL1(A) (${wrongToken}):`),
        });
      });
      expect(
        wrongZoneResult.findings.map((f) => f.kind),
        label,
      ).toContain("detached-element-reference-missing-or-wrong");
    }
  });
});
