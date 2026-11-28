import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject, lockProject } from "@thermite/compiler";
import { prepareCircuitView } from "../src/circuit.js";
import { captionInk } from "../src/symbols/caption-ink.js";
import { captionTouches } from "../src/symbols/circuit-caption.js";
import { circuitAttachmentPoints } from "../src/symbols/circuit.js";
import { TERMINAL_TEXT_SIZE } from "../src/symbols/circuit-text.js";
import { parallelCircuitFixture } from "./circuit-fixture.js";

function parsePathSegments(d: string) {
  const nums = d
    .trim()
    .split(/[ML,\s]+/)
    .filter(Boolean)
    .map(Number);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2)
    pts.push({ x: nums[i]!, y: nums[i + 1]! });
  return pts.slice(1).map((b, i) => [pts[i]!, b] as const);
}

function changeoverTypes(southCommon: boolean) {
  const shared = (...keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, { connection_policy: "shared" }]));
  return {
    types: [
      {
        kind: "device_type",
        id: "synth:relay",
        symbol: "thermite:relay",
        terminals: shared("A1", "A2", "11", "12", "14"),
        functions: {
          contact12: {
            kind: "contact",
            normal_state: "closed",
            terminals: southCommon ? ["12", "11"] : ["11", "12"],
          },
          contact14: {
            kind: "contact",
            normal_state: "open",
            terminals: southCommon ? ["14", "11"] : ["11", "14"],
          },
          coil: { kind: "coil", terminals: ["A1", "A2"] },
        },
        internal_relations: [
          { relation: "actuates", from: "coil", to: "contact12" },
          { relation: "actuates", from: "coil", to: "contact14" },
        ],
      },
      {
        kind: "device_type",
        id: "synth:lamp",
        symbol: "thermite:lamp",
        terminals: shared("X1", "X2"),
        functions: { lamp: { kind: "load", terminals: ["X1", "X2"] } },
      },
    ],
  };
}

function changeoverSource() {
  const dev = (n: number, designation: string, type: string) => ({
    kind: "device",
    uid: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    designation,
    type,
  });
  const wire = (
    n: number,
    designation: string,
    a: readonly [string, string],
    b: readonly [string, string],
    label: string,
  ) => ({
    kind: "wire",
    uid: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    designation,
    endpoints: [
      { device: a[0], terminal: a[1] },
      { device: b[0], terminal: b[1] },
    ],
    properties: { label },
  });
  return {
    objects: [
      dev(101, "R1", "synth:relay"),
      dev(102, "H1", "synth:lamp"),
      dev(103, "H2", "synth:lamp"),
      wire(201, "W1", ["R1", "11"], ["H1", "X1"], "100"),
      wire(202, "W2", ["R1", "11"], ["H2", "X1"], "100"),
      wire(203, "W3", ["R1", "14"], ["H1", "X2"], "101"),
    ],
  };
}

async function changeoverRelayIr(southCommon: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "thermite-leadlabel-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const write = (rel: string, value: unknown) =>
      writeFile(join(dir, rel), JSON.stringify(value));
    await mkdir(join(dir, "library"));
    await write("system.json", {
      format: "electrical-system/0.1",
      project: { name: "Synthetic lead-label clearance" },
      sources: ["source.json"],
      libraries: [{ name: "synth", version: "0.1.0", path: "library" }],
    });
    await write("library/library.json", {
      name: "synth",
      version: "0.1.0",
      sources: ["types.json"],
    });
    await write("library/types.json", changeoverTypes(southCommon));
    await write("source.json", changeoverSource());
    const locked = await lockProject(dir);
    if (!locked.ok) throw new Error(JSON.stringify(locked.diagnostics));
    const compiled = await compileProject(dir);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    return { ir: compiled.ir, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function assertLeadsClearLabels(svg: string) {
  const doc = parseHTML(svg).document;
  const r1 = [...doc.querySelectorAll("g[data-circuit-functions]")].find(
    (g) =>
      !g.hasAttribute("data-circuit-tag-lane") &&
      g.getAttribute("data-circuit-functions")?.includes("contact14") &&
      g.getAttribute("data-circuit-functions")?.includes("contact12"),
  );
  expect(r1).toBeTruthy();
  const labelBoxes = [...r1!.querySelectorAll("g[data-terminal-key] text")].map(
    (el) => ({
      text: el.textContent ?? "",
      box: captionInk(
        el.textContent ?? "",
        Number(el.getAttribute("x")),
        Number(el.getAttribute("y")),
        TERMINAL_TEXT_SIZE,
        el.getAttribute("text-anchor") ?? "start",
      ),
    }),
  );
  expect(labelBoxes.some((l) => l.text === "11 [+1]")).toBe(true);
  const leadPaths = [
    ...r1!.querySelectorAll(
      'g[data-terminal-attachment] path[data-electrical-role="terminal-lead"]',
    ),
  ];
  expect(leadPaths.length).toBeGreaterThanOrEqual(6);
  for (const pathEl of leadPaths) {
    const halfStroke = Number(pathEl.getAttribute("stroke-width") ?? 0.35) / 2;
    const segments = parsePathSegments(pathEl.getAttribute("d") ?? "");
    for (const label of labelBoxes) {
      const crossed = segments.some((seg) =>
        captionTouches(label.box, seg, halfStroke + 0.05),
      );
      expect(
        crossed,
        `lead ${pathEl.getAttribute("d")} crossed label "${label.text}"`,
      ).toBe(false);
    }
  }
}

function assertAllDeviceLeadsClearLabels(
  deviceGroup: Element,
  expectedLeadCount: number,
) {
  const labels = [
    ...deviceGroup.querySelectorAll("g[data-terminal-key] text"),
  ].map((el) => ({
    text: el.textContent ?? "",
    box: captionInk(
      el.textContent ?? "",
      Number(el.getAttribute("x")),
      Number(el.getAttribute("y")),
      TERMINAL_TEXT_SIZE,
      el.getAttribute("text-anchor") ?? "start",
    ),
  }));
  const leads = [
    ...deviceGroup.querySelectorAll(
      'g[data-terminal-attachment] path[data-electrical-role="terminal-lead"]',
    ),
  ];
  expect(leads).toHaveLength(expectedLeadCount);
  for (const pathEl of leads) {
    const halfStroke = Number(pathEl.getAttribute("stroke-width") ?? 0.35) / 2;
    const segments = parsePathSegments(pathEl.getAttribute("d") ?? "");
    for (const label of labels) {
      expect(
        segments.some((seg) =>
          captionTouches(label.box, seg, halfStroke + 0.05),
        ),
        `lead ${pathEl.getAttribute("d")} crossed "${label.text}"`,
      ).toBe(false);
    }
  }
  return leads;
}

function assertTerminalHalosPrecedeLeads(
  deviceGroup: Element,
  termKey: string,
) {
  const allPaths = [...deviceGroup.querySelectorAll("path")];
  const leads = allPaths.filter(
    (p) =>
      p.getAttribute("data-electrical-role") === "terminal-lead" &&
      p
        .closest("[data-terminal-attachment]")
        ?.getAttribute("data-terminal-attachment")
        ?.includes(`"${termKey}"`),
  );
  const firstLeadIdx = Math.min(...leads.map((p) => allPaths.indexOf(p)));
  const leadDs = new Set(leads.map((p) => p.getAttribute("d")));
  const halos = allPaths.filter(
    (p) =>
      p.getAttribute("stroke") === "white" && leadDs.has(p.getAttribute("d")),
  );
  expect(halos).toHaveLength(leads.length);
  for (const halo of halos)
    expect(allPaths.indexOf(halo)).toBeLessThan(firstLeadIdx);
  return { allPaths, leads };
}

function quadRelayTypes() {
  const shared = (...ks: string[]) =>
    Object.fromEntries(ks.map((k) => [k, { connection_policy: "shared" }]));
  return {
    types: [
      {
        kind: "device_type",
        id: "synth:quad",
        symbol: "thermite:relay",
        terminals: shared("111111", "333333", "12", "14", "16", "18"),
        functions: {
          c1: {
            kind: "contact",
            normal_state: "closed",
            terminals: ["111111", "12"],
          },
          c2: {
            kind: "contact",
            normal_state: "open",
            terminals: ["333333", "14"],
          },
          c3: {
            kind: "contact",
            normal_state: "closed",
            terminals: ["111111", "16"],
          },
          c4: {
            kind: "contact",
            normal_state: "open",
            terminals: ["333333", "18"],
          },
        },
      },
    ],
  };
}

async function compileAlternatingCommonsIr() {
  const dir = await mkdtemp(join(tmpdir(), "thermite-leadlabel-multi-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    const write = (rel: string, value: unknown) =>
      writeFile(join(dir, rel), JSON.stringify(value));
    await mkdir(join(dir, "library"));
    await write("system.json", {
      format: "electrical-system/0.1",
      project: { name: "Multi-branch lead paint order" },
      sources: ["source.json"],
      libraries: [{ name: "synth", version: "0.1.0", path: "library" }],
    });
    await write("library/library.json", {
      name: "synth",
      version: "0.1.0",
      sources: ["types.json"],
    });
    await write("library/types.json", quadRelayTypes());
    await write("source.json", {
      objects: [
        {
          kind: "device",
          uid: "30000000-0000-4000-8000-000000000001",
          designation: "R1",
          type: "synth:quad",
        },
      ],
    });
    const locked = await lockProject(dir);
    if (!locked.ok) throw new Error(JSON.stringify(locked.diagnostics));
    const compiled = await compileProject(dir);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    return { ir: compiled.ir, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

describe("circuit terminal-lead clearance against terminal labels (#667)", () => {
  it.each([false, true])(
    "keeps every terminal-lead attachment clear of terminal label envelopes in top-to-bottom flow (southCommon=%s)",
    async (southCommon) => {
      const { ir, dispose } = await changeoverRelayIr(southCommon);
      try {
        const view = await prepareCircuitView(ir, {
          format: "circuit-view-request/0.1",
          title: "Changeover lead clearance",
          flow: "top-to-bottom",
          groups: [
            {
              id: "changeover",
              functions: [
                {
                  device: { by: "designation", value: "R1" },
                  key: "contact12",
                },
                {
                  device: { by: "designation", value: "R1" },
                  key: "contact14",
                },
                { device: { by: "designation", value: "R1" }, key: "coil" },
                { device: { by: "designation", value: "H1" }, key: "lamp" },
              ],
              conductors: ["W1", "W3"],
            },
          ],
        });
        assertLeadsClearLabels(view.groups[0]!.content);
      } finally {
        await dispose();
      }
    },
  );

  it("preserves straight vertical and lateral same-side attachment geometry", () => {
    expect(
      circuitAttachmentPoints(
        { x: 10, y: 0, side: "NORTH" },
        { x: 10, y: 14 },
        "NORTH",
        30,
        36,
      ),
    ).toEqual([
      [10, 0],
      [10, 1],
      [10, 1],
      [10, 14],
    ]);
    expect(
      circuitAttachmentPoints(
        { x: 0, y: 10, side: "WEST" },
        { x: 12, y: 18 },
        "WEST",
        30,
        36,
      ),
    ).toEqual([
      [0, 10],
      [1, 10],
      [1, 18],
      [12, 18],
    ]);
  });

  it("keeps lateral and vertical cross-side attachments clear of terminal labels on parallelCircuitFixture(true) and protects the shared trunk", async () => {
    const fixture = await parallelCircuitFixture(true);
    try {
      for (const flow of ["left-to-right", "top-to-bottom"] as const) {
        const view = await prepareCircuitView(fixture.ir, {
          ...fixture.view,
          flow,
          groups: [
            {
              id: "cross-common",
              conductors: [],
              functions: [
                { device: { by: "designation", value: "K1" }, key: "no" },
                { device: { by: "designation", value: "K1" }, key: "nc" },
              ],
            },
          ],
        });
        const doc = parseHTML(view.groups[0]!.content).document;
        const k1 = [...doc.querySelectorAll("g[data-circuit-functions]")].find(
          (g) => !g.hasAttribute("data-circuit-tag-lane"),
        )!;
        const leads = assertAllDeviceLeadsClearLabels(k1, 4);
        if (flow === "left-to-right") {
          const crossLead = leads.find(
            (el) => parsePathSegments(el.getAttribute("d") ?? "").length === 5,
          );
          expect(crossLead).toBeTruthy();
          expect(
            parsePathSegments(crossLead!.getAttribute("d") ?? "")[1]![1].y,
          ).toBeLessThan(4.5);
        }
        const { leads: term11Leads } = assertTerminalHalosPrecedeLeads(
          k1,
          "11",
        );
        expect(term11Leads).toHaveLength(2);
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("staggers distinct-net offset jog levels and groups same-terminal halos before dark leads on 4-contact relays", async () => {
    const { ir, dispose } = await compileAlternatingCommonsIr();
    try {
      const view = await prepareCircuitView(ir, {
        format: "circuit-view-request/0.1",
        title: "Staggered alternating commons",
        flow: "top-to-bottom",
        groups: [
          {
            id: "quad",
            conductors: [],
            functions: ["c1", "c2", "c3", "c4"].map((key) => ({
              device: { by: "designation", value: "R1" },
              key,
            })),
          },
        ],
      });
      const doc = parseHTML(view.groups[0]!.content).document;
      const r1 = [...doc.querySelectorAll("g[data-circuit-functions]")].find(
        (g) => !g.hasAttribute("data-circuit-tag-lane"),
      )!;
      assertAllDeviceLeadsClearLabels(r1, 8);
      const { allPaths, leads: aLeads } = assertTerminalHalosPrecedeLeads(
        r1,
        "111111",
      );
      const { leads: bLeads } = assertTerminalHalosPrecedeLeads(r1, "333333");
      const offsetJogY = (leads: Element[]) => {
        const offset = leads.find((p) =>
          parsePathSegments(p.getAttribute("d") ?? "").some(
            ([a, b]) => Math.abs(a.x - b.x) > 1,
          ),
        );
        expect(offset).toBeTruthy();
        return parsePathSegments(offset!.getAttribute("d") ?? "")[0]![1].y;
      };
      expect(
        Math.abs(offsetJogY(bLeads) - offsetJogY(aLeads)),
      ).toBeGreaterThanOrEqual(1.2);
      const lastALead = Math.max(...aLeads.map((p) => allPaths.indexOf(p)));
      const bDs = new Set(bLeads.map((p) => p.getAttribute("d")));
      const firstBHalo = Math.min(
        ...allPaths
          .filter(
            (p) =>
              p.getAttribute("stroke") === "white" &&
              bDs.has(p.getAttribute("d")),
          )
          .map((p) => allPaths.indexOf(p)),
      );
      expect(lastALead).toBeLessThan(firstBHalo);
    } finally {
      await dispose();
    }
  });
});
