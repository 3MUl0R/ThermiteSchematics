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
import {
  renderSchematic,
  renderSchematicPacket,
} from "../../packages/render/dist/index.js";
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

async function renderDirectLoopSheet(mutateProject) {
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
    if (mutateProject) await mutateProject(dir);
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
    return { svg: rendered.value.sheets[0].svg, ir: compiled.ir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("#565 retains 5.46–5.49 and 5.51 summary readability under checker protocol 5.53", () => {
  expect(EVALS_VERSION).toBe("5.53");
  for (const evalsVersion of ["5.46", "5.47", "5.48", "5.49", "5.51"]) {
    const sample = { evalsVersion, summary: { "DQ-17": { pass: 1 } } };
    expect(readReportSummary(sample)).toEqual(sample.summary);
  }
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
  const { svg: clean } = await renderDirectLoopSheet();
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

  // Documented pre-5.47 limit: unattributed standalone [+1] following a
  // direct-loop caption keeps 5.46 behaviour (not bound as a count because
  // unattributed [+N] text cannot be distinguished from a description).
  const pair = JSON.stringify(["xt1", "1"]).replaceAll('"', "&quot;");
  const legacyStandalone = wrapSvg(
    `<g data-device-uid="xt1" transform="translate(20 20)">` +
      `<rect width="60" height="40" fill="white" stroke="black"/>` +
      `<circle data-layout-port="n1_in_1" data-loop-terminal="${pair}" cx="0" cy="20" r="0.8" fill="white" stroke="black"/>` +
      `<text x="2" y="18.5" font-size="2.7">1</text>` +
      `<text x="12" y="18.5" font-size="2.7">[+1]</text>` +
      `</g>`,
  );
  expect(terminalText(await measure(legacyStandalone))).toEqual([]);
});

it("#565 review repro: direct-loop authored terminal description '[+7]' on AQ1.4 gives zero DQ-17 findings", async () => {
  const { svg: issued, ir } = await renderDirectLoopSheet(async (dir) => {
    const typePath = join(
      dir,
      "industrial-pilot/types/siemens-aq4ui-st-2wire.json",
    );
    const definition = JSON.parse(await readFile(typePath, "utf8"));
    definition.types[0].terminals["4"].description = "[+7]";
    await writeFile(typePath, JSON.stringify(definition, null, 2) + "\n");
  });
  const aq1Uid = ir.devices.find((d) => d.designation === "AQ1")?.uid;
  expect(aq1Uid).toBeTruthy();

  const measured = await measure(issued);
  const aq1Texts = measured.texts.filter(
    (t) => t.deviceUid === aq1Uid && (t.text === "4" || t.text === "[+7]"),
  );
  expect(aq1Texts.find((t) => t.text === "4")?.terminal).toBe("4");
  expect(aq1Texts.find((t) => t.text === "[+7]")?.terminal).toBeUndefined();
  expect(terminalText(measured, ir)).toEqual([]);

  // Pre-5.47 unattributed form of the same sheet also passes with zero findings.
  const stripped = parseSvg(issued);
  for (const el of stripped.querySelectorAll("[data-terminal-caption-body]"))
    for (const a of [
      "data-terminal-caption-body",
      "data-terminal-key",
      "data-outside-connections",
    ])
      el.removeAttribute(a);
  expect(terminalText(await measure(stripped.toString()), ir)).toEqual([]);

  // Unattributed text matching a terminal number placed directly after a
  // circle[data-loop-terminal] in an attributed body is never bound.
  const directDescDoc = parseSvg(issued);
  const circle = directDescDoc.querySelector("circle[data-loop-terminal]");
  expect(circle).not.toBeNull();
  const unattributed = directDescDoc.createElement("text");
  unattributed.setAttribute("x", "22");
  unattributed.setAttribute("y", "14");
  unattributed.setAttribute("font-size", "2.7");
  unattributed.textContent = "4";
  circle.after(unattributed);
  const afterMeasured = await measure(directDescDoc.toString());
  expect(
    afterMeasured.texts.filter(
      (t) => t.deviceUid === aq1Uid && t.terminal === "4",
    ),
  ).toHaveLength(1);
  expect(terminalText(afterMeasured, ir)).toEqual([]);
});

it("#565 authoritative explicit ownership (rooted): unattributed symbol and description text is never bound", async () => {
  const rootedOut = await renderSchematic(motorIr, {
    format: "schematic-view-request/0.1",
    root: { by: "designation", value: "K1" },
    family: "control",
    flow: "left-to-right",
  });
  if (!rootedOut.ok) throw Error(JSON.stringify(rootedOut.error));
  const rootedDoc = parseSvg(rootedOut.value.svg);
  const railGroup = rootedDoc.querySelector("g.rail-symbol[data-terminal-key]");
  expect(railGroup).not.toBeNull();
  const railKey = railGroup.getAttribute("data-terminal-key");
  const railTag = railGroup.querySelector("text.rail-device-tag");
  expect(railTag).not.toBeNull();
  railTag.textContent = railKey;
  const railNote = rootedDoc.createElement("text");
  railNote.setAttribute("x", "4");
  railNote.setAttribute("y", "56");
  railNote.setAttribute("font-size", "10");
  railNote.textContent = "[+7]";
  railGroup.appendChild(railNote);
  const rootedMeasured = await measure(rootedDoc.toString());
  expect(
    rootedMeasured.texts.find((t) => t.railDeviceTag)?.terminal,
  ).toBeUndefined();
  expect(
    rootedMeasured.texts.find((t) => t.text === "[+7]")?.terminal,
  ).toBeUndefined();
  expect(terminalText(rootedMeasured, motorIr)).toEqual([]);
});

it("#565 authoritative explicit ownership (wiring): unattributed descriptions looking like '[+N]' or terminal keys are never bound", async () => {
  const wiringIr = structuredClone(motorIr);
  for (const d of wiringIr.devices) {
    if (d.designation === "K1") d.description = "[+7]";
    if (d.designation === "S1") d.description = "1";
  }
  const wiringRendered = await renderSchematicPacket(wiringIr, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "Wiring description probe",
        conductors: ["W-CTL-001", "W-CTL-002"],
      },
    ],
  });
  if (!wiringRendered.ok) throw Error(JSON.stringify(wiringRendered.error));
  const wiringDoc = parseSvg(wiringRendered.value.sheets[0].svg);
  const wiringCaption = wiringDoc.querySelector(
    "text[data-terminal-caption-body]",
  );
  expect(wiringCaption).not.toBeNull();
  const wiringKey = wiringCaption.getAttribute("data-terminal-key");
  for (const [dy, value] of [
    [10, "[+7]"],
    [15, "[ +7 ]"],
    [20, wiringKey],
  ]) {
    const desc = wiringDoc.createElement("text");
    desc.setAttribute(
      "x",
      String(Number(wiringCaption.getAttribute("x")) + 16),
    );
    desc.setAttribute(
      "y",
      String(Number(wiringCaption.getAttribute("y")) + dy),
    );
    desc.setAttribute("font-size", "2.7");
    desc.textContent = value;
    wiringCaption.parentElement.appendChild(desc);
  }
  const wiringMeasured = await measure(wiringDoc.toString());
  expect(
    wiringMeasured.texts.filter((t) => t.text === "[+7]" && t.terminal),
  ).toEqual([]);
  expect(
    wiringMeasured.texts.filter((t) => t.text === "[ +7 ]" && t.terminal),
  ).toEqual([]);
  expect(terminalText(wiringMeasured, wiringIr)).toEqual([]);
});

it("#565 authoritative explicit ownership (series-loop): unattributed descriptions inside loop ports are never bound, while attributed duplicates are caught", async () => {
  const seriesSvg = await readFile(
    resolve("packages/render/test/goldens/series-loop/low-left-to-right.svg"),
    "utf8",
  );
  const seriesDoc = parseSvg(seriesSvg);
  const seriesCaption = seriesDoc.querySelector(
    "text[data-terminal-caption-body]",
  );
  expect(seriesCaption).not.toBeNull();
  const seriesKey = seriesCaption.getAttribute("data-terminal-key");
  const seriesWrapper = seriesCaption.closest("[data-loop-terminal]");
  expect(seriesWrapper).not.toBeNull();
  for (const [parent, dx, dy, value] of [
    [seriesWrapper, 18, 8, "[+7]"],
    [seriesWrapper, 18, 13, seriesKey],
    [seriesWrapper.parentElement, 26, 8, "[+7]"],
  ]) {
    const desc = seriesDoc.createElement("text");
    desc.setAttribute(
      "x",
      String(Number(seriesCaption.getAttribute("x")) + dx),
    );
    desc.setAttribute(
      "y",
      String(Number(seriesCaption.getAttribute("y")) + dy),
    );
    desc.setAttribute("font-size", "2.7");
    desc.textContent = value;
    parent.appendChild(desc);
  }
  const seriesMeasured = await measure(seriesDoc.toString());
  expect(
    seriesMeasured.texts.filter((t) => t.text === "[+7]" && t.terminal),
  ).toEqual([]);
  expect(terminalText(seriesMeasured)).toEqual([]);

  const seriesDup = seriesDoc.createElement("text");
  for (const attr of seriesCaption.attributes)
    seriesDup.setAttribute(attr.name, attr.value);
  seriesDup.setAttribute(
    "x",
    String(Number(seriesCaption.getAttribute("x")) + 20),
  );
  seriesDup.setAttribute(
    "y",
    String(Number(seriesCaption.getAttribute("y")) + 18),
  );
  seriesDup.textContent = `${seriesKey} [+7]`;
  seriesWrapper.parentElement.appendChild(seriesDup);
  expect(terminalText(await measure(seriesDoc.toString()))).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
      text: seriesKey,
      otherText: `${seriesKey} [+7]`,
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

function cloneDetachedToSibling(doc, caption, dx, dy = 0) {
  const body = caption.closest("[data-device-uid]");
  const host = body.parentElement;
  const sibling = doc.createElement("g");
  const transform = body.getAttribute("transform");
  if (transform) sibling.setAttribute("transform", transform);
  const dup = doc.createElement("text");
  for (const attr of caption.attributes)
    dup.setAttribute(attr.name, attr.value);
  dup.setAttribute("x", String(Number(caption.getAttribute("x")) + dx));
  dup.setAttribute("y", String(Number(caption.getAttribute("y")) + dy));
  dup.textContent = caption.textContent;
  sibling.appendChild(dup);
  host.appendChild(sibling);
  return {
    uid: body.getAttribute("data-device-uid"),
    key: caption.getAttribute("data-terminal-key"),
  };
}

it("#599 item 1: detached attributed caption in sibling group resolves deviceUid and is caught across direct-loop, wiring, and series-loop", async () => {
  const { svg: directClean } = await renderDirectLoopSheet();
  const directDoc = parseSvg(directClean);
  const directCap = [
    ...directDoc.querySelectorAll("text[data-terminal-caption-body]"),
  ].find((t) => t.getAttribute("data-terminal-key") === "1");
  expect(directCap).not.toBeNull();
  const directMoved = cloneDetachedToSibling(directDoc, directCap, 24);
  const directMeasured = await measure(directDoc.toString());
  const directOwned = directMeasured.texts.filter(
    (t) => t.deviceUid === directMoved.uid && t.terminal === directMoved.key,
  );
  expect(directOwned).toHaveLength(2);
  expect(terminalText(directMeasured)).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
      text: "1",
      otherText: "1",
    }),
  ]);

  const wiringRendered = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "Wiring sibling-group probe",
        conductors: ["W-CTL-001", "W-CTL-002"],
      },
    ],
  });
  if (!wiringRendered.ok) throw Error(JSON.stringify(wiringRendered.error));
  const wiringDoc = parseSvg(wiringRendered.value.sheets[0].svg);
  const wiringCap = wiringDoc.querySelector("text[data-terminal-caption-body]");
  expect(wiringCap).not.toBeNull();
  const wiringMoved = cloneDetachedToSibling(wiringDoc, wiringCap, 20);
  const wiringMeasured = await measure(wiringDoc.toString());
  expect(
    wiringMeasured.texts.filter(
      (t) => t.deviceUid === wiringMoved.uid && t.terminal === wiringMoved.key,
    ),
  ).toHaveLength(2);
  expect(terminalText(wiringMeasured)).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
    }),
  ]);

  const seriesSvg = await readFile(
    resolve("packages/render/test/goldens/series-loop/low-left-to-right.svg"),
    "utf8",
  );
  const seriesDoc = parseSvg(seriesSvg);
  const seriesCap = seriesDoc.querySelector("text[data-terminal-caption-body]");
  expect(seriesCap).not.toBeNull();
  const seriesMoved = cloneDetachedToSibling(seriesDoc, seriesCap, -14, -6);
  const seriesMeasured = await measure(seriesDoc.toString());
  expect(
    seriesMeasured.texts.filter(
      (t) => t.deviceUid === seriesMoved.uid && t.terminal === seriesMoved.key,
    ),
  ).toHaveLength(2);
  expect(terminalText(seriesMeasured)).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
    }),
  ]);
});

it("#599 item 1: body-token binding disambiguates multiple views in one SVG and preserves circuit wrapper ownership", async () => {
  const multiViewClean = wrapSvg(
    `<g data-navigation-view="wiring:0">` +
      `<g data-device-uid="u1" data-terminal-body="d0" transform="translate(10 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="d0" x="2" y="19" font-size="2.7">1</text></g></g>` +
      `<g data-navigation-view="wiring:1">` +
      `<g data-device-uid="u1" data-terminal-body="d0" transform="translate(80 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="d0" x="2" y="19" font-size="2.7">1</text></g></g>` +
      `<g data-navigation-view="circuit:2">` +
      `<g data-device-uid="tb1" data-circuit-functions='["t1"]' transform="translate(140 10)">` +
      `<g data-layout-port="n0p0" data-terminal-id='["tb1","1"]' data-terminal-key="1">` +
      `<circle cx="0" cy="18" r="0.65" fill="white" stroke="black"/>` +
      `<text x="2" y="16.5" font-size="2.5">1</text></g></g></g>`,
  );
  const cleanMeasured = await measure(multiViewClean);
  expect(terminalText(cleanMeasured)).toEqual([]);
  const scopes = cleanMeasured.texts
    .filter((t) => t.deviceUid === "u1" && t.terminal === "1")
    .map((t) => t.terminalBodyScope);
  expect(new Set(scopes).size).toBe(2);
  expect(
    cleanMeasured.texts.find(
      (t) => t.deviceUid === "tb1" && t.terminal === "1",
    ),
  ).toBeTruthy();

  // Detached duplicate inside view 0 resolves only to view 0's body and is caught.
  const multiDoc = parseSvg(multiViewClean);
  const view0Cap = multiDoc.querySelector(
    '[data-navigation-view="wiring:0"] text[data-terminal-caption-body]',
  );
  cloneDetachedToSibling(multiDoc, view0Cap, 16);
  const dupMeasured = await measure(multiDoc.toString());
  const v0Texts = dupMeasured.texts.filter(
    (t) => t.deviceUid === "u1" && t.terminal === "1",
  );
  expect(v0Texts).toHaveLength(3);
  expect(new Set(v0Texts.map((t) => t.terminalBodyScope)).size).toBe(2);
  expect(terminalText(dupMeasured)).toEqual([
    expect.objectContaining({
      kind: "duplicate-or-overlapping-terminal-text",
      text: "1",
      otherText: "1",
    }),
  ]);
});

function packTwoDistinctMotorViews(svgA, svgB) {
  const docA = parseSvg(svgA),
    docB = parseSvg(svgB);
  const innerA =
    docA.querySelector("svg[data-view-format]") ?? docA.querySelector("svg");
  const innerB =
    docB.querySelector("svg[data-view-format]") ?? docB.querySelector("svg");
  const vbA = (innerA.getAttribute("viewBox") ?? "0 0 220 120")
    .split(/\s+/)
    .map(Number);
  const vbB = (innerB.getAttribute("viewBox") ?? "0 0 220 120")
    .split(/\s+/)
    .map(Number);
  const shiftY = vbA[3] + 12;
  const wrapB = docB.createElement("g");
  for (const child of [...innerB.childNodes]) wrapB.appendChild(child);
  for (const a of [
    "data-terminal-body",
    "data-terminal-caption-body",
    "data-layout-port",
    "data-layout-source-port",
    "data-layout-target-port",
    "data-wiring-landing-for",
  ])
    for (const el of wrapB.querySelectorAll(`[${a}]`))
      el.setAttribute(a, `v2_${el.getAttribute(a)}`);
  const w = Math.max(vbA[2], vbB[2]) + 20;
  const h = shiftY + vbB[3] + 20;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">` +
    `<g data-navigation-view="wiring:0" transform="translate(10 10)">${innerA.innerHTML}</g>` +
    `<g data-navigation-view="wiring:1" transform="translate(10 ${shiftY + 10})">${wrapB.innerHTML}</g></svg>`
  );
}

it("#599 finding 4a: moving a scoped PS1 caption into another view keeping its body token is reported", async () => {
  const ps1Uid = motorIr.devices.find((d) => d.designation === "PS1").uid;
  const r1 = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "PS1 view 1",
        conductors: ["W-CTL-001"],
      },
    ],
  });
  const r2 = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "PS1 view 2",
        conductors: ["W-CTL-003"],
      },
    ],
  });
  if (!r1.ok || !r2.ok) throw Error("Wiring render failed");
  const clean = packTwoDistinctMotorViews(
    r1.value.sheets[0].svg,
    r2.value.sheets[0].svg,
  );
  expect(terminalText(await measure(clean), motorIr)).toEqual([]);

  // Move view 1's PS1.+ caption into view 2 keeping its view-1 body token -> must be reported.
  const doc = parseSvg(clean);
  const v1Cap = doc.querySelector(
    `[data-navigation-view="wiring:0"] [data-device-uid="${ps1Uid}"] text[data-terminal-key="+"]`,
  );
  const v2 = doc.querySelector('[data-navigation-view="wiring:1"]');
  expect(v1Cap && v2).toBeTruthy();
  const carrier = doc.createElement("g");
  carrier.setAttribute("transform", "translate(5 5)");
  v1Cap.setAttribute("x", "2");
  v1Cap.setAttribute("y", "6");
  carrier.appendChild(v1Cap);
  v2.appendChild(carrier);
  const findings = terminalText(await measure(doc.toString()), motorIr);
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "invalid-terminal-caption-ownership",
        reason: "unresolved-terminal-caption-body",
      }),
      expect.objectContaining({
        kind: "missing-outside-connection-count",
        deviceUid: ps1Uid,
        terminal: "+",
        expectedOutside: 1,
      }),
    ]),
  );
});

it("#599 finding 4b: ambiguous explicit body token is reported while unscoped unique resolution and circuit-wrapper precedence pass", async () => {
  // Duplicate body token within the same view -> ambiguous-terminal-caption-body.
  const ambiguous = wrapSvg(
    `<g data-navigation-view="wiring:0">` +
      `<g data-device-uid="u1" data-terminal-body="dup" transform="translate(10 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="dup" x="2" y="19" font-size="2.7">1</text></g>` +
      `<g data-device-uid="u2" data-terminal-body="dup" transform="translate(80 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d1p0" data-terminal-key="2" cx="0" cy="18" r="0.7" fill="white" stroke="black"/>` +
      `<text data-terminal-key="2" data-terminal-caption-body="dup" x="2" y="19" font-size="2.7">2</text></g></g>`,
  );
  expect(terminalText(await measure(ambiguous))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "invalid-terminal-caption-ownership",
        reason: "ambiguous-terminal-caption-body",
      }),
    ]),
  );

  // Genuinely unscoped caption resolves uniquely SVG-wide, and circuit wrapper keeps precedence.
  const unscopedAndCircuit = wrapSvg(
    `<g data-device-uid="u1" data-terminal-body="solo" transform="translate(10 10)">` +
      `<rect width="40" height="30" fill="white" stroke="black"/>` +
      `<circle data-layout-port="d0p0" data-terminal-key="1" cx="0" cy="18" r="0.7" fill="white" stroke="black"/></g>` +
      `<g transform="translate(10 10)"><text data-terminal-key="1" data-terminal-caption-body="solo" x="2" y="19" font-size="2.7">1</text></g>` +
      `<g data-navigation-view="circuit:1">` +
      `<g data-device-uid="tb1" data-circuit-functions='["t1"]' transform="translate(100 10)">` +
      `<g data-layout-port="n0p0" data-terminal-id='["tb1","1"]' data-terminal-key="1">` +
      `<circle cx="0" cy="18" r="0.65" fill="white" stroke="black"/>` +
      `<text data-terminal-key="1" data-terminal-caption-body="missing" x="2" y="16.5" font-size="2.5">1</text></g></g></g>`,
  );
  const gOk = await measure(unscopedAndCircuit);
  expect(terminalText(gOk)).toEqual([]);
  expect(
    gOk.texts.find((t) => t.deviceUid === "u1" && t.terminal === "1"),
  ).toBeTruthy();
  expect(
    gOk.texts.find((t) => t.deviceUid === "tb1" && t.terminal === "1"),
  ).toBeTruthy();
});
