import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileProject } from "@thermite/compiler";
import {
  renderSchematicPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";

function allText(svg: string): string[] {
  return [...parseHTML(svg).document.querySelectorAll("text")].map(
    (el) => el.textContent ?? "",
  );
}

describe("RL3 printed vocabulary — rendered packets", () => {
  it("KEY-04: prints human port endpoints in assembly destination pointers and peer captions without altering terminal strips", async () => {
    const cap = await compileProject("examples/cap-pagination");
    if (!cap.ok) throw Error(JSON.stringify(cap.diagnostics));
    const capReq: SchematicPacketRequest = JSON.parse(
      await readFile("examples/cap-pagination/packet.json", "utf8"),
    );
    const capPkt = await renderSchematicPacket(cap.ir, capReq);
    if (!capPkt.ok) throw Error(capPkt.error.message);

    const s1Pointer = parseHTML(
      capPkt.value.sheets[0]!.svg,
    ).document.querySelector("[data-assembly-port-destinations]")?.textContent;
    expect(s1Pointer).toContain("Port R1: X06 → 02.B3;");
    expect(s1Pointer).toContain("Port R1: X12 → 03.B4.");
    expect(s1Pointer).not.toMatch(/\bR1\.X\d+/u);

    const s2Peer = [
      ...parseHTML(capPkt.value.sheets[1]!.svg).document.querySelectorAll(
        '[data-peer-reference="assembly-inventory"]',
      ),
    ].find((el) => el.textContent?.includes("CBL1"));
    expect(s2Peer?.textContent).toBe("R1: X09 · CBL1 inventory → 04.D3");

    const topo = await compileProject("examples/topology-coverage");
    if (!topo.ok) throw Error(JSON.stringify(topo.diagnostics));
    const topoReq: SchematicPacketRequest = JSON.parse(
      await readFile("examples/topology-coverage/packet.json", "utf8"),
    );
    const topoPkt = await renderSchematicPacket(topo.ir, topoReq);
    if (!topoPkt.ok) throw Error(topoPkt.error.message);
    const topoS1Peers = [
      ...parseHTML(topoPkt.value.sheets[0]!.svg).document.querySelectorAll(
        '[data-peer-reference="attachment"]',
      ),
    ].map((el) => el.textContent);
    expect(topoS1Peers).toContain("R1: X2 · CAP-X2 → 02.A3");
    expect(topoS1Peers).toContain("R1: X4 · W2 → 03.A3");

    // Negative control: terminal-strip physical incidence W2 → S1.P stays unchanged.
    const filtering = await compileProject("examples/report-filtering");
    if (!filtering.ok) throw Error(JSON.stringify(filtering.diagnostics));
    const filterReq: SchematicPacketRequest = JSON.parse(
      await readFile("examples/report-filtering/packet.json", "utf8"),
    );
    const filterPkt = await renderSchematicPacket(filtering.ir, filterReq);
    if (!filterPkt.ok) throw Error(filterPkt.error.message);
    const terminalTexts = filterPkt.value.sheets.flatMap((s) => allText(s.svg));
    expect(terminalTexts.some((t) => t.includes("W2 -> S1.P"))).toBe(true);
  });

  it("V5-05: network-inventory pointer caption names undesignated link with both endpoints matching the inventory row", async () => {
    const rm3 = await compileProject("packages/core-library/test/fixtures/rm3");
    if (!rm3.ok) throw Error(JSON.stringify(rm3.diagnostics));
    const ir = structuredClone(rm3.ir);
    const link = ir.relations.find((r) => r.connection)!;
    delete link.designation;
    const request: SchematicPacketRequest = {
      format: "schematic-packet-request/0.1",
      views: [
        {
          format: "communication-view-request/0.1",
          medium: "ethernet",
        },
        {
          format: "documentation-view-request/0.1",
          kind: "network",
        },
      ],
    };
    const packet = await renderSchematicPacket(ir, request);
    if (!packet.ok) throw Error(packet.error.message);
    const commTexts = allText(packet.value.sheets[0]!.svg).join(" ");
    expect(commTexts).toContain("PLC1: ETH ↔ HMI1: ETH");
    expect(commTexts).not.toMatch(
      /network inventory \d+\.[A-Z]\d+ \(HMI1: ETH\)/u,
    );
    const row = packet.value.navigation?.documents
      ?.find((d) => d.kind === "network")
      ?.rows.find((r) => r.nativeKey === link.uid);
    expect(row?.displayName).toBe("PLC1: ETH ↔ HMI1: ETH");

    // Negative control: designated link keeps its designation.
    const designated = await renderSchematicPacket(rm3.ir, request);
    if (!designated.ok) throw Error(designated.error.message);
    const desTexts = allText(designated.value.sheets[0]!.svg).join(" ");
    expect(desTexts).toContain("(NET1)");
  });

  it("KEY-01: Murr 28501 prints human group headings with no snake_case keys and passes W908 lint", async () => {
    const murr = await compileProject("libraries/murr-pilot/examples/28501");
    if (!murr.ok) throw Error(JSON.stringify(murr.diagnostics));
    const murrReq: SchematicPacketRequest = JSON.parse(
      await readFile(
        "libraries/murr-pilot/examples/28501/packet.request.json",
        "utf8",
      ),
    );
    const murrPkt = await renderSchematicPacket(
      murr.ir,
      murrReq,
      murr.presentation,
    );
    if (!murrPkt.ok) throw Error(murrPkt.error.message);
    const headings = murrPkt.value.sheets.flatMap((s) =>
      [
        ...parseHTML(s.svg).document.querySelectorAll(
          "text[data-circuit-source-heading]",
        ),
      ].map((t) => t.textContent ?? ""),
    );
    expect(headings).toEqual([
      "Earth in / Earth out",
      "Valve output",
      "Supply input / Supply common",
      "Signal common left",
      "Command input",
      "Reference output",
      "Signal common right",
    ]);
    expect(
      murrPkt.value.coverage.diagnostics?.filter((d) => d.code === "W908") ??
        [],
    ).toHaveLength(0);
  });

  it("KEY-01 lint: warns with W908 when a circuit group label repeats a snake_case key, and ignores human/pin headings", async () => {
    const murr = await compileProject("libraries/murr-pilot/examples/28501");
    if (!murr.ok) throw Error(JSON.stringify(murr.diagnostics));
    const murrReq: SchematicPacketRequest = JSON.parse(
      await readFile(
        "libraries/murr-pilot/examples/28501/packet.request.json",
        "utf8",
      ),
    );
    const view = murrReq.views[0];
    if (!view || view.format !== "circuit-view-request/0.1")
      throw Error("Expected circuit view");
    const badReq: SchematicPacketRequest = {
      ...murrReq,
      views: [
        {
          ...view,
          groups: view.groups.map((g, index) =>
            index === 0
              ? { ...g, label: "earth_in / earth_out" }
              : index === 1
                ? { ...g, label: "valve_output" }
                : index === 2
                  ? { ...g, label: "unrelated_snake_label" }
                  : g,
          ),
        },
      ],
    };
    const badPkt = await renderSchematicPacket(
      murr.ir,
      badReq,
      murr.presentation,
    );
    if (!badPkt.ok) throw Error(badPkt.error.message);
    const w908 =
      badPkt.value.coverage.diagnostics?.filter((d) => d.code === "W908") ?? [];
    expect(w908).toHaveLength(2);
    expect(w908.every((d) => d.severity === "warning")).toBe(true);
    expect(w908[0]?.message).toContain('"earth_in", "earth_out"');
    expect(w908[1]?.message).toContain('"valve_output"');

    // Negative control: Siemens KEY-02 headings (physical pin names / SUPPLY) stay untouched and emit 0 W908.
    const siemens = await compileProject(
      "libraries/siemens-pilot/examples/6es7151-3aa23-0ab0",
    );
    if (!siemens.ok) throw Error(JSON.stringify(siemens.diagnostics));
    const siemensReq: SchematicPacketRequest = JSON.parse(
      await readFile(
        "libraries/siemens-pilot/examples/6es7151-3aa23-0ab0/packet.request.json",
        "utf8",
      ),
    );
    const siemensPkt = await renderSchematicPacket(
      siemens.ir,
      siemensReq,
      siemens.presentation,
    );
    if (!siemensPkt.ok) throw Error(siemensPkt.error.message);
    expect(
      siemensPkt.value.coverage.diagnostics?.filter((d) => d.code === "W908") ??
        [],
    ).toHaveLength(0);
  });
});
