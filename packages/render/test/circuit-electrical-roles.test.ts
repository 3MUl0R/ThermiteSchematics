import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { renderSchematicPacket } from "../src/sheets.js";
import {
  circuitBlock,
  circuitInterfaceMark,
  circuitMotor,
  circuitMotorVertical,
  circuitTransformerCore,
  circuitWinding,
  circuitWindingVertical,
  emitCircuitMark,
  type CircuitMark,
} from "../src/symbols/circuit.js";
import { circuitTerminalAttachments } from "../src/symbols/circuit-attachments.js";
import {
  request as seriesRequest,
  seriesFixture,
} from "./series-loop-fixture.js";

const VALID_ROLES = new Set([
  "terminal-lead",
  "terminal-node",
  "contact-blade",
  "contact-path",
  "element-path",
  "coil-body",
  "element-body",
  "functional-boundary",
  "mechanical-operator",
  "qualifier",
  "unspecified",
]);

const ALL_MARKS: readonly CircuitMark[] = [
  "disconnector",
  "estop-no",
  "estop-nc",
  "selector-no",
  "selector-nc",
  "contact-no",
  "contact-nc",
  "breaker",
  "overload",
  "fuse",
  "coil",
  "motor",
  "heater",
  "winding",
  "source",
  "load",
  "terminal",
  "earth",
  "solenoid",
  "lamp",
  "switch-no",
  "switch-nc",
  "pushbutton-no",
  "pushbutton-nc",
  "thermocouple",
  "interface",
  "pressure-no",
  "pressure-nc",
  "level-no",
  "level-nc",
  "level-sensor",
  "conductivity-probe",
  "receptacle",
  "receptacle-with-earth",
  "ac-input",
  "dc-output",
  "sensor-3wire",
];

function graphicPrimitives(svg: string): Element[] {
  const doc = parseHTML(`<svg>${svg}</svg>`).document;
  return [...doc.querySelectorAll("line,polyline,rect,circle,path")].filter(
    (e) =>
      e.getAttribute("stroke") !== "none" &&
      e.getAttribute("stroke") !== "white",
  );
}

describe("circuit catalog electrical primitive roles (#646 V2-02)", () => {
  it("exports an explicit valid data-electrical-role on every graphic primitive of all 37 circuit marks in both orientations", () => {
    for (const mark of ALL_MARKS) {
      for (const vertical of [false, true]) {
        const span: readonly [number, number] | undefined =
          mark === "ac-input" || mark === "dc-output" ? [-6, 6] : undefined;
        const shapes = graphicPrimitives(
          emitCircuitMark(mark, vertical, 0.666667, span),
        );
        expect(shapes.length, `${mark} vertical=${vertical}`).toBeGreaterThan(
          0,
        );
        for (const el of shapes) {
          const role = el.getAttribute("data-electrical-role");
          expect(
            role,
            `${mark} ${el.tagName} vertical=${vertical}`,
          ).toBeTruthy();
          expect(
            VALID_ROLES.has(role!),
            `${mark} ${el.tagName} role=${role}`,
          ).toBe(true);
          expect(role, `${mark} should have catalog-defined role`).not.toBe(
            "unspecified",
          );
        }
      }
    }
  });

  it("assigns exact catalog roles for contacts, coils, elements, boundaries, operators, and qualifiers", () => {
    const rolesOf = (mark: CircuitMark, vertical = false) =>
      graphicPrimitives(emitCircuitMark(mark, vertical, 0.666667)).map((e) => [
        e.tagName.toLowerCase(),
        e.getAttribute("data-electrical-role"),
      ]);

    expect(rolesOf("contact-no")).toEqual([
      ["line", "terminal-lead"],
      ["line", "terminal-lead"],
      ["line", "contact-blade"],
      ["line", "contact-blade"],
    ]);
    expect(rolesOf("contact-nc")).toEqual([
      ["line", "terminal-lead"],
      ["line", "terminal-lead"],
      ["line", "contact-blade"],
      ["line", "contact-blade"],
      ["line", "contact-path"],
    ]);
    expect(rolesOf("coil")).toEqual([
      ["line", "terminal-lead"],
      ["rect", "coil-body"],
      ["line", "terminal-lead"],
    ]);
    expect(rolesOf("fuse")).toEqual([
      ["line", "element-path"],
      ["rect", "element-body"],
    ]);
    expect(rolesOf("overload")).toEqual([
      ["line", "terminal-lead"],
      ["rect", "element-body"],
      ["polyline", "element-path"],
      ["line", "terminal-lead"],
    ]);
    expect(rolesOf("breaker")).toEqual([
      ["line", "terminal-lead"],
      ["line", "contact-blade"],
      ["line", "terminal-lead"],
      ["line", "qualifier"],
      ["line", "qualifier"],
    ]);
    expect(rolesOf("dc-output")).toEqual([
      ["rect", "functional-boundary"],
      ["line", "qualifier"],
      ["line", "qualifier"],
      ["line", "qualifier"],
      ["line", "qualifier"],
    ]);
    expect(rolesOf("earth", false)).toEqual([
      ["line", "terminal-lead"],
      ["line", "terminal-lead"],
      ["line", "qualifier"],
      ["line", "qualifier"],
      ["line", "qualifier"],
    ]);
  });

  it("exports electrical roles on circuitMotor and circuitWinding in both flows", () => {
    const roles = (svg: string) =>
      graphicPrimitives(svg).map((e) => [
        e.tagName.toLowerCase(),
        e.getAttribute("data-electrical-role"),
      ]);
    expect(roles(circuitMotor(24, 0, 20, [4, 10, 16], true))).toEqual([
      ["circle", "functional-boundary"],
      ["line", "terminal-lead"],
      ["line", "terminal-lead"],
      ["line", "terminal-lead"],
    ]);
    expect(roles(circuitMotorVertical(12, 12, 20, [6, 12, 18], false))).toEqual(
      [
        ["circle", "functional-boundary"],
        ["line", "terminal-lead"],
        ["line", "terminal-lead"],
        ["line", "terminal-lead"],
      ],
    );
    expect(roles(circuitWinding(20, 4, 16, false, false))).toEqual([
      ["polyline", "element-path"],
      ["line", "mechanical-operator"],
    ]);
    expect(roles(circuitWindingVertical(20, 4, 16, true, false))).toEqual([
      ["polyline", "element-path"],
      ["line", "mechanical-operator"],
    ]);
  });

  it("exports electrical roles on circuitInterfaceMark and circuitBlock", () => {
    const iface = graphicPrimitives(
      circuitInterfaceMark(
        "level-sensor",
        15,
        15,
        [
          { x: 0, y: 10, side: "WEST" },
          { x: 0, y: 20, side: "WEST" },
        ],
        false,
        false,
      ),
    );
    expect(
      iface
        .slice(0, 3)
        .map((e) => [
          e.tagName.toLowerCase(),
          e.getAttribute("data-electrical-role"),
        ]),
    ).toEqual([
      ["rect", "functional-boundary"],
      ["line", "terminal-lead"],
      ["line", "terminal-lead"],
    ]);

    expect(
      graphicPrimitives(circuitBlock(20, 30)).map((e) =>
        e.getAttribute("data-electrical-role"),
      ),
    ).toEqual(["functional-boundary"]);

    const enclosure = graphicPrimitives(
      circuitBlock(20, 30, [{ x: 20, y: 15, side: "EAST" }], true),
    );
    expect(enclosure.length).toBeGreaterThan(0);
    for (const line of enclosure)
      expect(line.getAttribute("data-electrical-role")).toBe(
        "functional-boundary",
      );
  });

  it("exports electrical roles on circuitTransformerCore and attachments", () => {
    expect(
      graphicPrimitives(circuitTransformerCore(10, 2, 18, false)).map((e) =>
        e.getAttribute("data-electrical-role"),
      ),
    ).toEqual(["mechanical-operator", "mechanical-operator"]);

    const attach = graphicPrimitives(
      circuitTerminalAttachments(
        {
          width: 24,
          height: 16,
          pins: [
            {
              id: "p1",
              terminal: { deviceUid: "d1", terminalKey: "1" },
              x: 0,
              y: 8,
              side: "WEST",
            },
            {
              id: "p2",
              terminal: { deviceUid: "d1", terminalKey: "2" },
              x: 24,
              y: 8,
              side: "EAST",
            },
          ],
        },
        [
          { deviceUid: "d1", terminalKey: "1" },
          { deviceUid: "d1", terminalKey: "2" },
        ],
        false,
        false,
        12,
        8,
      ),
    );
    expect(attach.map((e) => e.getAttribute("data-electrical-role"))).toEqual([
      "terminal-lead",
      "terminal-lead",
    ]);
  });

  it("emits native data-function-id on series-loop power dc-output mark wrapper in both flows (M3, #646)", async () => {
    const f = await seriesFixture(undefined, false);
    try {
      const ps = f.ir.devices.find((d) => d.designation === "PS1")!;
      const fn = f.ir.functions.find(
        (fn) => fn.id.deviceUid === ps.uid && fn.kind === "source",
      )!;
      const expectedId = JSON.stringify([fn.id.deviceUid, fn.id.functionKey]);
      for (const flow of ["left-to-right", "top-to-bottom"] as const) {
        const res = await renderSchematicPacket(f.ir, {
          format: "schematic-packet-request/0.1",
          index: false,
          views: [seriesRequest({ flow })],
        });
        expect(res.ok).toBe(true);
        if (!res.ok) continue;
        const { document } = parseHTML(res.value.sheets[0]!.svg);
        const mark = document.querySelector('[data-circuit-mark="dc-output"]');
        expect(mark, flow).toBeTruthy();
        const wrapper = mark?.closest("[data-function-id]");
        expect(wrapper?.getAttribute("data-function-id"), flow).toBe(
          expectedId,
        );
      }
    } finally {
      await f.dispose();
    }
  });
});
