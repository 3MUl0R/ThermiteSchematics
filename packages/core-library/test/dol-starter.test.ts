import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { analyzeCompleteness, compileProject } from "@thermite/compiler";
import {
  prepareCircuitView,
  type CircuitViewRequest,
} from "../../render/src/circuit.js";
import { renderSchematic } from "../../render/src/renderer.js";
import { renderSchematicPacket } from "../../render/src/sheets.js";
const starter = "packages/core-library/test/fixtures/dol-starter";

it.each(["left-to-right", "top-to-bottom"] as const)(
  "draws the whole DOL control circuit in %s while pinning the rooted control gap",
  async (flow) => {
    const compiled = await compileProject(starter);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const { ir } = compiled;
    const before = JSON.stringify(ir);
    const request: CircuitViewRequest = {
      ...JSON.parse(
        await readFile(join(starter, "control.circuit.json"), "utf8"),
      ),
      flow,
    };
    // Derive the full control inventory from source, independently of the request.
    // Include the transformer feed, PSU, interlocks, holding contact and indication.
    const controlDevices = new Set(
      ir.devices
        .filter((d) =>
          ["T1", "PS1", "F1", "S0", "S1", "S2", "R1", "H1"].includes(
            d.designation,
          ),
        )
        .map((d) => d.uid),
    );
    const wires = ir.wires
      .filter((w) =>
        w.endpoints.some((e) => controlDevices.has(e.terminal.deviceUid)),
      )
      .map((w) => w.uid)
      .sort();
    const functions = ir.functions
      .filter(
        (f) =>
          f.kind !== "mechanism" &&
          (controlDevices.has(f.id.deviceUid) ||
            f.id.functionKey === "coil" ||
            f.id.functionKey === "aux95"),
      )
      .map((f) => JSON.stringify([f.id.deviceUid, f.id.functionKey]))
      .sort();
    expect(wires).toHaveLength(17);
    expect(functions).toHaveLength(14);
    const circuit = await prepareCircuitView(ir, request);
    expect(
      circuit.groups.flatMap((g) => g.coverage.conductorIds).sort(),
    ).toEqual(wires);
    expect(
      circuit.groups.flatMap((g) => g.coverage.functionIds).sort(),
    ).toEqual(functions);
    const packet = await renderSchematicPacket(ir, {
      format: "schematic-packet-request/0.1",
      page: { size: "a3", orientation: "landscape", marginMm: 10 },
      views: [request],
    });
    expect(packet.ok, JSON.stringify(packet.ok ? {} : packet)).toBe(true);
    if (packet.ok) {
      expect(
        packet.value.coverage.conductors
          .filter((c) => c.appearances.length)
          .map((c) => c.id)
          .sort(),
      ).toEqual(wires);
      expect(
        packet.value.coverage.functions
          .filter((f) => f.appearances.length)
          .map((f) => f.id)
          .sort(),
      ).toEqual(functions);
    }
    for (const root of ["K1", "R1"] as const) {
      const rooted = await renderSchematic(ir, {
        format: "schematic-view-request/0.1",
        root: { by: "designation", value: root },
        family: "control",
        flow,
      });
      const expected = structuredClone(rootedPins[root]);
      expect(rooted).toEqual(expected);
    }
    const power = await renderSchematic(ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "M1" },
      family: "power",
      flow,
    });
    expect(power.ok, JSON.stringify(power.ok ? {} : power)).toBe(true);
    expect(JSON.stringify(ir)).toBe(before);
  },
);

it.each(["left-to-right", "top-to-bottom"] as const)(
  "pins rm3 K1's terminal-context branch refusal in %s",
  async (flow) => {
    const compiled = await compileProject(
      "packages/core-library/test/fixtures/rm3",
    );
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    const result = await renderSchematic(compiled.ir, {
      format: "schematic-view-request/0.1",
      root: { by: "designation", value: "K1" },
      family: "control",
      flow,
    });
    expect(result).toEqual(rm3K1Pin);
  },
);

it("validates a DOL starter entirely from core 0.2.0 with zero errors, warnings or I003", async () => {
  const compiled = await compileProject(starter);
  expect(compiled.ok, JSON.stringify(compiled.diagnostics)).toBe(true);
  expect(compiled.diagnostics.map((d) => [d.code, d.severity])).toEqual([
    ["I305", "info"],
  ]);
  if (!compiled.ok) throw Error("starter did not compile");
  const report = analyzeCompleteness(compiled.ir);
  expect(
    report.findings.filter(
      (f) =>
        f.code === "I003" || f.severity === "warning" || f.severity === "error",
    ),
  ).toEqual([]);
  // Same explicit namespace/local-source inventory used by init and dogfood checks.
  expect(
    compiled.ir.devices.filter((d) => !d.typeId.startsWith("core:")),
  ).toEqual([]);
  for (const device of compiled.ir.devices) {
    const type = compiled.ir.deviceTypes.find((t) => t.id === device.typeId)!;
    expect(type.libraryName).toBe("core");
    expect(type.libraryVersion).toBe("0.2.0");
  }
  expect(new Set(compiled.ir.devices.map((d) => d.typeId))).toEqual(
    new Set(
      [
        "supply-480v-3ph",
        "breaker-3p",
        "contactor-3p-1no",
        "overload-3p-1nc",
        "motor-3ph",
        "control-transformer",
        "fuse-1p",
        "psu-24vdc",
        "estop-nc",
        "pushbutton-nc",
        "pushbutton-no",
        "relay-1co",
        "pilot-light",
        "terminal-pe",
      ].map((id) => `core:${id}`),
    ),
  );
});
it("reports an opened required start connection without repairing the circuit", async () => {
  const root = await mkdtemp(join(tmpdir(), "thermite-dol-negative-"));
  try {
    await cp(starter, root, { recursive: true });
    const path = join(root, "source.json"),
      source = JSON.parse(await readFile(path, "utf8"));
    source.objects = source.objects.filter(
      (o: any) =>
        !(
          o.kind === "wire" &&
          o.endpoints.some((e: any) => e.device === "S2" && e.terminal === "14")
        ),
    );
    await writeFile(path, JSON.stringify(source));
    const result = await compileProject(root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    expect(
      analyzeCompleteness(result.ir)
        .findings.filter((f) => f.code === "W903")
        .map((f) => [f.designation, f.key]),
    ).toEqual([["S2", "14"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("joins only two-ended power cable cores; a spare PE end cannot complete the motor bond", async () => {
  const root = await mkdtemp(join(tmpdir(), "thermite-dol-cable-negative-"));
  try {
    await cp(starter, root, { recursive: true });
    const original = await compileProject(root);
    if (!original.ok) throw Error(JSON.stringify(original.diagnostics));
    const path = join(root, "source.json"),
      source = JSON.parse(await readFile(path, "utf8"));
    const cable = source.objects.find((o: any) => o.kind === "cable"),
      pe = cable.conductors.find((c: any) => c.id === "PE");
    pe.endpoints[1] = null;
    pe.usage = "spare";
    await writeFile(path, JSON.stringify(source));
    const result = await compileProject(root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    expect(result.ir.nets.length).toBe(original.ir.nets.length + 1);
    expect(
      analyzeCompleteness(result.ir)
        .findings.filter((f) => f.code === "W903")
        .map((f) => [f.designation, f.key]),
    ).toEqual([["M1", "PE"]]);
    // Removing the required spare disposition is rejected rather than commoning it.
    delete pe.usage;
    await writeFile(path, JSON.stringify(source));
    const invalid = await compileProject(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "E015",
        message:
          'An unterminated cable endpoint requires explicit usage "spare".',
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Exact live refusals after terminal-only projection; branch layout remains refused.
const rootedPins = {
  K1: {
    ok: false,
    error: {
      code: "R004",
      message:
        "Invalid layout: edges boundary segment (R1.A1 \u2192 R1.A1) and W38 (K1.A1 / coil \u2192 R1.A1) overlap collinearly.",
      details: {
        originalMessage:
          'Invalid layout: edges ["boundary-segment","[\\"junction\\",\\"net:sha256:8601e5d40a2072cea4725f9772ce88ba51ea3eafb57a05c8ae4f0191dd2354b2\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]","[\\"terminal\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]"] and ["wire","10000000-0000-4000-8000-000000000038"] overlap collinearly.',
        conductors: [
          {
            id: '["wire","10000000-0000-4000-8000-000000000038"]',
            designation: "W38",
            terminals: [
              {
                deviceUid: "10000000-0000-4000-8000-000000000003",
                terminalKey: "A1",
                designation: "K1",
                functionKeys: ["coil"],
              },
              {
                deviceUid: "10000000-0000-4000-8000-000000000012",
                terminalKey: "A1",
                designation: "R1",
                functionKeys: [],
              },
            ],
          },
          {
            id: '["boundary-segment","[\\"junction\\",\\"net:sha256:8601e5d40a2072cea4725f9772ce88ba51ea3eafb57a05c8ae4f0191dd2354b2\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]","[\\"terminal\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]"]',
            designation: "boundary segment",
            terminals: [
              {
                deviceUid: "10000000-0000-4000-8000-000000000012",
                terminalKey: "A1",
                designation: "R1",
                functionKeys: [],
              },
              {
                deviceUid: "10000000-0000-4000-8000-000000000012",
                terminalKey: "A1",
                designation: "R1",
                functionKeys: [],
              },
            ],
          },
        ],
      },
      family: "control",
      netId:
        "net:sha256:8601e5d40a2072cea4725f9772ce88ba51ea3eafb57a05c8ae4f0191dd2354b2",
      root: "K1",
    },
  },
  R1: {
    ok: false,
    error: {
      code: "R004",
      message:
        "Invalid layout: edges W34 (OL1.96 / aux95 → S2.13 / contact13) and W35 (OL1.96 / aux95 → R1.11 / contact14) overlap collinearly.",
      details: {
        originalMessage:
          'Invalid layout: edges ["wire","10000000-0000-4000-8000-000000000034"] and ["wire","10000000-0000-4000-8000-000000000035"] overlap collinearly.',
        conductors: [
          {
            id: '["wire","10000000-0000-4000-8000-000000000034"]',
            designation: "W34",
            terminals: [
              {
                deviceUid: "10000000-0000-4000-8000-000000000004",
                terminalKey: "96",
                designation: "OL1",
                functionKeys: ["aux95"],
              },
              {
                deviceUid: "10000000-0000-4000-8000-000000000011",
                terminalKey: "13",
                designation: "S2",
                functionKeys: ["contact13"],
              },
            ],
          },
          {
            id: '["wire","10000000-0000-4000-8000-000000000035"]',
            designation: "W35",
            terminals: [
              {
                deviceUid: "10000000-0000-4000-8000-000000000004",
                terminalKey: "96",
                designation: "OL1",
                functionKeys: ["aux95"],
              },
              {
                deviceUid: "10000000-0000-4000-8000-000000000012",
                terminalKey: "11",
                designation: "R1",
                functionKeys: ["contact14"],
              },
            ],
          },
        ],
      },
      family: "control",
      netId:
        "net:sha256:5f735b4a219185b3b4f0ee45f4d391f7671404b731f6d0955a316a43accd0fb8",
      root: "R1",
    },
  },
};

// rm3 has the same selected geometry but its own compiler net identity.
const rm3K1Pin = {
  ok: false,
  error: {
    code: "R004",
    message:
      "Invalid layout: edges boundary segment (R1.A1 \u2192 R1.A1) and W38 (K1.A1 / coil \u2192 R1.A1) overlap collinearly.",
    details: {
      originalMessage:
        'Invalid layout: edges ["boundary-segment","[\\"junction\\",\\"net:sha256:43277223ce670fe393f502d868c9affea3137b55ee96f9609187c13b85a181e0\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]","[\\"terminal\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]"] and ["wire","10000000-0000-4000-8000-000000000038"] overlap collinearly.',
      conductors: [
        {
          id: '["wire","10000000-0000-4000-8000-000000000038"]',
          designation: "W38",
          terminals: [
            {
              deviceUid: "10000000-0000-4000-8000-000000000003",
              terminalKey: "A1",
              designation: "K1",
              functionKeys: ["coil"],
            },
            {
              deviceUid: "10000000-0000-4000-8000-000000000012",
              terminalKey: "A1",
              designation: "R1",
              functionKeys: [],
            },
          ],
        },
        {
          id: '["boundary-segment","[\\"junction\\",\\"net:sha256:43277223ce670fe393f502d868c9affea3137b55ee96f9609187c13b85a181e0\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]","[\\"terminal\\",\\"10000000-0000-4000-8000-000000000012\\",\\"A1\\"]"]',
          designation: "boundary segment",
          terminals: [
            {
              deviceUid: "10000000-0000-4000-8000-000000000012",
              terminalKey: "A1",
              designation: "R1",
              functionKeys: [],
            },
            {
              deviceUid: "10000000-0000-4000-8000-000000000012",
              terminalKey: "A1",
              designation: "R1",
              functionKeys: [],
            },
          ],
        },
      ],
    },
    family: "control",
    netId:
      "net:sha256:43277223ce670fe393f502d868c9affea3137b55ee96f9609187c13b85a181e0",
    root: "K1",
  },
} as const;
