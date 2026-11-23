import { compileProject } from "@thermite/compiler";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { prepareCircuitView } from "../src/circuit.js";
import { renderSchematicPacket } from "../src/sheets.js";
import { circuitMark } from "../src/symbols/circuit.js";
import { printableTextMetrics } from "../src/text-metrics.js";
import { paintedShape } from "./circuit-fidelity-oracle.js";

async function corePsuFixture() {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const ir = structuredClone(compiled.ir);
  const ps1 = ir.devices.find((d) => d.designation === "PS1")!;
  const type = ir.deviceTypes.find((t) => t.id === ps1.typeId)!;
  const acInput = ir.functions.find(
    (f) => f.id.deviceUid === ps1.uid && f.id.functionKey === "ac_input",
  )!;
  const dcOutput = ir.functions.find(
    (f) => f.id.deviceUid === ps1.uid && f.id.functionKey === "dc_output",
  )!;
  return { ir, ps1, type, acInput, dcOutput };
}

describe("thermite:dc-supply circuit mark selection (#553)", () => {
  it("marks stock core:psu-24vdc AC input as ac-input and keeps DC output as dc-output", async () => {
    const { type, acInput, dcOutput } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    expect(circuitMark(type, acInput)).toBe("ac-input");
    expect(circuitMark(type, dcOutput)).toBe("dc-output");
  });

  it.each(["left-to-right", "top-to-bottom"] as const)(
    "renders upright ac-input on PS1 L/N face and upright dc-output on +/- face in %s",
    async (flow) => {
      const { ir, ps1, type } = await corePsuFixture();
      type.symbol = "thermite:dc-supply";
      delete type.circuitSymbols;

      const result = await renderSchematicPacket(ir, {
        format: "schematic-packet-request/0.1",
        views: [
          {
            format: "circuit-view-request/0.1",
            title: "PS1 AC input and DC output",
            flow,
            groups: [
              {
                id: "ps1-ac",
                label: "PS1 AC input",
                functions: [
                  { device: { by: "uid", value: ps1.uid }, key: "ac_input" },
                ],
                conductors: [],
              },
              {
                id: "ps1-dc",
                label: "PS1 DC output",
                functions: [
                  { device: { by: "uid", value: ps1.uid }, key: "dc_output" },
                ],
                conductors: [],
              },
            ],
          },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
      const doc = parseHTML(result.value.html).document;

      const acGroup = doc.querySelector(
        '[data-circuit-group="ps1-ac"] [data-function-key="ac_input"]',
      )!;
      expect(
        acGroup.querySelector('[data-circuit-mark="ac-input"]'),
      ).not.toBeNull();
      expect(
        acGroup.querySelector('[data-circuit-mark="dc-output"]'),
      ).toBeNull();
      expect(
        acGroup.querySelectorAll('[data-function-interface="ac-input"] line'),
      ).toHaveLength(2);
      const acOwner = acGroup.closest("[data-device-uid]")!;
      const wave = paintedShape(
        acOwner,
        acGroup.querySelector('[data-circuit-mark="ac-input"] polyline')!,
      ).points;
      expect(wave[0]!.y).toBeCloseTo(wave.at(-1)!.y, 3);
      expect(Math.abs(wave.at(-1)!.x - wave[0]!.x)).toBeGreaterThan(5);

      const dcGroup = doc.querySelector(
        '[data-circuit-group="ps1-dc"] [data-function-key="dc_output"]',
      )!;
      expect(
        dcGroup.querySelector('[data-circuit-mark="dc-output"]'),
      ).not.toBeNull();
      expect(
        dcGroup.querySelector('[data-circuit-mark="ac-input"]'),
      ).toBeNull();
      const dcOwner = dcGroup.closest("[data-device-uid]")!;
      const dcLines = [
        ...dcGroup.querySelectorAll('[data-circuit-mark="dc-output"] line'),
      ].map((e) => paintedShape(dcOwner, e).points);
      expect(dcLines).toHaveLength(4);
      for (const [a, b] of dcLines) expect(a!.y).toBeCloseTo(b!.y, 3);
    },
  );

  it("leaves a dc-supply load unqualified when native port facts do not establish AC", async () => {
    const { type, acInput } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    // 1. Names/keys/description alone never establish AC.
    const unroled = structuredClone(type);
    unroled.description = "480 VAC to 24 VDC power supply";
    for (const t of unroled.terminals) {
      if (t.key === "L" || t.key === "N") {
        delete t.role;
        delete t.rating;
      }
    }
    expect(circuitMark(unroled, acInput)).toBe("load");

    // 2. DC-DC converter input (DC roles or DC voltage_type) stays unqualified.
    const dcInputRoles = structuredClone(unroled);
    dcInputRoles.terminals.find((t) => t.key === "L")!.role =
      "dc_positive_input";
    dcInputRoles.terminals.find((t) => t.key === "N")!.role = "dc_return_input";
    expect(circuitMark(dcInputRoles, acInput)).toBe("load");

    const dcInputRating = structuredClone(unroled);
    dcInputRating.terminals.find((t) => t.key === "L")!.rating = {
      voltage_type: "DC",
      nominal_voltage: 48,
    };
    dcInputRating.terminals.find((t) => t.key === "N")!.rating = {
      voltage_type: "DC",
      nominal_voltage: 48,
    };
    expect(circuitMark(dcInputRating, acInput)).toBe("load");

    // 3. Partial AC roles do not establish AC.
    const partialRoles = structuredClone(type);
    partialRoles.terminals.find((t) => t.key === "N")!.role = "unknown";
    expect(circuitMark(partialRoles, acInput)).toBe("load");

    // 4. Contradictory AC roles + DC rating do not establish AC.
    const contradictory = structuredClone(type);
    contradictory.terminals.find((t) => t.key === "L")!.rating = {
      voltage_type: "DC",
      nominal_voltage: 24,
    };
    expect(circuitMark(contradictory, acInput)).toBe("load");

    // 5. Explicit AC rating or line-to-line AC roles establish ac-input.
    const acRated = structuredClone(unroled);
    acRated.terminals.find((t) => t.key === "L")!.rating = {
      voltage_type: "AC",
      nominal_voltage: 120,
    };
    acRated.terminals.find((t) => t.key === "N")!.rating = {
      voltage_type: "AC",
      nominal_voltage: 120,
    };
    expect(circuitMark(acRated, acInput)).toBe("ac-input");

    const lineToLine = structuredClone(unroled);
    lineToLine.terminals.find((t) => t.key === "L")!.role = "ac_line_input";
    lineToLine.terminals.find((t) => t.key === "N")!.role = "ac_line_input";
    expect(circuitMark(lineToLine, acInput)).toBe("ac-input");

    // 6. Explicit circuitSymbols still overrides profile defaults.
    const explicitLoad = structuredClone(type);
    explicitLoad.circuitSymbols = { ac_input: "load" };
    expect(circuitMark(explicitLoad, acInput)).toBe("load");

    const explicitAc = structuredClone(unroled);
    explicitAc.circuitSymbols = { ac_input: "ac-input" };
    expect(circuitMark(explicitAc, acInput)).toBe("ac-input");
  });

  it("handles 3-port dc-supply loads and AC-declared dc-supply sources honestly", async () => {
    const { type, ps1, dcOutput } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    // 3-port load without AC roles stays unqualified "load".
    const threePort = structuredClone(type);
    threePort.terminals.push({ key: "L1" }, { key: "L2" }, { key: "L3" });
    const load3 = {
      id: { deviceUid: ps1.uid, functionKey: "ac_in_3p" },
      kind: "load" as const,
      terminals: ["L1", "L2", "L3"].map((terminalKey) => ({
        deviceUid: ps1.uid,
        terminalKey,
      })),
    };
    expect(circuitMark(threePort, load3)).toBe("load");

    // 3-port load with three-phase input roles gets "ac-input".
    threePort.terminals.find((t) => t.key === "L1")!.role = "phase_1_input";
    threePort.terminals.find((t) => t.key === "L2")!.role = "phase_2_input";
    threePort.terminals.find((t) => t.key === "L3")!.role = "phase_3_input";
    expect(circuitMark(threePort, load3)).toBe("ac-input");

    // 2-port source with unroled terminals keeps "dc-output" on thermite:dc-supply,
    // but an explicitly AC-declared 2-port source falls back to generic "source".
    const unroledSource = structuredClone(type);
    for (const t of unroledSource.terminals) {
      if (t.key === "+" || t.key === "-") {
        delete t.role;
        delete t.rating;
      }
    }
    expect(circuitMark(unroledSource, dcOutput)).toBe("dc-output");

    const acSource = structuredClone(unroledSource);
    acSource.terminals.find((t) => t.key === "+")!.rating = {
      voltage_type: "AC",
      nominal_voltage: 24,
    };
    expect(circuitMark(acSource, dcOutput)).toBe("source");

    // Earth or auxiliary terminals on a 2-port source fall back to generic "source".
    const peSource = structuredClone(unroledSource);
    peSource.terminals.find((t) => t.key === "+")!.role = "dc_positive_output";
    peSource.terminals.find((t) => t.key === "-")!.role = "protective_earth";
    expect(circuitMark(peSource, dcOutput)).toBe("source");

    const auxSource = structuredClone(unroledSource);
    auxSource.terminals.find((t) => t.key === "+")!.role = "aux";
    auxSource.terminals.find((t) => t.key === "-")!.role = "aux";
    expect(circuitMark(auxSource, dcOutput)).toBe("source");
  });

  it("never derives AC input from earth/ground, auxiliary, or partial terminal ratings (#553 review)", async () => {
    const { ir, type, ps1, acInput } = await corePsuFixture();
    delete type.circuitSymbols;

    const makeLoad = (
      symbol: "thermite:dc-supply" | "iec:dc-power-supply",
      terminals: Array<{
        key: string;
        role?: string;
        rating?: { voltage_type?: "AC" | "DC"; nominal_voltage?: number };
      }>,
    ) => {
      const t = structuredClone(type);
      t.symbol = symbol;
      t.terminals = terminals;
      const fn = {
        id: { deviceUid: ps1.uid, functionKey: "face" },
        kind: "load" as const,
        terminals: terminals.map((p) => ({
          deviceUid: ps1.uid,
          terminalKey: p.key,
        })),
      };
      return { t, fn };
    };

    // Reviewer 3-terminal probe: two unrated pins + AC-rated protective_earth -> "load".
    for (const earthRole of [
      "protective_earth",
      "pe",
      "PE",
      "functional_earth",
      "ground",
      "gnd",
      "chassis_ground",
    ]) {
      const probe = makeLoad("iec:dc-power-supply", [
        { key: "1" },
        { key: "2" },
        { key: "3", role: earthRole, rating: { voltage_type: "AC" } },
      ]);
      expect(circuitMark(probe.t, probe.fn)).toBe("load");
    }

    // Reviewer one-rated 3-terminal probe: one AC-rated phase input + two unspecified pins -> "load".
    const oneRated = makeLoad("thermite:dc-supply", [
      { key: "1", role: "phase_1_input", rating: { voltage_type: "AC" } },
      { key: "2" },
      { key: "3" },
    ]);
    expect(circuitMark(oneRated.t, oneRated.fn)).toBe("load");

    // Partial ratings (2-terminal or 3-terminal without earth role) stay "load".
    const partialTwo = makeLoad("thermite:dc-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2" },
    ]);
    expect(circuitMark(partialTwo.t, partialTwo.fn)).toBe("load");

    const partialThree = makeLoad("thermite:dc-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "3" },
    ]);
    expect(circuitMark(partialThree.t, partialThree.fn)).toBe("load");

    // Earth terminal never counts toward the terminal count needed for rating-based AC.
    const oneLineAndPe = makeLoad("thermite:dc-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", role: "protective_earth", rating: { voltage_type: "AC" } },
    ]);
    expect(circuitMark(oneLineAndPe.t, oneLineAndPe.fn)).toBe("load");

    const oneLineTwoEarths = makeLoad("thermite:dc-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", role: "protective_earth", rating: { voltage_type: "AC" } },
      { key: "3", role: "functional_earth", rating: { voltage_type: "AC" } },
    ]);
    expect(circuitMark(oneLineTwoEarths.t, oneLineTwoEarths.fn)).toBe("load");

    // Auxiliary / non-power terminals never contribute AC evidence.
    const withAux2 = makeLoad("thermite:dc-supply", [
      { key: "1", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "2", role: "aux", rating: { voltage_type: "AC" } },
    ]);
    expect(circuitMark(withAux2.t, withAux2.fn)).toBe("load");

    const withAux3 = makeLoad("thermite:dc-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "3", role: "auxiliary", rating: { voltage_type: "AC" } },
    ]);
    expect(circuitMark(withAux3.t, withAux3.fn)).toBe("load");

    const withShield = makeLoad("thermite:dc-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", role: "shield", rating: { voltage_type: "AC" } },
    ]);
    expect(circuitMark(withShield.t, withShield.fn)).toBe("load");

    // Valid: all current-carrying terminals AC-rated with a separate PE -> "ac-input".
    const twoRatedAndPe = makeLoad("iec:dc-power-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "3", role: "protective_earth" },
    ]);
    expect(circuitMark(twoRatedAndPe.t, twoRatedAndPe.fn)).toBe("ac-input");

    const twoRatedAndRatedPe = makeLoad("iec:dc-power-supply", [
      { key: "1", rating: { voltage_type: "AC" } },
      { key: "2", rating: { voltage_type: "AC" } },
      { key: "3", role: "pe", rating: { voltage_type: "AC" } },
    ]);
    expect(circuitMark(twoRatedAndRatedPe.t, twoRatedAndRatedPe.fn)).toBe(
      "ac-input",
    );

    // End-to-end render of the reviewer's 3-terminal probe prints no AC wave in either flow.
    const probeIr = structuredClone(ir);
    const probeType = probeIr.deviceTypes.find((t) => t.id === type.id)!;
    probeType.symbol = "iec:dc-power-supply";
    delete probeType.circuitSymbols;
    probeType.terminals = [
      { key: "1" },
      { key: "2" },
      { key: "3", role: "protective_earth", rating: { voltage_type: "AC" } },
    ];
    const probeFn = probeIr.functions.find(
      (f) =>
        f.id.deviceUid === ps1.uid &&
        f.id.functionKey === acInput.id.functionKey,
    )!;
    probeFn.terminals = ["1", "2", "3"].map((terminalKey) => ({
      deviceUid: ps1.uid,
      terminalKey,
    }));
    for (const flow of ["left-to-right", "top-to-bottom"] as const) {
      const rendered = await renderSchematicPacket(probeIr, {
        format: "schematic-packet-request/0.1",
        views: [
          {
            format: "circuit-view-request/0.1",
            title: "Rated-earth probe",
            flow,
            groups: [
              {
                id: "rated-earth",
                label: "Rated earth",
                functions: [
                  { device: { by: "uid", value: ps1.uid }, key: "ac_input" },
                ],
                conductors: [],
              },
            ],
          },
        ],
      });
      if (!rendered.ok) throw new Error(rendered.error.message);
      const doc = parseHTML(rendered.value.html).document;
      expect(doc.querySelector('[data-circuit-mark="ac-input"]')).toBeNull();
      expect(doc.querySelector('[data-circuit-mark="load"]')).not.toBeNull();
    }
  });

  it("keeps wrapped related-function footer lines in top-to-bottom reading order inside framed LTR blocks", async () => {
    const { ir, ps1, type } = await corePsuFixture();
    type.symbol = "thermite:dc-supply";
    delete type.circuitSymbols;

    const appearances = new Map<string, string[]>([
      [
        JSON.stringify([ps1.uid, "dc_output"]),
        [
          "PS1 DC output and PLC supply",
          "Start NO pushbutton input",
          "Stop NC pushbutton input",
          "Discharge PNP sensor via CBL1, JB1 and TB1",
          "PLC DO0 through OL1 NC to K1 coil",
          "PLC DO1 status indicator",
        ],
      ],
    ]);

    const view = await prepareCircuitView(
      ir,
      {
        format: "circuit-view-request/0.1",
        title: "PS1 input feed",
        flow: "left-to-right",
        groups: [
          {
            id: "ps1-ac",
            label: "PS1 AC input",
            functions: [
              { device: { by: "uid", value: ps1.uid }, key: "ac_input" },
            ],
            conductors: [],
          },
        ],
      },
      appearances,
    );

    const doc = parseHTML(`<svg>${view.groups[0]!.content}</svg>`).document;
    const body = doc.querySelector(
      `[data-device-uid="${ps1.uid}"] [data-layout-height]`,
    )!;
    const height = Number(body.getAttribute("data-layout-height"));
    const footerTexts = [...body.children]
      .filter((el) => el.tagName.toLowerCase() === "text")
      .map((el) => ({
        text: el.textContent ?? "",
        y: Number(el.getAttribute("y")),
      }));

    expect(footerTexts.length).toBeGreaterThanOrEqual(3);
    expect(footerTexts[0]!.text).toMatch(/^\+ \/ -:/u);
    for (let i = 1; i < footerTexts.length; i++) {
      expect(footerTexts[i]!.y).toBeGreaterThan(footerTexts[i - 1]!.y);
    }
    const last = footerTexts.at(-1)!;
    const m = printableTextMetrics(last.text, 2.5);
    // Clear of bottom device frame stroke (height - 0.2) by at least 1 mm.
    expect(last.y - m.bottom).toBeLessThanOrEqual(height - 1.2);
  });
});
