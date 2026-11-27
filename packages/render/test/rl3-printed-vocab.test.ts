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
});
