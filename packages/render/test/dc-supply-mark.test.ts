import { compileProject, lockProject } from "@thermite/compiler";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Reviewer 3-terminal probe: two unrated pins + AC-rated earth role -> "load".
    for (const earthRole of [
      "protective_earth",
      "pe",
      "PE",
      "pE",
      "functional_earth",
      "fe",
      "earth",
      "chassis_ground",
      "chassis-earth",
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

  it("classifies earth only via the closed exact-match role set or IR protective_earth potential (#553 round 4)", async () => {
    const { ir, type, ps1, acInput } = await corePsuFixture();
    delete type.circuitSymbols;

    // 1. Closed earth roles (case- and punctuation-insensitive exact matches) are excluded.
    for (const role of [
      "protective_earth",
      "protectiveEarth",
      "ProtectiveEarth",
      "Protective Earth",
      "pe",
      "PE",
      "pE",
      "functional_earth",
      "functionalEarth",
      "Functional Earth",
      "fe",
      "FE",
      "earth",
      "Earth",
      "chassis_ground",
      "chassis-ground",
      "chassisGround",
      "chassis_earth",
      "chassis-earth",
      "chassisEarth",
    ]) {
      const camel = structuredClone(type);
      camel.symbol = "thermite:dc-supply";
      camel.terminals = [
        { key: "A", rating: { voltage_type: "AC" } },
        { key: "B", role, rating: { voltage_type: "AC" } },
      ];
      const fn = {
        id: { deviceUid: ps1.uid, functionKey: "face" },
        kind: "load" as const,
        terminals: ["A", "B"].map((terminalKey) => ({
          deviceUid: ps1.uid,
          terminalKey,
        })),
      };
      expect(circuitMark(camel, fn), role).toBe("load");

      // 2-terminal source with an earth role falls back to generic "source".
      const srcFn = {
        id: { deviceUid: ps1.uid, functionKey: "dc_output" },
        kind: "source" as const,
        terminals: ["A", "B"].map((terminalKey) => ({
          deviceUid: ps1.uid,
          terminalKey,
        })),
      };
      const camelSrc = structuredClone(camel);
      camelSrc.terminals[0] = { key: "A", role: "dc_positive_output" };
      expect(circuitMark(camelSrc, srcFn), `source ${role}`).toBe("source");
    }

    // 2. Non-earth roles (including supplyGroundReturn, ground, gnd) are NOT excluded as earth.
    for (const returnRole of [
      "supplyGroundReturn",
      "ground",
      "gnd",
      "return",
    ]) {
      const retLoad = structuredClone(type);
      retLoad.symbol = "thermite:dc-supply";
      retLoad.terminals = [
        { key: "A", role: "ac_line_input", rating: { voltage_type: "AC" } },
        { key: "B", role: returnRole, rating: { voltage_type: "AC" } },
      ];
      const fn = {
        id: { deviceUid: ps1.uid, functionKey: "face" },
        kind: "load" as const,
        terminals: ["A", "B"].map((terminalKey) => ({
          deviceUid: ps1.uid,
          terminalKey,
        })),
      };
      expect(circuitMark(retLoad, fn), returnRole).toBe("ac-input");
    }

    // 3. Compiled IR protective_earth potential anchor without a role name excludes the terminal.
    const potIr = structuredClone(ir);
    const potType = potIr.deviceTypes.find((t) => t.id === type.id)!;
    potType.symbol = "thermite:dc-supply";
    delete potType.circuitSymbols;
    potType.terminals = [
      { key: "A", rating: { voltage_type: "AC" } },
      { key: "B", rating: { voltage_type: "AC" } },
    ];
    potIr.terminals = potIr.terminals.filter((t) => t.id.deviceUid !== ps1.uid);
    potIr.terminals.push(
      {
        id: { deviceUid: ps1.uid, terminalKey: "A" },
        rating: { voltage_type: "AC" },
        source: type.source,
      },
      {
        id: { deviceUid: ps1.uid, terminalKey: "B" },
        rating: { voltage_type: "AC" },
        source: type.source,
      },
    );
    const peTerm = { deviceUid: ps1.uid, terminalKey: "B" };
    potIr.potentials.push({
      uid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "PE",
      electrical: { polarity: "protective_earth" },
      aliases: [],
      terminal: peTerm,
      netId: "net:pe",
      terminalSource: type.source,
      source: type.source,
    });
    const potFn = potIr.functions.find(
      (f) =>
        f.id.deviceUid === ps1.uid &&
        f.id.functionKey === acInput.id.functionKey,
    )!;
    potFn.terminals = ["A", "B"].map((terminalKey) => ({
      deviceUid: ps1.uid,
      terminalKey,
    }));
    expect(circuitMark(potType, potFn, { ir: potIr })).toBe("load");
    for (const flow of ["left-to-right", "top-to-bottom"] as const) {
      const rendered = await renderSchematicPacket(potIr, {
        format: "schematic-packet-request/0.1",
        views: [
          {
            format: "circuit-view-request/0.1",
            title: "Potential-anchored PE probe",
            flow,
            groups: [
              {
                id: "pe-potential",
                label: "pe-potential",
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

    // 4. Drawing marks NEVER classify earth: an "earth" bus mark on a separate function
    // assigns no earth role to unroled, AC-return, or DC-return terminals.
    const unroled = structuredClone(type);
    unroled.symbol = "thermite:dc-supply";
    unroled.terminals = [
      { key: "A", rating: { voltage_type: "AC" } },
      { key: "B", rating: { voltage_type: "AC" } },
    ];
    unroled.functions = [
      ...unroled.functions,
      {
        key: "bond",
        kind: "bus",
        terminalKeys: ["B"],
        source: type.source,
      },
    ];
    unroled.circuitSymbols = { bond: "earth" };
    const unroledLoad = {
      id: { deviceUid: ps1.uid, functionKey: "face" },
      kind: "load" as const,
      terminals: ["A", "B"].map((terminalKey) => ({
        deviceUid: ps1.uid,
        terminalKey,
      })),
    };
    expect(circuitMark(unroled, unroledLoad)).toBe("ac-input");

    const acReturnBus = structuredClone(unroled);
    acReturnBus.terminals = [
      { key: "A", role: "ac_line_input", rating: { voltage_type: "AC" } },
      { key: "B", role: "ac_input_return", rating: { voltage_type: "AC" } },
    ];
    expect(circuitMark(acReturnBus, unroledLoad)).toBe("ac-input");

    const dcReturnBus = structuredClone(unroled);
    dcReturnBus.terminals = [
      { key: "A", role: "dc_positive_output", rating: { voltage_type: "DC" } },
      { key: "B", role: "dc_return_output", rating: { voltage_type: "DC" } },
    ];
    const dcSrc = {
      id: { deviceUid: ps1.uid, functionKey: "face" },
      kind: "source" as const,
      terminals: ["A", "B"].map((terminalKey) => ({
        deviceUid: ps1.uid,
        terminalKey,
      })),
    };
    expect(circuitMark(dcReturnBus, dcSrc)).toBe("dc-output");
  });

  it("ignores earth terminals completely in both directions: neither establishes nor vetoes AC (#553 round 4)", async () => {
    const { ir, type, ps1 } = await corePsuFixture();
    delete type.circuitSymbols;

    const makeLoad = (
      terminals: Array<{
        key: string;
        role?: string;
        rating?: { voltage_type?: "AC" | "DC"; nominal_voltage?: number };
      }>,
    ) => {
      const t = structuredClone(type);
      t.symbol = "thermite:dc-supply";
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

    // Complete AC role pair + DC-rated protective_earth -> "ac-input" (reviewer's dc-rated-earth).
    const dcRatedPe = makeLoad([
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "protective_earth", rating: { voltage_type: "DC" } },
    ]);
    expect(circuitMark(dcRatedPe.t, dcRatedPe.fn)).toBe("ac-input");

    // Two AC-rated current-carrying pins + DC-rated camelCase protectiveEarth -> "ac-input".
    const dcRatedCamelPe = makeLoad([
      { key: "L", rating: { voltage_type: "AC" } },
      { key: "N", rating: { voltage_type: "AC" } },
      { key: "PE", role: "protectiveEarth", rating: { voltage_type: "DC" } },
    ]);
    expect(circuitMark(dcRatedCamelPe.t, dcRatedCamelPe.fn)).toBe("ac-input");

    // Complete AC role pair + DC-rated functional_earth -> "ac-input".
    const dcRatedFe = makeLoad([
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "FE", role: "functional_earth", rating: { voltage_type: "DC" } },
    ]);
    expect(circuitMark(dcRatedFe.t, dcRatedFe.fn)).toBe("ac-input");

    // Closed set: "dc_earth" is NOT in the closed earth set, so its DC role/rating vetoes AC.
    const dcEarthNotInSet = makeLoad([
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "PE", role: "dc_earth", rating: { voltage_type: "DC" } },
    ]);
    expect(circuitMark(dcEarthNotInSet.t, dcEarthNotInSet.fn)).toBe("load");

    // Complete AC role pair + unroled DC-rated terminal anchored to a protective_earth potential -> "ac-input".
    const potIr = structuredClone(ir);
    potIr.potentials.push({
      uid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "PE",
      electrical: { polarity: "protective_earth" },
      aliases: [],
      terminal: { deviceUid: ps1.uid, terminalKey: "E" },
      netId: "net:pe-dc",
      terminalSource: type.source,
      source: type.source,
    });
    const canonicalPe = makeLoad([
      { key: "L", role: "ac_line_input" },
      { key: "N", role: "ac_input_return" },
      { key: "E", rating: { voltage_type: "DC" } },
    ]);
    expect(circuitMark(canonicalPe.t, canonicalPe.fn, { ir: potIr })).toBe(
      "ac-input",
    );
  });

  it("reproduces every round-2 and round-3 reviewer probe on a compiled project in both flows (#553 round 4)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thermite-ps1mark-r4-"));
    try {
      const ac = { rating: { voltage_type: "AC" } };
      const dc = { rating: { voltage_type: "DC" } };
      const line = { ...ac, role: "ac_line_input" };
      const neutral = { ...ac, role: "ac_input_return" };
      const positive = { ...dc, role: "dc_positive_output" };
      const negative = { ...dc, role: "dc_return_output" };
      const earthBus = {
        extraFunctions: { bond: { kind: "bus", terminals: ["B"] } },
        circuitSymbols: { bond: "earth" },
      };

      const probes: Array<{
        id: string;
        symbol?: string;
        kind?: "load" | "source";
        terminals: Record<string, unknown>;
        functionTerminals?: string[];
        extraFunctions?: Record<string, unknown>;
        circuitSymbols?: Record<string, string>;
        pePotentialTerminal?: string;
        expectedMark: string;
      }> = [
        {
          id: "earth-alias-1",
          terminals: { A: ac, B: { ...ac, role: "functional_earth" } },
          expectedMark: "load",
        },
        {
          id: "earth-alias-2",
          symbol: "iec:dc-power-supply",
          terminals: { A: ac, B: { ...ac, role: "PE" } },
          expectedMark: "load",
        },
        {
          id: "earth-alias-3",
          terminals: { A: ac, B: { ...ac, role: "chassis-ground" } },
          expectedMark: "load",
        },
        {
          id: "earth-alias-4",
          symbol: "iec:dc-power-supply",
          terminals: { A: ac, B: { ...ac, role: "Protective Earth" } },
          expectedMark: "load",
        },
        {
          id: "earth-alias-5",
          terminals: { A: ac, B: { ...ac, role: "protectiveEarth" } },
          expectedMark: "load",
        },
        {
          id: "neutral-only-ac-rated",
          symbol: "iec:dc-power-supply",
          terminals: {
            L: { role: "ac_line_input" },
            N: { role: "neutral", rating: { voltage_type: "AC" } },
            PE: { role: "protective_earth" },
          },
          expectedMark: "load",
        },
        {
          id: "complete-ac-roles",
          terminals: {
            L: { role: "ac_line_input" },
            N: { role: "ac_neutral", rating: { voltage_type: "AC" } },
            PE: { role: "protective_earth" },
          },
          expectedMark: "ac-input",
        },
        {
          id: "all-ac-alternate-pe",
          symbol: "iec:dc-power-supply",
          terminals: {
            L: ac,
            N: ac,
            PE: { role: "Functional Earth" },
          },
          expectedMark: "ac-input",
        },
        {
          id: "dc-rated-earth",
          terminals: {
            L: { role: "ac_line_input" },
            N: { role: "ac_input_return" },
            PE: { role: "protective_earth", rating: { voltage_type: "DC" } },
          },
          expectedMark: "ac-input",
        },
        {
          id: "three-phase-separate-pe",
          symbol: "iec:dc-power-supply",
          terminals: {
            A: { role: "phase_1_input" },
            B: { role: "phase_2_input" },
            C: { role: "phase_3_input" },
            PE: { role: "protective_earth" },
          },
          functionTerminals: ["A", "B", "C"],
          expectedMark: "ac-input",
        },
        {
          id: "two-terminal-pe-source",
          symbol: "iec:dc-power-supply",
          kind: "source",
          terminals: {
            D: { role: "dc_positive_output" },
            PE: { role: "protective_earth" },
          },
          expectedMark: "source",
        },
        {
          id: "two-terminal-aux-source",
          kind: "source",
          terminals: {
            D: { role: "dc_positive_output" },
            A: { role: "aux" },
          },
          expectedMark: "source",
        },
        {
          id: "camel-functional-earth",
          terminals: { A: ac, B: { ...ac, role: "functionalEarth" } },
          expectedMark: "load",
        },
        {
          id: "camel-chassis-ground",
          terminals: { A: ac, B: { ...ac, role: "chassisGround" } },
          expectedMark: "load",
        },
        {
          id: "camel-supply-ground-return",
          terminals: {
            A: line,
            B: {
              ...ac,
              role: "supplyGroundReturn",
              description: "Supply ground return",
            },
          },
          expectedMark: "ac-input",
        },
        {
          id: "supply-ground-description-control",
          terminals: {
            A: line,
            B: { ...ac, role: "return", description: "Supply ground return" },
          },
          expectedMark: "ac-input",
        },
        {
          id: "ground-return-ac-rated",
          terminals: { A: line, B: { ...ac, role: "ground" } },
          expectedMark: "ac-input",
        },
        {
          id: "gnd-return-ac-rated",
          terminals: { A: line, B: { ...ac, role: "gnd" } },
          expectedMark: "ac-input",
        },
        {
          id: "earth-bus-unroled",
          terminals: { A: ac, B: ac },
          ...earthBus,
          expectedMark: "ac-input",
        },
        {
          id: "earth-bus-ac-return",
          terminals: { A: line, B: neutral },
          ...earthBus,
          expectedMark: "ac-input",
        },
        {
          id: "earth-bus-dc-return",
          kind: "source",
          terminals: { A: positive, B: negative },
          ...earthBus,
          expectedMark: "dc-output",
        },
        {
          id: "explicit-ac-binding",
          terminals: { A: line, B: neutral },
          ...earthBus,
          circuitSymbols: { bond: "earth", face: "ac-input" },
          expectedMark: "ac-input",
        },
        {
          id: "mixed-case-pe-source",
          kind: "source",
          terminals: { A: positive, B: { role: "pE" } },
          expectedMark: "source",
        },
        {
          id: "mixed-case-pe-load",
          terminals: { A: ac, B: { ...ac, role: "pE" } },
          expectedMark: "load",
        },
        {
          id: "ac-with-rated-aux",
          terminals: { A: line, B: neutral, C: { ...ac, role: "aux" } },
          expectedMark: "load",
        },
        {
          id: "ac-with-dc-conflict",
          terminals: {
            A: line,
            B: { ...dc, role: "ac_input_return" },
          },
          expectedMark: "load",
        },
        {
          id: "pe-potential-anchored",
          terminals: { A: ac, B: ac },
          pePotentialTerminal: "B",
          expectedMark: "load",
        },
      ];

      await mkdir(join(dir, "library"), { recursive: true });
      await writeFile(
        join(dir, "system.json"),
        JSON.stringify({
          format: "electrical-system/0.1",
          project: { name: "PS1MARK Round 4 Probes" },
          sources: ["source.json"],
          libraries: [{ name: "r4-probes", version: "0.1.0", path: "library" }],
        }),
      );
      await writeFile(
        join(dir, "library/library.json"),
        JSON.stringify({
          name: "r4-probes",
          version: "0.1.0",
          sources: ["types.json"],
        }),
      );
      await writeFile(
        join(dir, "library/types.json"),
        JSON.stringify({
          types: probes.map((p) => ({
            kind: "device_type",
            id: `r4-probes:${p.id}`,
            symbol: p.symbol ?? "thermite:dc-supply",
            terminals: p.terminals,
            functions: {
              face: {
                kind: p.kind ?? "load",
                terminals: p.functionTerminals ?? Object.keys(p.terminals),
              },
              ...(p.extraFunctions ?? {}),
            },
            ...(p.circuitSymbols ? { circuitSymbols: p.circuitSymbols } : {}),
          })),
        }),
      );
      const objects: unknown[] = probes.map((p, idx) => ({
        kind: "device",
        uid: `f4000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        designation: `P${idx + 1}`,
        type: `r4-probes:${p.id}`,
      }));
      for (const [idx, p] of probes.entries()) {
        if (p.pePotentialTerminal) {
          objects.push({
            kind: "potential",
            uid: `f5000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
            name: `PE_${idx + 1}`,
            at: { device: `P${idx + 1}`, terminal: p.pePotentialTerminal },
            electrical: { polarity: "protective_earth" },
          });
        }
      }
      await writeFile(join(dir, "source.json"), JSON.stringify({ objects }));
      const locked = await lockProject(dir);
      expect(locked.ok, JSON.stringify(locked)).toBe(true);
      const compiled = await compileProject(dir);
      expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
      if (!compiled.ok) return;

      for (const flow of ["left-to-right", "top-to-bottom"] as const) {
        const rendered = await renderSchematicPacket(compiled.ir, {
          format: "schematic-packet-request/0.1",
          views: [
            {
              format: "circuit-view-request/0.1",
              title: `PS1MARK round-4 probes (${flow})`,
              flow,
              groups: probes.map((p, idx) => ({
                id: p.id,
                label: p.id,
                functions: [
                  {
                    device: {
                      by: "uid" as const,
                      value: `f4000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
                    },
                    key: "face",
                  },
                ],
                conductors: [],
              })),
            },
          ],
        });
        expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
        if (!rendered.ok) return;
        const doc = parseHTML(rendered.value.html).document;
        for (const p of probes) {
          const group = doc.querySelector(
            `[data-circuit-group="${p.id}"] [data-function-key="face"]`,
          );
          expect(group, `${flow} ${p.id} rendered group`).not.toBeNull();
          const marks = [...group!.querySelectorAll("[data-circuit-mark]")].map(
            (el) => el.getAttribute("data-circuit-mark"),
          );
          expect(marks, `${flow} ${p.id}`).toEqual([p.expectedMark]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes every dc-supply role class identically across snake, camel, Pascal, kebab and spaced spellings (#553 round 5)", async () => {
    const { type, ps1 } = await corePsuFixture();
    delete type.circuitSymbols;

    const ac = { rating: { voltage_type: "AC" as const } };
    const evalMark = (
      kind: "load" | "source",
      terminals: Array<{
        key: string;
        role?: string;
        rating?: { voltage_type?: "AC" | "DC" };
      }>,
    ) => {
      const t = structuredClone(type);
      t.symbol = "thermite:dc-supply";
      t.terminals = terminals;
      return circuitMark(t, {
        id: { deviceUid: ps1.uid, functionKey: "face" },
        kind,
        terminals: terminals.map((p) => ({
          deviceUid: ps1.uid,
          terminalKey: p.key,
        })),
      });
    };

    type RoleSpellingRow = {
      roleClass: string;
      kind: "load" | "source";
      expected: string;
      snake: Array<{
        key: string;
        role?: string;
        rating?: { voltage_type?: "AC" | "DC" };
      }>;
      variants: Record<
        "camel" | "pascal" | "kebab" | "spaced",
        Array<{
          key: string;
          role?: string;
          rating?: { voltage_type?: "AC" | "DC" };
        }>
      >;
    };

    const table: RoleSpellingRow[] = [
      {
        roleClass: "ac single-phase pair (line + input_return)",
        kind: "load",
        expected: "ac-input",
        snake: [
          { key: "L", role: "ac_line_input" },
          { key: "N", role: "ac_input_return" },
        ],
        variants: {
          camel: [
            { key: "L", role: "acLineInput" },
            { key: "N", role: "acInputReturn" },
          ],
          pascal: [
            { key: "L", role: "AcLineInput" },
            { key: "N", role: "AcInputReturn" },
          ],
          kebab: [
            { key: "L", role: "ac-line-input" },
            { key: "N", role: "ac-input-return" },
          ],
          spaced: [
            { key: "L", role: "AC Line Input" },
            { key: "N", role: "AC Input Return" },
          ],
        },
      },
      {
        roleClass: "ac single-phase pair (line + ac_neutral)",
        kind: "load",
        expected: "ac-input",
        snake: [
          { key: "L", role: "ac_line_input" },
          { key: "N", role: "ac_neutral" },
        ],
        variants: {
          camel: [
            { key: "L", role: "acLineInput" },
            { key: "N", role: "acNeutral" },
          ],
          pascal: [
            { key: "L", role: "AcLineInput" },
            { key: "N", role: "AcNeutral" },
          ],
          kebab: [
            { key: "L", role: "ac-line-input" },
            { key: "N", role: "ac-neutral" },
          ],
          spaced: [
            { key: "L", role: "AC Line Input" },
            { key: "N", role: "AC Neutral" },
          ],
        },
      },
      {
        roleClass: "three-phase numeric input (phase_1/2/3_input)",
        kind: "load",
        expected: "ac-input",
        snake: [
          { key: "L1", role: "phase_1_input" },
          { key: "L2", role: "phase_2_input" },
          { key: "L3", role: "phase_3_input" },
        ],
        variants: {
          camel: [
            { key: "L1", role: "phase1Input" },
            { key: "L2", role: "phase2Input" },
            { key: "L3", role: "phase3Input" },
          ],
          pascal: [
            { key: "L1", role: "Phase1Input" },
            { key: "L2", role: "Phase2Input" },
            { key: "L3", role: "Phase3Input" },
          ],
          kebab: [
            { key: "L1", role: "phase-1-input" },
            { key: "L2", role: "phase-2-input" },
            { key: "L3", role: "phase-3-input" },
          ],
          spaced: [
            { key: "L1", role: "Phase 1 Input" },
            { key: "L2", role: "Phase 2 Input" },
            { key: "L3", role: "Phase 3 Input" },
          ],
        },
      },
      {
        roleClass: "three-phase u/v/w input (phase_u/v/w_input)",
        kind: "load",
        expected: "ac-input",
        snake: [
          { key: "U", role: "phase_u_input" },
          { key: "V", role: "phase_v_input" },
          { key: "W", role: "phase_w_input" },
        ],
        variants: {
          camel: [
            { key: "U", role: "phaseUInput" },
            { key: "V", role: "phaseVInput" },
            { key: "W", role: "phaseWInput" },
          ],
          pascal: [
            { key: "U", role: "PhaseUInput" },
            { key: "V", role: "PhaseVInput" },
            { key: "W", role: "PhaseWInput" },
          ],
          kebab: [
            { key: "U", role: "phase-u-input" },
            { key: "V", role: "phase-v-input" },
            { key: "W", role: "phase-w-input" },
          ],
          spaced: [
            { key: "U", role: "Phase U Input" },
            { key: "V", role: "Phase V Input" },
            { key: "W", role: "Phase W Input" },
          ],
        },
      },
      {
        roleClass: "dc veto on AC-rated load (dc_return / dcReturn)",
        kind: "load",
        expected: "load",
        snake: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "dc_return", ...ac },
        ],
        variants: {
          camel: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "dcReturn", ...ac },
          ],
          pascal: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "DcReturn", ...ac },
          ],
          kebab: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "dc-return", ...ac },
          ],
          spaced: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "DC Return", ...ac },
          ],
        },
      },
      {
        roleClass: "aux veto on AC-rated load (aux_input / auxInput)",
        kind: "load",
        expected: "load",
        snake: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "A", role: "aux_input", ...ac },
        ],
        variants: {
          camel: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "A", role: "auxInput", ...ac },
          ],
          pascal: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "A", role: "AuxInput", ...ac },
          ],
          kebab: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "A", role: "aux-input", ...ac },
          ],
          spaced: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "A", role: "Aux Input", ...ac },
          ],
        },
      },
      {
        roleClass: "non-power no_connection veto on AC-rated load",
        kind: "load",
        expected: "load",
        snake: [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
          { key: "NC", role: "no_connection", ...ac },
        ],
        variants: {
          camel: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "NC", role: "noConnection", ...ac },
          ],
          pascal: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "NC", role: "NoConnection", ...ac },
          ],
          kebab: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "NC", role: "no-connection", ...ac },
          ],
          spaced: [
            { key: "L", role: "ac_line_input", ...ac },
            { key: "N", role: "ac_input_return", ...ac },
            { key: "NC", role: "No Connection", ...ac },
          ],
        },
      },
      {
        roleClass: "ac role veto on 2-pin source (ac_line_input / acLineInput)",
        kind: "source",
        expected: "source",
        snake: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "ac_line_input" },
        ],
        variants: {
          camel: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "acLineInput" },
          ],
          pascal: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "AcLineInput" },
          ],
          kebab: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "ac-line-input" },
          ],
          spaced: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "AC Line Input" },
          ],
        },
      },
      {
        roleClass: "phase role veto on 2-pin source (phase_1_source)",
        kind: "source",
        expected: "source",
        snake: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "phase_1_source" },
        ],
        variants: {
          camel: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "phase1Source" },
          ],
          pascal: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "Phase1Source" },
          ],
          kebab: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "phase-1-source" },
          ],
          spaced: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "Phase 1 Source" },
          ],
        },
      },
      {
        roleClass: "aux role veto on 2-pin source (auxiliary_potential)",
        kind: "source",
        expected: "source",
        snake: [
          { key: "A", role: "dc_positive_output" },
          { key: "B", role: "auxiliary_potential" },
        ],
        variants: {
          camel: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "auxiliaryPotential" },
          ],
          pascal: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "AuxiliaryPotential" },
          ],
          kebab: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "auxiliary-potential" },
          ],
          spaced: [
            { key: "A", role: "dc_positive_output" },
            { key: "B", role: "Auxiliary Potential" },
          ],
        },
      },
      {
        roleClass: "earth exclusion on 2-pin AC-rated load (protective_earth)",
        kind: "load",
        expected: "load",
        snake: [
          { key: "A", ...ac },
          { key: "B", role: "protective_earth", ...ac },
        ],
        variants: {
          camel: [
            { key: "A", ...ac },
            { key: "B", role: "protectiveEarth", ...ac },
          ],
          pascal: [
            { key: "A", ...ac },
            { key: "B", role: "ProtectiveEarth", ...ac },
          ],
          kebab: [
            { key: "A", ...ac },
            { key: "B", role: "protective-earth", ...ac },
          ],
          spaced: [
            { key: "A", ...ac },
            { key: "B", role: "Protective Earth", ...ac },
          ],
        },
      },
      {
        roleClass: "earth skip on 3-pin AC load (chassis_ground)",
        kind: "load",
        expected: "ac-input",
        snake: [
          { key: "L", role: "ac_line_input" },
          { key: "N", role: "ac_input_return" },
          { key: "PE", role: "chassis_ground" },
        ],
        variants: {
          camel: [
            { key: "L", role: "acLineInput" },
            { key: "N", role: "acInputReturn" },
            { key: "PE", role: "chassisGround" },
          ],
          pascal: [
            { key: "L", role: "AcLineInput" },
            { key: "N", role: "AcInputReturn" },
            { key: "PE", role: "ChassisGround" },
          ],
          kebab: [
            { key: "L", role: "ac-line-input" },
            { key: "N", role: "ac-input-return" },
            { key: "PE", role: "chassis-ground" },
          ],
          spaced: [
            { key: "L", role: "AC Line Input" },
            { key: "N", role: "AC Input Return" },
            { key: "PE", role: "Chassis Ground" },
          ],
        },
      },
    ];

    for (const row of table) {
      const baseline = evalMark(row.kind, row.snake);
      expect(baseline, `${row.roleClass} snake_case`).toBe(row.expected);
      for (const [style, terminals] of Object.entries(row.variants)) {
        expect(evalMark(row.kind, terminals), `${row.roleClass} ${style}`).toBe(
          baseline,
        );
      }
    }
  });

  it("gives authored current-carrying roles precedence over protective_earth potential anchors (PEN, #553 round 5)", async () => {
    const { ir, type, ps1 } = await corePsuFixture();
    delete type.circuitSymbols;

    // 1. Unit checks: authored AC/DC/neutral/return roles outrank a direct PE potential anchor.
    const withPeAnchor = (
      kind: "load" | "source",
      terminals: Array<{
        key: string;
        role?: string;
        rating?: { voltage_type?: "AC" | "DC" };
      }>,
      anchorKey: string,
    ) => {
      const potIr = structuredClone(ir);
      const t = potIr.deviceTypes.find((d) => d.id === type.id)!;
      t.symbol = "thermite:dc-supply";
      delete t.circuitSymbols;
      t.terminals = terminals;
      potIr.terminals = potIr.terminals.filter(
        (x) => x.id.deviceUid !== ps1.uid,
      );
      for (const p of terminals) {
        potIr.terminals.push({
          id: { deviceUid: ps1.uid, terminalKey: p.key },
          ...(p.role ? { role: p.role } : {}),
          ...(p.rating ? { rating: p.rating } : {}),
          source: t.source,
        });
      }
      potIr.potentials.push({
        uid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        name: "PEN",
        electrical: { polarity: "protective_earth" },
        aliases: [],
        terminal: { deviceUid: ps1.uid, terminalKey: anchorKey },
        netId: "net:pen",
        terminalSource: t.source,
        source: t.source,
      });
      const fn = {
        id: { deviceUid: ps1.uid, functionKey: "face" },
        kind,
        terminals: terminals.map((p) => ({
          deviceUid: ps1.uid,
          terminalKey: p.key,
        })),
      };
      return circuitMark(t, fn, { ir: potIr });
    };

    const ac = { rating: { voltage_type: "AC" as const } };
    expect(
      withPeAnchor(
        "load",
        [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "ac_input_return", ...ac },
        ],
        "N",
      ),
      "ac_input_return with PE anchor",
    ).toBe("ac-input");
    expect(
      withPeAnchor(
        "load",
        [
          { key: "L", role: "acLineInput" },
          { key: "N", role: "acInputReturn" },
        ],
        "N",
      ),
      "camelCase acInputReturn with PE anchor",
    ).toBe("ac-input");
    expect(
      withPeAnchor(
        "load",
        [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "neutral", ...ac },
        ],
        "N",
      ),
      "neutral with PE anchor",
    ).toBe("ac-input");
    expect(
      withPeAnchor(
        "load",
        [
          { key: "L", role: "ac_line_input", ...ac },
          { key: "N", role: "return", ...ac },
        ],
        "N",
      ),
      "return with PE anchor",
    ).toBe("ac-input");
    expect(
      withPeAnchor(
        "source",
        [
          { key: "+", role: "dc_positive_output" },
          { key: "-", role: "dc_return_output" },
        ],
        "-",
      ),
      "dc_return_output with PE anchor keeps dc-output",
    ).toBe("dc-output");
    // Unroled or earth-set role keeps earth behavior under a PE potential anchor.
    expect(
      withPeAnchor(
        "load",
        [
          { key: "L", ...ac },
          { key: "N", ...ac },
        ],
        "N",
      ),
      "unroled terminal with PE anchor stays earth",
    ).toBe("load");
    expect(
      withPeAnchor(
        "load",
        [
          { key: "L", ...ac },
          { key: "N", role: "ProtectiveEarth", ...ac },
        ],
        "N",
      ),
      "earth-set role with PE anchor stays earth",
    ).toBe("load");

    // 2. Compiled project reproducing the reviewer's round-4 PEN and camelCase edge probes in both flows.
    const dir = await mkdtemp(join(tmpdir(), "thermite-ps1mark-r5-"));
    try {
      const uid = (i: number) =>
        `f8000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const ratedAc = (role: string) => ({
        role,
        rating: { voltage_type: "AC" },
      });
      const line = ratedAc("ac_line_input");
      const neutral = ratedAc("ac_input_return");
      const cases = [
        {
          name: "aux-camel",
          kind: "load",
          terminals: { L: line, N: neutral, A: ratedAc("auxInput") },
          expected: "load",
        },
        {
          name: "dc-camel",
          kind: "load",
          terminals: { L: line, N: ratedAc("dcReturn") },
          expected: "load",
        },
        {
          name: "ac-camel-source",
          kind: "source",
          terminals: {
            A: { role: "dc_positive_output" },
            B: { role: "acLineInput" },
          },
          expected: "source",
        },
        {
          name: "pen-direct-anchor",
          kind: "load",
          terminals: { L: line, N: neutral },
          expected: "ac-input",
        },
        {
          name: "pen-remote-anchor",
          kind: "load",
          terminals: { L: line, N: neutral },
          expected: "ac-input",
        },
      ] as const;

      await mkdir(join(dir, "library"), { recursive: true });
      await writeFile(
        join(dir, "system.json"),
        JSON.stringify({
          format: "electrical-system/0.1",
          project: { name: "PS1MARK Round 5 Edge Probes" },
          sources: ["source.json"],
          libraries: [{ name: "r5-edges", version: "0.1.0", path: "library" }],
        }),
      );
      await writeFile(
        join(dir, "library/library.json"),
        JSON.stringify({
          name: "r5-edges",
          version: "0.1.0",
          sources: ["types.json"],
        }),
      );
      await writeFile(
        join(dir, "library/types.json"),
        JSON.stringify({
          types: [
            ...cases.map((c) => ({
              kind: "device_type",
              id: `r5-edges:${c.name}`,
              symbol: "thermite:dc-supply",
              terminals: c.terminals,
              functions: {
                face: { kind: c.kind, terminals: Object.keys(c.terminals) },
              },
            })),
            {
              kind: "device_type",
              id: "r5-edges:bond-point",
              terminals: { PE: { role: "protective_earth" } },
              functions: { bond: { kind: "bus", terminals: ["PE"] } },
            },
          ],
        }),
      );
      const objects: unknown[] = cases.map((c, i) => ({
        kind: "device",
        uid: uid(i + 1),
        designation: `P${i + 1}`,
        type: `r5-edges:${c.name}`,
      }));
      for (const [idx, anchorOnReturn] of [true, false].entries()) {
        const serial = idx + 1;
        const devDesig = `P${cases.length - 1 + idx}`;
        const returnTerminal = { device: devDesig, terminal: "N" };
        const peTerminal = { device: `PE${serial}`, terminal: "PE" };
        objects.push(
          {
            kind: "device",
            uid: uid(10 + serial),
            designation: peTerminal.device,
            type: "r5-edges:bond-point",
          },
          {
            kind: "wire",
            uid: uid(20 + serial),
            designation: `BOND${serial}`,
            endpoints: [returnTerminal, peTerminal],
          },
          {
            kind: "potential",
            uid: uid(30 + serial),
            name: `PEN${serial}`,
            at: anchorOnReturn ? returnTerminal : peTerminal,
            electrical: { polarity: "protective_earth" },
          },
        );
      }
      await writeFile(join(dir, "source.json"), JSON.stringify({ objects }));
      expect((await lockProject(dir)).ok).toBe(true);
      const compiled = await compileProject(dir);
      expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
      if (!compiled.ok) return;

      for (const flow of ["left-to-right", "top-to-bottom"] as const) {
        const rendered = await renderSchematicPacket(compiled.ir, {
          format: "schematic-packet-request/0.1",
          views: [
            {
              format: "circuit-view-request/0.1",
              title: `PS1MARK round-5 edges (${flow})`,
              flow,
              groups: cases.map((c, i) => ({
                id: c.name,
                label: c.name,
                functions: [
                  {
                    device: { by: "uid" as const, value: uid(i + 1) },
                    key: "face",
                  },
                ],
                conductors: [],
              })),
            },
          ],
        });
        expect(rendered.ok, JSON.stringify(rendered)).toBe(true);
        if (!rendered.ok) return;
        const doc = parseHTML(rendered.value.html).document;
        for (const c of cases) {
          const group = doc.querySelector(
            `[data-circuit-group="${c.name}"] [data-function-key="face"]`,
          );
          const marks = [...group!.querySelectorAll("[data-circuit-mark]")].map(
            (el) => el.getAttribute("data-circuit-mark"),
          );
          expect(marks, `${flow} ${c.name}`).toEqual([c.expected]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
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
