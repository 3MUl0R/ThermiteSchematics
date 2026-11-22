import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { prepareCircuitView } from "../src/circuit.js";
import { required } from "../src/presentation/util.js";

function withSyntheticContacts(
  ir: ElectricalIr,
  deviceUid: string,
  count: number,
) {
  const cloned = structuredClone(ir);
  const contacts = cloned.functions.filter(
    (f) => f.id.deviceUid === deviceUid && f.kind === "contact",
  );
  const template = required(contacts[0], "Missing template contact");
  const relationTemplate = required(
    cloned.internalRelations.find(
      (r) => r.deviceUid === deviceUid && r.verb === "actuates",
    ),
    "Missing template relation",
  );
  while (contacts.length < count) {
    const idx = contacts.length + 1;
    const fn = {
      ...structuredClone(template),
      id: { deviceUid, functionKey: `aux_${idx}` },
      terminals: [
        { deviceUid, terminalKey: `${idx * 10 + 3}` },
        { deviceUid, terminalKey: `${idx * 10 + 4}` },
      ],
    };
    cloned.functions.push(fn);
    contacts.push(fn);
    cloned.internalRelations.push({
      ...structuredClone(relationTemplate),
      to: fn.id,
    });
  }
  return { cloned, contacts: contacts.slice(0, count) };
}

async function renderTtbCoilGroup(contactCount: number) {
  const compiled = await compileProject(
    resolve(import.meta.dirname, "../../../examples/motor-starter"),
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const k1 = required(
    compiled.ir.devices.find((d) => d.designation === "K1"),
    "Missing K1",
  );
  const coilFn = required(
    compiled.ir.functions.find(
      (f) => f.id.deviceUid === k1.uid && f.kind === "coil",
    ),
    "Missing K1 coil",
  );
  const { cloned, contacts } = withSyntheticContacts(
    compiled.ir,
    k1.uid,
    contactCount,
  );
  const { groups } = await prepareCircuitView(cloned, {
    format: "circuit-view-request/0.1",
    title: "TTB coil relation caption #32",
    flow: "top-to-bottom",
    groups: [
      {
        id: "coil-group",
        label: "Coil",
        lineReference: "200",
        conductors: [],
        functions: [
          {
            device: { by: "uid", value: k1.uid },
            key: coilFn.id.functionKey,
          },
        ],
      },
      {
        id: "contact-group",
        label: "Contacts",
        lineReference: "300",
        conductors: [],
        functions: contacts.map((c) => ({
          device: { by: "uid", value: k1.uid },
          key: c.id.functionKey,
        })),
      },
    ],
  });
  return {
    k1Uid: k1.uid,
    content: required(groups[0], "Missing coil group").content,
  };
}

describe("TTB coil relation captions (#32)", () => {
  it.each([1, 4, 6])(
    "keeps TTB coil relation caption clear of coil conductor and A2 (%i contacts)",
    async (contactCount) => {
      const { k1Uid, content } = await renderTtbCoilGroup(contactCount);
      const doc = parseHTML(content).document;
      const a2Circle = required(
        doc.querySelector(
          `[data-terminal-id='${JSON.stringify([k1Uid, "A2"])}'] circle`,
        ),
        "Missing A2 marker",
      );
      const coilX = Number(a2Circle.getAttribute("cx"));
      const a2Y = Number(a2Circle.getAttribute("cy"));
      const relTexts = [...doc.querySelectorAll("text")].filter((t) =>
        (t.textContent ?? "").includes(": 300"),
      );
      expect(relTexts.length).toBeGreaterThan(0);
      for (const rel of relTexts) {
        expect(rel.getAttribute("text-anchor")).toBe("start");
        expect(Number(rel.getAttribute("x")) - coilX).toBeGreaterThanOrEqual(
          2.5,
        );
        expect(a2Y - Number(rel.getAttribute("y"))).toBeGreaterThanOrEqual(2.0);
      }
    },
  );
});
