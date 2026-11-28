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
});
