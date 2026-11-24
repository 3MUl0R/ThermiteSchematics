import { beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import BundledElk from "elkjs/lib/elk.bundled.js";
import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import {
  prepareCommunicationDrawing,
  type CommunicationViewRequest,
} from "../src/communication.js";
import {
  renderSchematicPacket,
  type RenderedPacket,
  type SchematicPacketRequest,
} from "../src/sheets.js";
import {
  cases as drawCorpusCases,
  prepareRequest,
} from "../../../evals/draw/corpus.mjs";

let reportIr: ElectricalIr;
let reportRequest: SchematicPacketRequest;
let networkIr: ElectricalIr;
let networkRequest: SchematicPacketRequest;

beforeAll(async () => {
  const [rf, np] = await Promise.all([
    compileProject(resolve("examples/report-filtering")),
    compileProject(resolve("examples/network-pagination")),
  ]);
  if (!rf.ok) throw Error(JSON.stringify(rf.diagnostics));
  if (!np.ok) throw Error(JSON.stringify(np.diagnostics));
  reportIr = rf.ir;
  networkIr = np.ir;
  reportRequest = JSON.parse(
    await readFile(resolve("examples/report-filtering/packet.json"), "utf8"),
  );
  networkRequest = JSON.parse(
    await readFile(resolve("examples/network-pagination/packet.json"), "utf8"),
  );
});

const ethernetView: CommunicationViewRequest = {
  format: "communication-view-request/0.1",
  medium: "ethernet",
};

function effectiveTextScale(element: Element): number {
  let scale = 1;
  for (let owner = element.parentElement; owner; owner = owner.parentElement) {
    const match = owner.getAttribute("transform")?.match(/scale\(([\d.]+)\)/);
    if (match) scale *= Number(match[1]);
  }
  return scale;
}

function assertPortraitCommunicationPacket(
  packet: RenderedPacket,
  expectedParts: number,
  expectedLinks: readonly string[],
) {
  const commSheets = packet.sheets.filter(
    (s) => s.view.kind === "communication",
  );
  expect(commSheets).toHaveLength(expectedParts);
  const seenLinks: string[] = [];
  for (const sheet of commSheets) {
    const doc = parseHTML(sheet.svg).document;
    for (const el of doc.querySelectorAll("[data-communication-link]")) {
      const uid = el.getAttribute("data-communication-link");
      if (uid) seenLinks.push(uid);
    }
    const diagramTexts = [...doc.querySelectorAll("text[font-size='2.7']")];
    expect(diagramTexts.length).toBeGreaterThan(0);
    for (const textEl of diagramTexts) {
      const scale = effectiveTextScale(textEl);
      expect(scale).toBe(1);
      expect(2.7 * scale).toBeGreaterThanOrEqual(2.5);
    }
    for (const textEl of doc.querySelectorAll("text")) {
      const size = Number(textEl.getAttribute("font-size"));
      expect(size * effectiveTextScale(textEl)).toBeGreaterThanOrEqual(2.5);
    }
    for (const cont of sheet.communicationContinuations ?? []) {
      const target = packet.sheets[cont.toSheet - 1];
      expect(target).toBeDefined();
      expect(
        target?.references.some((ref) => ref.deviceUid === cont.deviceUid),
      ).toBe(true);
      expect(target?.communicationContinuations).toContainEqual({
        view: cont.view,
        fromPart: cont.toPart,
        toPart: cont.fromPart,
        toSheet: sheet.number,
        deviceUid: cont.deviceUid,
      });
    }
  }
  expect(seenLinks.sort()).toEqual([...expectedLinks].sort());
}

function runCliPacket(
  project: string,
  input: string,
  extraArgs: readonly string[],
) {
  return spawnSync(
    process.execPath,
    [
      resolve("thermite.mjs"),
      "packet",
      "--project",
      resolve(project),
      "--input",
      resolve(input),
      ...extraArgs,
      "--json",
    ],
    { encoding: "utf8" },
  );
}

function requiredWidthDetail(
  details: Record<string, unknown> | undefined,
): number | undefined {
  const dimensions = details?.dimensions;
  if (!dimensions || typeof dimensions !== "object") return undefined;
  const value = Reflect.get(dimensions, "requiredWidthMm");
  return typeof value === "number" ? value : undefined;
}

describe("compact horizontal retry for width-bound Ethernet communication views", () => {
  it.each([
    ["letter", "standard"],
    ["letter", "compact"],
    ["a4", "standard"],
    ["a4", "compact"],
  ] as const)(
    "issues examples/report-filtering on %s portrait (%s) via public CLI at scale 1.000",
    (paper, layout) => {
      const cli = runCliPacket(
        "examples/report-filtering",
        "examples/report-filtering/packet.json",
        ["--paper", paper, "--orientation", "portrait", "--layout", layout],
      );
      expect(cli.status, cli.stderr).toBe(0);
      const packet: RenderedPacket = JSON.parse(cli.stdout);
      expect(packet.sheets).toHaveLength(10);
      const linkIds = reportIr.relations
        .filter((r) => r.connection?.medium === "ethernet")
        .map((r) => r.uid);
      assertPortraitCommunicationPacket(packet, 3, linkIds);
    },
  );

  it("issues all 8 sweep-report-filtering-letter-portrait flow variants with conserved ports and reciprocal continuations", async () => {
    const letterPortraitSpecs = drawCorpusCases().filter((c) =>
      c.id.startsWith("sweep-report-filtering-letter-portrait-"),
    );
    expect(letterPortraitSpecs).toHaveLength(4);
    const linkIds = reportIr.relations
      .filter((r) => r.connection?.medium === "ethernet")
      .map((r) => r.uid);
    for (const spec of letterPortraitSpecs) {
      for (const sweepFlow of ["left-to-right", "top-to-bottom"] as const) {
        const prepared: SchematicPacketRequest = await prepareRequest(
          { ...spec, flow: sweepFlow },
          resolve("."),
        );
        const rendered = await renderSchematicPacket(reportIr, prepared);
        expect(rendered.ok, rendered.ok ? "" : rendered.error.message).toBe(
          true,
        );
        if (!rendered.ok) continue;
        expect(rendered.value.sheets).toHaveLength(10);
        assertPortraitCommunicationPacket(rendered.value, 3, linkIds);
      }
    }
  });

  it("recovers a single Ethernet link and a 2-link branch on portrait paper without redundant pagination", async () => {
    const singleLinkIr = structuredClone(reportIr);
    const ethLinks = singleLinkIr.relations.filter(
      (r) => r.connection?.medium === "ethernet",
    );
    const firstLink = ethLinks[0];
    if (!firstLink) throw Error("Expected an ethernet link in fixture.");
    singleLinkIr.relations = [firstLink];
    for (const size of ["letter", "a4"] as const) {
      const res = await renderSchematicPacket(singleLinkIr, {
        format: "schematic-packet-request/0.1",
        page: { size, orientation: "portrait" },
        views: [ethernetView],
      });
      expect(res.ok, res.ok ? "" : res.error.message).toBe(true);
      if (!res.ok) continue;
      assertPortraitCommunicationPacket(res.value, 1, [firstLink.uid]);
      expect(res.value.sheets[0]?.view.title).toBe("Ethernet connections");
    }

    const branchedIr = structuredClone(reportIr);
    const doc1 = branchedIr.devices.find((d) => d.designation === "DOC1");
    const plc1 = branchedIr.devices.find((d) => d.designation === "PLC1");
    const plc2 = branchedIr.devices.find((d) => d.designation === "PLC2");
    if (!doc1 || !plc1 || !plc2) throw Error("Missing fixture devices.");
    const linkA = {
      ...firstLink,
      uid: "79000000-0000-4000-8000-000000000098",
      designation: "NET8",
      fromDeviceUid: doc1.uid,
      toDeviceUid: plc1.uid,
      connection: {
        ...firstLink.connection,
        fromPort: "IN",
        toPort: "ETH",
        medium: "ethernet" as const,
      },
    };
    const linkB = {
      ...firstLink,
      uid: "79000000-0000-4000-8000-000000000099",
      designation: "NET9",
      fromDeviceUid: doc1.uid,
      toDeviceUid: plc2.uid,
      connection: {
        ...firstLink.connection,
        fromPort: "OUT",
        toPort: "ETH",
        medium: "ethernet" as const,
      },
    };
    branchedIr.relations = [linkA, linkB];
    const branched = await renderSchematicPacket(branchedIr, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "portrait" },
      views: [{ ...ethernetView, devices: ["DOC1"] }],
    });
    expect(branched.ok, branched.ok ? "" : branched.error.message).toBe(true);
    if (!branched.ok) return;
    assertPortraitCommunicationPacket(branched.value, 1, [
      linkA.uid,
      linkB.uid,
    ]);
    expect(branched.value.sheets[0]?.view.title).toBe("Ethernet connections");
  });

  it("widens compact boxes for long atomic port keys so port keys never split", async () => {
    const longPortIr = structuredClone(reportIr);
    const longKey = "ETH_UPLINK_PORT_01";
    const ctrl = longPortIr.deviceTypes.find(
      (t) => t.id === "filter-fixture:controller",
    );
    if (!ctrl?.ports?.ETH) throw Error("Missing controller ETH port.");
    ctrl.ports[longKey] = {
      ...ctrl.ports.ETH,
      description: "Primary controller uplink",
    };
    delete ctrl.ports.ETH;
    for (const rel of longPortIr.relations) {
      if (rel.connection?.fromPort === "ETH") rel.connection.fromPort = longKey;
      if (rel.connection?.toPort === "ETH") rel.connection.toPort = longKey;
    }
    const res = await renderSchematicPacket(longPortIr, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "portrait" },
      views: [ethernetView],
    });
    expect(res.ok, res.ok ? "" : res.error.message).toBe(true);
    if (!res.ok) return;
    const commSheets = res.value.sheets.filter(
      (s) => s.view.kind === "communication",
    );
    const keyTexts = commSheets.flatMap((s) =>
      [
        ...parseHTML(s.svg).document.querySelectorAll(
          `[data-communication-port="${longKey}"]`,
        ),
      ].map((group) => group.querySelector("text")?.textContent ?? ""),
    );
    expect(keyTexts.length).toBeGreaterThan(0);
    for (const firstLine of keyTexts)
      expect(firstLine.startsWith(longKey)).toBe(true);
  });

  it("keeps fitting native communication views on the native 66 mm / 32 mm path without invoking compact retry", async () => {
    const prototype: ELK = Reflect.get(BundledElk, "prototype");
    const original = prototype.layout;
    const seenGaps: string[] = [];
    const spy = vi.spyOn(prototype, "layout").mockImplementation(function (
      this: ELK,
      graph: ElkNode,
    ) {
      if (graph.id === "communication") {
        const gap =
          graph.layoutOptions?.["elk.layered.spacing.nodeNodeBetweenLayers"];
        if (gap) seenGaps.push(gap);
      }
      return original.call(this, graph);
    });
    try {
      const r1 = await renderSchematicPacket(reportIr, {
        ...reportRequest,
        page: { size: "letter", orientation: "landscape" },
      });
      expect(r1.ok).toBe(true);
      const r2 = await renderSchematicPacket(networkIr, networkRequest);
      expect(r2.ok).toBe(true);
      expect(seenGaps.length).toBeGreaterThan(0);
      expect(seenGaps.every((g) => g === "32" || g === "6")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the exact original native R006 when an unbreakable overlong link label exceeds Letter portrait under compact retry", async () => {
    const overlongLabel = "A_UNBREAKABLE_ETHERNET_TRUNK_".repeat(4);
    const multiIr = structuredClone(reportIr);
    const firstEth = multiIr.relations.find(
      (r) => r.connection?.medium === "ethernet",
    );
    if (!firstEth) throw Error("Expected an ethernet link.");
    firstEth.designation = overlongLabel;

    const singleIr = structuredClone(multiIr);
    singleIr.relations = [firstEth];
    const nativeSingle = await prepareCommunicationDrawing(
      singleIr,
      ethernetView,
    );

    const [multiRefusal, singleRefusal] = await Promise.all([
      renderSchematicPacket(multiIr, {
        format: "schematic-packet-request/0.1",
        page: { size: "letter", orientation: "portrait" },
        views: [ethernetView],
      }),
      renderSchematicPacket(singleIr, {
        format: "schematic-packet-request/0.1",
        page: { size: "letter", orientation: "portrait" },
        views: [ethernetView],
      }),
    ]);
    expect(multiRefusal.ok).toBe(false);
    expect(singleRefusal.ok).toBe(false);
    if (!multiRefusal.ok && !singleRefusal.ok) {
      expect(multiRefusal.error.code).toBe("R006");
      expect(multiRefusal.error.reason).toBe("unprintable-layout");
      expect(requiredWidthDetail(multiRefusal.error.details)).toBeCloseTo(
        nativeSingle.width,
        3,
      );
      expect(multiRefusal.error.message).toContain(
        `${nativeSingle.width.toFixed(2)} ×`,
      );
      expect(singleRefusal.error.code).toBe("R006");
      expect(requiredWidthDetail(singleRefusal.error.details)).toBeCloseTo(
        nativeSingle.width,
        3,
      );
    }
  });

  it("returns the exact original native R006 when an unbreakable overlong designation exceeds Letter portrait under compact retry", async () => {
    const longDesigIr = structuredClone(reportIr);
    const plc1 = longDesigIr.devices.find((d) => d.designation === "PLC1");
    if (!plc1) throw Error("Missing PLC1.");
    plc1.designation = "UNBREAKABLE_CONTROLLER_DESIGNATION_".repeat(3);
    const plc1Link = longDesigIr.relations.find(
      (r) =>
        r.connection?.medium === "ethernet" && r.fromDeviceUid === plc1.uid,
    );
    if (!plc1Link) throw Error("Missing PLC1 link.");
    longDesigIr.relations = [plc1Link];
    const nativeLongDesig = await prepareCommunicationDrawing(
      longDesigIr,
      ethernetView,
    );
    const desigRefusal = await renderSchematicPacket(longDesigIr, {
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "portrait" },
      views: [ethernetView],
    });
    expect(desigRefusal.ok).toBe(false);
    if (!desigRefusal.ok) {
      expect(desigRefusal.error.code).toBe("R006");
      expect(requiredWidthDetail(desigRefusal.error.details)).toBeCloseTo(
        nativeLongDesig.width,
        3,
      );
      expect(desigRefusal.error.message).toContain(
        `${nativeLongDesig.width.toFixed(2)} ×`,
      );
    }
  });
});
