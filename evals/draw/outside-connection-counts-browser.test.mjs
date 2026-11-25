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
import {
  coreSupply,
  request as seriesRequest,
  seriesFixture,
  uid,
  wire,
  withFeedThroughs,
} from "../../packages/render/test/series-loop-fixture.ts";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { terminalText, textBounds } from "./checks.mjs";
import * as corpusRequests from "./corpus/requests.mjs";

let browser, context, page, motorIr;
beforeAll(async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  motorIr = compiled.ir;
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
const parseSvg = (svg) => new DOMParser().parseFromString(svg, "image/svg+xml");

async function buildSeriesWithBranches() {
  return seriesFixture(async (m) => {
    withFeedThroughs(m);
    await coreSupply(m, "0.2.0");
    let serial = 500;
    for (let i = 0; i < 5; i++) {
      const load = `LD${i + 1}`;
      m.objects.push({
        kind: "device",
        uid: uid(80 + i),
        designation: load,
        type: "series:load",
      });
      m.objects.push(wire(serial++, "PS1", "+", load, "p"));
      if (i < 3) m.objects.push(wire(serial++, "PS1", "-", load, "n"));
    }
  });
}

async function renderCorpusField(name, flow) {
  const dir = await mkdtemp(join(tmpdir(), `thermite-dq17cnt-${name}-`));
  try {
    for (const lib of ["field-interfaces", "industrial-pilot"])
      await cp(resolve("libraries", lib), join(dir, lib), { recursive: true });
    await cp(
      resolve(`packages/cli/fixtures/${name}/source.json`),
      join(dir, "source.json"),
    );
    await writeFile(
      join(dir, "system.json"),
      JSON.stringify({
        format: "electrical-system/0.1",
        project: { name: `DQ-17 ${name}` },
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
    const baseReq =
      name === "analog-output"
        ? JSON.parse(
            await readFile(
              resolve(
                "packages/cli/fixtures/analog-output/packet.request.json",
              ),
              "utf8",
            ),
          )
        : structuredClone(corpusRequests.signal);
    const req = {
      ...baseReq,
      page:
        flow === "top-to-bottom"
          ? { size: "tabloid", orientation: "portrait" }
          : baseReq.page,
      views: baseReq.views.map((v) =>
        v.format === "signal-loop-view-request/0.1" ? { ...v, flow } : v,
      ),
    };
    const rendered = await renderSchematicPacket(compiled.ir, req);
    if (!rendered.ok) throw Error(JSON.stringify(rendered.error));
    return { svg: rendered.value.sheets[0].svg, ir: compiled.ir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("#626 TTB stress (+ [+5], - [+3]): zero DQ-17 findings, zero text overlap, zero frame overflow", async () => {
  const f = await buildSeriesWithBranches();
  try {
    const res = await renderSchematicPacket(f.ir, {
      format: "schematic-packet-request/0.1",
      index: false,
      page: { size: "tabloid", orientation: "portrait" },
      views: [
        seriesRequest({
          flow: "top-to-bottom",
          loopPower: { device: "PS1", function: "dc_output" },
        }),
      ],
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const g = await measure(res.value.sheets[0].svg);
    expect(terminalText(g, f.ir)).toEqual([]);
    expect(textBounds(g)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

const findPos = (doc) =>
  [...doc.querySelectorAll("text[data-terminal-caption-body]")].find(
    (t) => t.getAttribute("data-terminal-key") === "+",
  );

async function renderCleanSeriesLtr() {
  const f = await buildSeriesWithBranches();
  const res = await renderSchematicPacket(f.ir, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      seriesRequest({
        flow: "left-to-right",
        loopPower: { device: "PS1", function: "dc_output" },
      }),
    ],
  });
  if (!res.ok) {
    await f.dispose();
    throw Error(JSON.stringify(res.error));
  }
  return { ...f, clean: res.value.sheets[0].svg };
}

it("#626 mutants: erased [+N], erased caption, and wrong N fail DQ-17", async () => {
  const f = await renderCleanSeriesLtr();
  try {
    expect(terminalText(await measure(f.clean), f.ir)).toEqual([]);

    // Mutant 1: erase [+5] -> fail.
    const docErasedSuffix = parseSvg(f.clean);
    findPos(docErasedSuffix).textContent = "+";
    expect(
      terminalText(await measure(docErasedSuffix.toString()), f.ir),
    ).toEqual([
      expect.objectContaining({
        kind: "missing-outside-connection-count",
        terminal: "+",
        expectedOutside: 5,
        printedOutside: 0,
      }),
    ]);

    // Mutant 2: erase entire caption element -> fail (judged from native body, not caption presence).
    const docRemovedCap = parseSvg(f.clean);
    findPos(docRemovedCap).remove();
    expect(terminalText(await measure(docRemovedCap.toString()), f.ir)).toEqual(
      [
        expect.objectContaining({
          kind: "missing-outside-connection-count",
          terminal: "+",
          expectedOutside: 5,
          printedOutside: null,
        }),
      ],
    );

    // Mutant 3: wrong N -> fail.
    const docWrongN = parseSvg(f.clean);
    findPos(docWrongN).textContent = "+ [+4]";
    expect(terminalText(await measure(docWrongN.toString()), f.ir)).toEqual([
      expect.objectContaining({
        kind: "mismatched-outside-connection-count",
        terminal: "+",
        expectedOutside: 5,
        printedOutside: 4,
      }),
    ]);
  } finally {
    await f.dispose();
  }
});

it("#626 mutants: altered data-outside-connections is judged from native data, and detached sibling caption resolves via body token", async () => {
  const f = await renderCleanSeriesLtr();
  try {
    // Mutant 4a: altered data-outside-connections with correct text -> still judged from native data (pass).
    const docAlteredAttr = parseSvg(f.clean);
    findPos(docAlteredAttr).setAttribute("data-outside-connections", "99");
    expect(
      terminalText(await measure(docAlteredAttr.toString()), f.ir),
    ).toEqual([]);

    // Mutant 4b: altered data-outside-connections matching forged wrong text -> still fail from native data.
    const docForgedBoth = parseSvg(f.clean);
    const cap4b = findPos(docForgedBoth);
    cap4b.setAttribute("data-outside-connections", "99");
    cap4b.textContent = "+ [+99]";
    expect(terminalText(await measure(docForgedBoth.toString()), f.ir)).toEqual(
      [
        expect.objectContaining({
          kind: "mismatched-outside-connection-count",
          terminal: "+",
          expectedOutside: 5,
          printedOutside: 99,
        }),
      ],
    );

    // Mutant 5: detached attributed caption moved to sibling <g> with stripped [+5] -> caught via Commit-1 binding.
    const docDetached = parseSvg(f.clean);
    const cap5 = findPos(docDetached);
    const body5 = cap5.closest("[data-device-uid]");
    const sibling = docDetached.createElement("g");
    sibling.setAttribute("transform", body5.getAttribute("transform"));
    cap5.textContent = "+";
    sibling.appendChild(cap5);
    body5.parentElement.appendChild(sibling);
    expect(terminalText(await measure(docDetached.toString()), f.ir)).toEqual([
      expect.objectContaining({
        kind: "missing-outside-connection-count",
        terminal: "+",
        expectedOutside: 5,
        printedOutside: 0,
      }),
    ]);
  } finally {
    await f.dispose();
  }
});

it("#626 circuit group semantics: per-group outside counts on multi-group sheet", async () => {
  // Both wires on PS1.+ (W-CTL-001 and W-CTL-003) appear on the same sheet in separate groups.
  const circuitRes = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "circuit-view-request/0.1",
        title: "Multi-group outside-count probe",
        groups: [
          {
            id: "g1",
            label: "Group 1",
            functions: [
              { device: { by: "designation", value: "PS1" }, key: "dc_output" },
              { device: { by: "designation", value: "PLC1" }, key: "supply" },
            ],
            conductors: ["W-CTL-001", "W-CTL-002"],
          },
          {
            id: "g2",
            label: "Group 2",
            functions: [
              { device: { by: "designation", value: "PS1" }, key: "dc_output" },
              {
                device: { by: "designation", value: "TB1" },
                key: "terminal1",
              },
            ],
            conductors: ["W-CTL-003"],
          },
        ],
      },
    ],
  });
  expect(circuitRes.ok, JSON.stringify(circuitRes)).toBe(true);
  if (!circuitRes.ok) return;
  const cleanCircuit = circuitRes.value.sheets[0].svg;
  expect(terminalText(await measure(cleanCircuit), motorIr)).toEqual([]);

  // Strip [+1] from Group 1's PS1.+ -> must fail even though Group 2 draws W-CTL-003 on the same sheet.
  const docCircuit = parseSvg(cleanCircuit);
  const g1PosText = [
    ...docCircuit.querySelectorAll(
      '[data-circuit-group="g1"] [data-terminal-key="+"] text',
    ),
  ][0];
  expect(g1PosText?.textContent).toBe("+ [+1]");
  g1PosText.textContent = "+";
  expect(terminalText(await measure(docCircuit.toString()), motorIr)).toEqual([
    expect.objectContaining({
      kind: "missing-outside-connection-count",
      terminal: "+",
      expectedOutside: 1,
      printedOutside: 0,
    }),
  ]);
});

it("#626 wiring view: clean native [ +N ] passes and wrong N fails", async () => {
  const wiringRes = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "Wiring outside-count probe",
        conductors: ["W-CTL-001", "W-CTL-002"],
      },
    ],
  });
  if (!wiringRes.ok) throw Error(JSON.stringify(wiringRes.error));
  const cleanWiring = wiringRes.value.sheets[0].svg;
  expect(terminalText(await measure(cleanWiring), motorIr)).toEqual([]);
  const docWiring = parseSvg(cleanWiring);
  const outsideCap = docWiring.querySelector("text[data-outside-connections]");
  expect(outsideCap).not.toBeNull();
  const key = outsideCap.getAttribute("data-terminal-key");
  outsideCap.textContent = `${key} [ +99 ]`;
  expect(terminalText(await measure(docWiring.toString()), motorIr)).toEqual([
    expect.objectContaining({
      kind: "mismatched-outside-connection-count",
      terminal: key,
      printedOutside: 99,
    }),
  ]);
});

function combineTwoWiringViews(svgA, svgB) {
  const docA = parseSvg(svgA),
    docB = parseSvg(svgB);
  const rootA = docA.querySelector("svg"),
    rootB = docB.querySelector("svg");
  const innerA = rootA.querySelector("svg[data-view-format]") ?? rootA;
  const innerB = rootB.querySelector("svg[data-view-format]") ?? rootB;
  const vbA = (innerA.getAttribute("viewBox") ?? "0 0 220 120")
    .split(/\s+/)
    .map(Number);
  const vbB = (innerB.getAttribute("viewBox") ?? "0 0 220 120")
    .split(/\s+/)
    .map(Number);
  const shiftY = vbA[3] + 10;
  const wrapB = docB.createElement("g");
  wrapB.setAttribute("transform", `translate(0 ${shiftY})`);
  for (const child of [...innerB.childNodes]) wrapB.appendChild(child);
  for (const el of wrapB.querySelectorAll("[data-terminal-body]"))
    el.setAttribute(
      "data-terminal-body",
      `b_${el.getAttribute("data-terminal-body")}`,
    );
  for (const el of wrapB.querySelectorAll("[data-terminal-caption-body]"))
    el.setAttribute(
      "data-terminal-caption-body",
      `b_${el.getAttribute("data-terminal-caption-body")}`,
    );
  for (const el of wrapB.querySelectorAll("[data-layout-port]"))
    el.setAttribute(
      "data-layout-port",
      `b_${el.getAttribute("data-layout-port")}`,
    );
  for (const attrName of [
    "data-layout-source-port",
    "data-layout-target-port",
    "data-wiring-landing-for",
  ])
    for (const el of wrapB.querySelectorAll(`[${attrName}]`))
      el.setAttribute(attrName, `b_${el.getAttribute(attrName)}`);
  const w = Math.max(vbA[2], vbB[2]) + 20;
  const h = shiftY + vbB[3] + 20;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">` +
    `<g data-navigation-view="wiring:combined" transform="translate(10 10)">` +
    `${innerA.innerHTML}${wrapB.toString()}</g></svg>`
  );
}

it("#626 finding 1a: opacity 0 and completely clipped selected PS1.+ conductor fail DQ-17", async () => {
  const ps1Uid = motorIr.devices.find((d) => d.designation === "PS1").uid;
  const w1Uid = motorIr.wires.find((w) => w.designation === "W-CTL-001").uid;
  const res1 = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "Wiring visibility probe",
        conductors: ["W-CTL-001", "W-CTL-002"],
      },
    ],
  });
  if (!res1.ok) throw Error(JSON.stringify(res1.error));
  const clean1 = res1.value.sheets[0].svg;
  expect(terminalText(await measure(clean1), motorIr)).toEqual([]);

  // Mutant 1a: selected PS1.+ conductor opacity 0 -> fail.
  const docOpacity = parseSvg(clean1);
  const condOp = docOpacity.querySelector(`[data-wiring-conductor="${w1Uid}"]`);
  expect(condOp).not.toBeNull();
  condOp.setAttribute("opacity", "0");
  expect(terminalText(await measure(docOpacity.toString()), motorIr)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "mismatched-outside-connection-count",
        deviceUid: ps1Uid,
        terminal: "+",
        expectedOutside: 2,
        printedOutside: 1,
      }),
    ]),
  );

  // Mutant 1b: selected PS1.+ conductor completely clipped -> fail.
  const docClip = parseSvg(clean1);
  const clipSvg = docClip.querySelector("svg");
  const defs = docClip.createElement("defs");
  const cp = docClip.createElement("clipPath");
  cp.setAttribute("id", "dq17-clip-zero");
  const rect = docClip.createElement("rect");
  rect.setAttribute("x", "0");
  rect.setAttribute("y", "0");
  rect.setAttribute("width", "0.01");
  rect.setAttribute("height", "0.01");
  cp.appendChild(rect);
  defs.appendChild(cp);
  clipSvg.insertBefore(defs, clipSvg.firstChild);
  docClip
    .querySelector(`[data-wiring-conductor="${w1Uid}"]`)
    .setAttribute("clip-path", "url(#dq17-clip-zero)");
  expect(terminalText(await measure(docClip.toString()), motorIr)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "mismatched-outside-connection-count",
        deviceUid: ps1Uid,
        terminal: "+",
        expectedOutside: 2,
        printedOutside: 1,
      }),
    ]),
  );
});

it("#626 finding 1b: two separated PS1.+ bodies in one wiring view pass with locally correct [+1] and fail with bare '+'", async () => {
  const ps1Uid = motorIr.devices.find((d) => d.designation === "PS1").uid;
  const resA = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "PS1 body A",
        conductors: ["W-CTL-001"],
      },
    ],
  });
  const resB = await renderSchematicPacket(motorIr, {
    format: "schematic-packet-request/0.1",
    index: false,
    views: [
      {
        format: "wiring-view-request/0.1",
        title: "PS1 body B",
        conductors: ["W-CTL-003"],
      },
    ],
  });
  if (!resA.ok || !resB.ok) throw Error("Wiring render failed");
  const combinedCorrect = combineTwoWiringViews(
    resA.value.sheets[0].svg,
    resB.value.sheets[0].svg,
  );
  const gCorrect = await measure(combinedCorrect);
  expect(textBounds(gCorrect)).toEqual([]);
  expect(terminalText(gCorrect, motorIr)).toEqual([]);

  // Same two separated bodies printing bare "+" -> 2 missing-count findings.
  const docBare = parseSvg(combinedCorrect);
  const ps1Caps = [
    ...docBare.querySelectorAll(
      `[data-device-uid="${ps1Uid}"] text[data-terminal-key="+"]`,
    ),
  ];
  expect(ps1Caps).toHaveLength(2);
  for (const cap of ps1Caps) cap.textContent = "+";
  const gBare = await measure(docBare.toString());
  expect(textBounds(gBare)).toEqual([]);
  expect(terminalText(gBare, motorIr)).toEqual([
    expect.objectContaining({
      kind: "missing-outside-connection-count",
      deviceUid: ps1Uid,
      terminal: "+",
      expectedOutside: 1,
      printedOutside: 0,
    }),
    expect.objectContaining({
      kind: "missing-outside-connection-count",
      deviceUid: ps1Uid,
      terminal: "+",
      expectedOutside: 1,
      printedOutside: 0,
    }),
  ]);
});

it("#626 controls: corpus analog-output and signal-loop (0 outside connections) print no [+0], keep both ports and one label per body", async () => {
  for (const name of ["analog-output", "signal-loop"]) {
    for (const flow of ["left-to-right", "top-to-bottom"]) {
      const { svg, ir } = await renderCorpusField(name, flow);
      expect(svg, `${name}/${flow}`).not.toContain("[+0]");
      const doc = parseSvg(svg);
      const xt1Uid = ir.devices.find((d) => d.designation === "XT1")?.uid;
      const xt1Group = doc.querySelector(`[data-device-uid="${xt1Uid}"]`);
      expect(xt1Group, `${name}/${flow} XT1`).not.toBeNull();
      // Pass-through XT1.1 and XT1.2 keep both routing ports (4 circles) and one caption each (2 captions).
      const circles = xt1Group.querySelectorAll(
        "circle[data-loop-terminal],circle[data-terminal-marker='true']",
      );
      const captions = xt1Group.querySelectorAll(
        "text[data-terminal-caption-body]",
      );
      expect(
        circles.length,
        `${name}/${flow} XT1 ports`,
      ).toBeGreaterThanOrEqual(4);
      expect(captions.length, `${name}/${flow} XT1 labels`).toBe(
        new Set([...captions].map((c) => c.getAttribute("data-terminal-key")))
          .size,
      );
      const g = await measure(svg);
      expect(terminalText(g, ir), `${name}/${flow}`).toEqual([]);
    }
  }
});
