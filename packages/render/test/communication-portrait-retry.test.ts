import { beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseHTML } from "linkedom";
import BundledElk from "elkjs/lib/elk.bundled.js";
import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import {
  prepareCommunicationDrawing,
  type CommunicationDrawing,
  type CommunicationViewRequest,
} from "../src/communication.js";
import {
  CommunicationFitError,
  isCommunicationCompactFitError,
  runCommunicationPagination,
} from "../src/communication-pagination.js";
import { CircuitRenderError } from "../src/render-error-context.js";
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

const UNFIT_UNIT_PREAMBLE =
  "A complete communication link or device and its references cannot fit at readable size; use larger paper or shorter labels.";

async function withReportFixtureCopy<T>(
  mutate: (source: { objects: Record<string, unknown>[] }) => void,
  run: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "thermite-comm-caption-"));
  try {
    const projectDir = join(dir, "project");
    await cp(resolve("examples/report-filtering"), projectDir, {
      recursive: true,
    });
    const sourcePath = join(projectDir, "source.json");
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    mutate(source);
    await writeFile(sourcePath, JSON.stringify(source, null, 2));
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runPortraitCommunicationCli(
  dir: string,
  devices?: readonly string[],
) {
  const requestPath = join(
    dir,
    devices ? "request-single.json" : "request-multi.json",
  );
  await writeFile(
    requestPath,
    JSON.stringify({
      format: "schematic-packet-request/0.1",
      page: { size: "letter", orientation: "portrait" },
      views: [{ ...ethernetView, ...(devices ? { devices } : {}) }],
    }),
  );
  return runCliPacket(join(dir, "project"), requestPath, []);
}

function assertNativeR006CliStderr(
  cli: ReturnType<typeof spawnSync>,
  expectedWidth: number,
  multiUnit: boolean,
) {
  expect(cli.status).toBe(1);
  expect(cli.stdout).toBe("");
  const payload = JSON.parse(String(cli.stderr));
  expect(payload.error.code).toBe("R006");
  expect(payload.error.reason).toBe("unprintable-layout");
  expect(requiredWidthDetail(payload.error.details)).toBeCloseTo(
    expectedWidth,
    3,
  );
  expect(payload.error.message).toContain(`${expectedWidth.toFixed(2)} ×`);
  expect(payload.error.message).toContain(
    "Communication view cannot fit at readable text size.",
  );
  expect(payload.error.message.includes(UNFIT_UNIT_PREAMBLE)).toBe(multiUnit);
  expect(payload.error.details.deviceTags?.length).toBeGreaterThanOrEqual(2);
}

function fakeCommunicationDrawing(
  width: number,
  relationIds: readonly string[],
  deviceUids: readonly string[],
): CommunicationDrawing {
  return {
    title: "Ethernet connections",
    content: "",
    width,
    height: 40,
    references: [],
    note: "",
    topologyCoverage: {
      kind: "communication",
      relationIds: [...relationIds],
      deviceUids: [...deviceUids],
      ports: [],
    },
  };
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

  it("widens compact boxes for an indivisible caption cluster and issues both single-unit and multi-unit views via public CLI at scale 1.000", async () => {
    const caption = Array(20).fill("W").join("\u200d");
    const ethLinks = reportIr.relations
      .filter((r) => r.connection?.medium === "ethernet")
      .map((r) => r.uid);
    await withReportFixtureCopy(
      (source) => {
        const plc1 = source.objects.find((o) => o.designation === "PLC1");
        if (plc1) plc1.location = caption;
      },
      async (dir) => {
        const single = await runPortraitCommunicationCli(dir, ["PLC1"]);
        expect(single.status, String(single.stderr)).toBe(0);
        const singlePacket: RenderedPacket = JSON.parse(String(single.stdout));
        assertPortraitCommunicationPacket(singlePacket, 1, [ethLinks[0]!]);
        expect(singlePacket.sheets[0]?.svg).toContain(caption);

        const multi = await runPortraitCommunicationCli(dir);
        expect(multi.status, String(multi.stderr)).toBe(0);
        const multiPacket: RenderedPacket = JSON.parse(String(multi.stdout));
        assertPortraitCommunicationPacket(multiPacket, 3, ethLinks);
        expect(multiPacket.sheets[0]?.svg).toContain(caption);
      },
    );
  });

  it("preserves the exact native R006 via public CLI when widened compact captions exceed Letter portrait", async () => {
    const wideCaption = Array(23).fill("W").join("\u200d");
    await withReportFixtureCopy(
      (source) => {
        for (const name of ["PLC1", "DOC1"]) {
          const device = source.objects.find((o) => o.designation === name);
          if (device) device.location = wideCaption;
        }
        const net1 = source.objects.find((o) => o.designation === "NET1");
        if (net1) net1.designation = "ETHERNET_LINK_01";
      },
      async (dir) => {
        const compiled = await compileProject(join(dir, "project"));
        if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
        const nativeSingle = await prepareCommunicationDrawing(compiled.ir, {
          ...ethernetView,
          devices: ["PLC1"],
        });
        assertNativeR006CliStderr(
          await runPortraitCommunicationCli(dir, ["PLC1"]),
          nativeSingle.width,
          false,
        );
        assertNativeR006CliStderr(
          await runPortraitCommunicationCli(dir),
          nativeSingle.width,
          true,
        );
      },
    );
  });

  it("preserves the exact native R006 via public CLI when compact retry hits device-tag overflow", async () => {
    const tagCluster = Array(19).fill("W").join("\u200d");
    await withReportFixtureCopy(
      (source) => {
        const plc1 = source.objects.find((o) => o.designation === "PLC1");
        if (plc1) plc1.description = tagCluster;
      },
      async (dir) => {
        const compiled = await compileProject(join(dir, "project"));
        if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
        const nativeSingle = await prepareCommunicationDrawing(compiled.ir, {
          ...ethernetView,
          devices: ["PLC1"],
        });
        assertNativeR006CliStderr(
          await runPortraitCommunicationCli(dir, ["PLC1"]),
          nativeSingle.width,
          false,
        );
        assertNativeR006CliStderr(
          await runPortraitCommunicationCli(dir),
          nativeSingle.width,
          true,
        );
      },
    );
  });

  it("falls back to the native outcome on compact CommunicationFitError for single-unit and multi-unit views", async () => {
    const ethLinks = reportIr.relations.filter(
      (r) => r.connection?.medium === "ethernet",
    );
    const singleLink = ethLinks[0]!;
    const singleDrawing = fakeCommunicationDrawing(
      210,
      [singleLink.uid],
      [singleLink.fromDeviceUid, singleLink.toDeviceUid],
    );
    const multiDrawing = fakeCommunicationDrawing(
      340,
      ethLinks.map((l) => l.uid),
      [...new Set(ethLinks.flatMap((l) => [l.fromDeviceUid, l.toDeviceUid]))],
    );
    const nativeErr = new Error("native-multi-r006");
    const unfit = () => nativeErr;
    const neverFits = () => false;

    for (const kind of [
      "caption-width",
      "port-identity-width",
      "port-identity-split",
    ] as const) {
      expect(
        await runCommunicationPagination(
          async (_ir, _req, _proj, profile) => {
            if (profile)
              throw new CommunicationFitError(kind, `compact ${kind}`);
            return singleDrawing;
          },
          reportIr,
          ethernetView,
          neverFits,
          unfit,
        ),
      ).toEqual([singleDrawing]);

      await expect(
        runCommunicationPagination(
          async (_ir, _req, _proj, profile) => {
            if (profile)
              throw new CommunicationFitError(kind, `compact ${kind}`);
            return multiDrawing;
          },
          reportIr,
          ethernetView,
          neverFits,
          unfit,
        ),
      ).rejects.toBe(nativeErr);
    }
  });

  it("classifies compact fit errors without swallowing integrity or non-R006 errors", async () => {
    const firstLink = reportIr.relations.find(
      (r) => r.connection?.medium === "ethernet",
    )!;
    const singleDrawing = fakeCommunicationDrawing(
      210,
      [firstLink.uid],
      [firstLink.fromDeviceUid, firstLink.toDeviceUid],
    );
    expect(
      isCommunicationCompactFitError(
        new CircuitRenderError({
          code: "R006",
          reason: "unprintable-layout",
          root: "PLC1",
          message: "tag overflow",
        }),
      ),
    ).toBe(true);
    expect(
      isCommunicationCompactFitError(
        new CircuitRenderError({
          code: "R003",
          root: "PLC1",
          family: "control",
          message: "unsupported",
        }),
      ),
    ).toBe(false);
    expect(
      isCommunicationCompactFitError(
        new Error("Topology layout did not conserve selected identities."),
      ),
    ).toBe(false);

    const integrityFault = new Error("compact layout integrity fault");
    await expect(
      runCommunicationPagination(
        async (_ir, _req, _proj, profile) => {
          if (profile) throw integrityFault;
          return singleDrawing;
        },
        reportIr,
        ethernetView,
        () => false,
        () => new Error("unused"),
      ),
    ).rejects.toBe(integrityFault);
  });
});
