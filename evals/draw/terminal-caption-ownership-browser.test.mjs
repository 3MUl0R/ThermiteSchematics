import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOMParser } from "linkedom";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  compileProject,
  lockProject,
} from "../../packages/compiler/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { layoutPresentationGraph } from "../../packages/render/dist/layout/elk-adapter.js";
import { buildPresentationGraph } from "../../packages/render/dist/presentation.js";
import { emitSchematicSvg } from "../../packages/render/dist/svg/emitter.js";
import { prepareSchematicTitleContext } from "../../packages/render/dist/title-block.js";
import { terminalPassThroughFixture } from "../../packages/render/fixtures/presentation-cases.ts";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { terminalText } from "./checks.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { EVALS_VERSION } from "./version.mjs";

let browser, context, page, motorIr;
beforeAll(async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  motorIr = compiled.ir;
  // Accurate Canvas bounds for small-font checks (crbug.com/479240778).
  browser = await launch([
    "--enable-blink-features=CanvasTextMetricsPreciseBounds",
  ]);
  context = await browser.newContext(drawingContextOptions);
  page = await context.newPage();
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const measure = (svg) => openSheet(page, embedPrintableFont(svg));
const wrapSvg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="220mm" height="120mm" viewBox="0 0 220 120">${body}</svg>`;
const parseSvg = (svg) => new DOMParser().parseFromString(svg, "image/svg+xml");

async function renderRootedPassThrough() {
  const f = terminalPassThroughFixture(motorIr);
  const built = buildPresentationGraph({ ir: f.ir, selected: f.selected });
  if (!built.ok) throw Error(JSON.stringify(built));
  const laid = await layoutPresentationGraph(built.value.graph);
  if (!laid.ok) throw Error(JSON.stringify(laid));
  const title = prepareSchematicTitleContext(
    "Rooted pass-through",
    built.value.graph.view,
  );
  if (!title.ok) throw Error(JSON.stringify(title));
  const emitted = emitSchematicSvg(built.value.graph, laid.value, title.value);
  if (!emitted.ok) throw Error(JSON.stringify(emitted));
  return emitted.value;
}

async function renderDirectLoopSheet() {
  const dir = await mkdtemp(join(tmpdir(), "thermite-dq17own-"));
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
        project: { name: "Direct loop probe" },
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
    const req = JSON.parse(
      await readFile(
        resolve("packages/cli/fixtures/analog-output/packet.request.json"),
        "utf8",
      ),
    );
    const rendered = await renderSchematicPacket(compiled.ir, req);
    if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
    return rendered.value.sheets[0].svg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("#565 bumps checker protocol to 5.47 with 5.46 readability", () => {
  expect(EVALS_VERSION).toBe("5.47");
  const sample = { evalsVersion: "5.46", summary: { "DQ-17": { pass: 1 } } };
  expect(readReportSummary(sample)).toEqual(sample.summary);
});

it("#565 miss form 1: flags rooted count-form duplicate ('1 [+1]' next to '1') with and without explicit attrs", async () => {
  const clean = await renderRootedPassThrough();
  expect(terminalText(await measure(clean))).toEqual([]);

  for (const includeExplicitAttrs of [true, false]) {
    const doc = parseSvg(clean);
    const kept = [...doc.querySelectorAll("text.label-terminal")].find(
      (t) => t.getAttribute("data-terminal-key") === "1",
    );
    const suppressed = [...doc.querySelectorAll("text")].find(
      (t) => t.textContent === "" && t.hasAttribute("clip-path"),
    );
    expect(kept && suppressed).toBeTruthy();
    suppressed.setAttribute("class", "label-text label-terminal");
    suppressed.setAttribute("x", String(Number(kept.getAttribute("x")) + 24));
    suppressed.setAttribute("y", kept.getAttribute("y"));
    suppressed.setAttribute("font-size", "10");
    if (includeExplicitAttrs) {
      suppressed.setAttribute("data-terminal-key", "1");
      suppressed.setAttribute(
        "data-terminal-caption-body",
        kept.getAttribute("data-terminal-caption-body"),
      );
    }
    suppressed.textContent = "1 [+1]";
    const findings = terminalText(await measure(doc.toString()));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("duplicate-or-overlapping-terminal-text");
    expect([findings[0].text, findings[0].otherText].sort()).toEqual([
      "1",
      "1 [+1]",
    ]);
  }
});

it("#565 miss form 2: flags an injected second caption in the wiring view while passing legitimate [ +N ] counts", async () => {
  const rendered = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "Wiring DQ-17 probe",
        conductors: ["W-CTL-001", "W-CTL-002"],
      },
    ],
  });
  if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
  const clean = rendered.value.sheets[0].svg;
  // Negative control 1 (wiring): legitimate single caption with off-body [ +N ] count passes.
  expect(clean).toContain("data-outside-connections=");
  expect(terminalText(await measure(clean))).toEqual([]);

  for (const [label, shift, text] of [
    ["distant-same-text", 20, null],
    ["count-form", 12, (key) => `${key} [ +1 ]`],
  ]) {
    const doc = parseSvg(clean);
    const first = doc.querySelector("text[data-terminal-caption-body]");
    expect(first, label).not.toBeNull();
    const dup = doc.createElement("text");
    for (const attr of first.attributes)
      dup.setAttribute(attr.name, attr.value);
    dup.setAttribute("x", String(Number(first.getAttribute("x")) + shift));
    dup.textContent = text
      ? text(first.getAttribute("data-terminal-key"))
      : first.textContent;
    first.parentElement.appendChild(dup);
    const findings = terminalText(await measure(doc.toString()));
    expect(findings, label).toEqual([
      expect.objectContaining({
        kind: "duplicate-or-overlapping-terminal-text",
      }),
    ]);
  }
});

it("#565 miss form 3: flags detached duplicate and standalone [+N] captions in direct signal-loop views", async () => {
  const clean = await renderDirectLoopSheet();
  expect(terminalText(await measure(clean))).toEqual([]);

  // 3a: non-overlapping duplicate placed after another element (>= 15 mm away).
  const docDetached = parseSvg(clean);
  const caption = [
    ...docDetached.querySelectorAll("text[data-terminal-caption-body]"),
  ].find((t) => t.getAttribute("data-terminal-key") === "1");
  expect(caption).not.toBeNull();
  const detached = docDetached.createElement("text");
  for (const attr of caption.attributes)
    detached.setAttribute(attr.name, attr.value);
  detached.setAttribute("x", String(Number(caption.getAttribute("x")) + 24));
  detached.textContent = "1";
  caption.parentElement.appendChild(detached);
  expect(terminalText(await measure(docDetached.toString()))).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
      text: "1",
      otherText: "1",
    }),
  ]);

  // 3b: standalone [+1] text with explicit ownership attributes.
  const docCount = parseSvg(clean);
  const ownedCaption = [
    ...docCount.querySelectorAll("text[data-terminal-caption-body]"),
  ].find((t) => t.getAttribute("data-terminal-key") === "1");
  const countText = docCount.createElement("text");
  for (const attr of ownedCaption.attributes)
    countText.setAttribute(attr.name, attr.value);
  countText.setAttribute(
    "x",
    String(Number(ownedCaption.getAttribute("x")) + 10),
  );
  countText.textContent = "[+1]";
  ownedCaption.parentElement.appendChild(countText);
  expect(terminalText(await measure(docCount.toString()))).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
      text: "1",
      otherText: "[+1]",
    }),
  ]);

  // 3b legacy fallback: unattributed standalone [+1] following a direct-loop caption.
  const pair = JSON.stringify(["xt1", "1"]).replaceAll('"', "&quot;");
  const legacyStandalone = wrapSvg(
    `<g data-device-uid="xt1" transform="translate(20 20)">` +
      `<rect width="60" height="40" fill="white" stroke="black"/>` +
      `<circle data-layout-port="n1_in_1" data-loop-terminal="${pair}" cx="0" cy="20" r="0.8" fill="white" stroke="black"/>` +
      `<text x="2" y="18.5" font-size="2.7">1</text>` +
      `<text x="12" y="18.5" font-size="2.7">[+1]</text>` +
      `</g>`,
  );
  expect(terminalText(await measure(legacyStandalone))).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
      text: "1",
      otherText: "[+1]",
    }),
  ]);
});

it("#565 negative controls: passes single caption with off-body [+N] count and same terminal on different bodies", async () => {
  // Single caption with off-body [+N] count in circuit and wiring forms.
  const outsideControls = wrapSvg(
    `<g data-device-uid="tb1" data-circuit-functions='["t1"]'>` +
      `<g data-layout-port="n0p0" data-terminal-id='["tb1","1"]' data-terminal-key="1" data-outside-connections="2">` +
      `<circle cx="10" cy="20" r="0.65" fill="white" stroke="black"/>` +
      `<text x="12" y="18.5" font-size="2.5">1 [+2]</text></g></g>` +
      `<g data-device-uid="tb2" transform="translate(80 10)">` +
      `<rect width="48" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="d0" data-outside-connections="3" x="2" y="19" font-size="2.7">1 [ +3 ]</text></g>`,
  );
  expect(terminalText(await measure(outsideControls))).toEqual([]);

  // Same physical terminal ("1") printed on two different bodies of the same device UID
  // (even when both bodies reuse local body id "d0" / "n0").
  const splitBodies = wrapSvg(
    `<g data-device-uid="xt1" transform="translate(10 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="d0" x="2" y="19" font-size="2.7">1</text></g>` +
      `<g data-device-uid="xt1" transform="translate(80 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="d0" x="2" y="19" font-size="2.7">1</text></g>` +
      `<g data-device-uid="xt2" transform="translate(10 60)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="n0_in_1" data-loop-terminal='["xt2","1"]' cx="0" cy="18" r="0.8" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="n0" x="2" y="16.5" font-size="2.7">1</text></g>` +
      `<g data-device-uid="xt2" transform="translate(80 60)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="n0_in_1" data-loop-terminal='["xt2","1"]' cx="0" cy="18" r="0.8" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="n0" x="2" y="16.5" font-size="2.7">1</text></g>`,
  );
  expect(terminalText(await measure(splitBodies))).toEqual([]);
});
