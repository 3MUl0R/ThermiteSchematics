import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { compileCoreProjectFixture, required } from "./fixtures.js";
import { renderSchematicPacket } from "../src/index.js";
import type { SchematicPacketRequest, RenderedPacket } from "../src/sheets.js";
import type { RootedCandidate } from "../src/packet/rooted-build.js";
import { circuitInlineTrace } from "../src/layout/circuit-inline-context.js";
import {
  foldCandidateAllowed,
  MAX_FOLD_BRANCH_LAYOUTS,
  MAX_FOLD_EXTRA_REQUESTS,
} from "../src/packet/rooted-fold-search.js";
import { foldDecisionTrace } from "../src/packet/fold-final-context.js";
import * as crop from "../src/packet/fold-crop.js";
import { rootedGangSegments } from "../src/symbols/rooted-gangs.js";

const power = {
  format: "schematic-view-request/0.1",
  family: "power",
  flow: "left-to-right",
  root: { by: "designation", value: "M1" },
} as const;
const request: SchematicPacketRequest = {
  format: "schematic-packet-request/0.1",
  layout: "compact",
  page: { size: "tabloid", orientation: "portrait" },
  views: [
    power,
    {
      format: "schematic-view-request/0.1",
      family: "control",
      flow: "left-to-right",
      root: { by: "designation", value: "K1" },
    },
  ],
};
let fixture: Awaited<ReturnType<typeof compileCoreProjectFixture>>;
let packet: RenderedPacket;
let candidate: RootedCandidate;
beforeAll(async () => {
  fixture = await compileCoreProjectFixture();
  const trace: NonNullable<Parameters<typeof circuitInlineTrace.run>[0]> = [];
  const result = await circuitInlineTrace.run(trace, () =>
    renderSchematicPacket(fixture.ir, request, fixture.presentation),
  );
  if (!result.ok) throw Error(JSON.stringify(result.error));
  packet = result.value;
  candidate = required(required(required(trace[0]).runs[0]).power).original;
}, 30000);
afterEach(() => vi.restoreAllMocks());

it("keeps the authored motor in FIELD with two safe strips and four reciprocal pairs on the original power sheet", () => {
  expect(packet.sheets.length).toBe(2);
  const sheet = required(packet.sheets[0]);
  expect(sheet.number).toBe(1);
  expect(candidate.drafts.length).toBe(1);
  expect(required(candidate.drafts[0]).rootedSections?.length).toBe(2);
  expect(candidate.scale).toBe(0.25);
  const links = sheet.continuations ?? [];
  expect(links.length).toBe(8);
  expect([...new Set(links.map((l) => l.conductor))].sort()).toEqual([
    "L1-CB1-K1",
    "L2-CB1-K1",
    "L3-CB1-K1",
    "PE-SRC-M1",
  ]);
  for (const id of new Set(links.map((l) => l.id))) {
    const pair = links.filter((l) => l.id === id);
    expect(pair.map((l) => l.end).sort()).toEqual([0, 1]);
    expect(pair.map((l) => l.toSheet)).toEqual([1, 1]);
  }
  expect(
    new Set(links.filter((l) => l.conductor === "PE-SRC-M1").map((l) => l.id))
      .size,
  ).toBe(1);
  const doc = parseHTML(sheet.svg).document;
  const strips = [...doc.querySelectorAll("svg[data-layout-config-version]")];
  expect(strips.length).toBe(2);
  const second = required(required(candidate.drafts[0]).rootedSections?.[1]);
  const field = required(
    candidate.prepared.graph.locationGroups.find(
      (g) => g.label.text === "FIELD",
    ),
  );
  expect(second.continuedLocationIds).toContain(field.label.id);
  expect(sheet.svg).toContain("CONTINUED LOCATION: FIELD / MAIN-PANEL");
  const mark = required(
    candidate.prepared.graph.nodes.find(
      (n) => "designation" in n && n.designation === "M1",
    ),
  );
  const box = required(
    candidate.prepared.layout.nodes.find((n) => n.id === mark.id),
  );
  expect(box.x).toBeGreaterThanOrEqual(second.viewport.x);
  expect(box.x + box.width).toBeLessThanOrEqual(
    second.viewport.x + second.viewport.w,
  );
  const fieldBox = required(
    candidate.prepared.layout.nodes.find((n) => n.id === field.id),
  );
  expect(box.x).toBeGreaterThanOrEqual(fieldBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width);
  const motor = required(
    fixture.ir.devices.find((d) => d.designation === "M1"),
  );
  expect(motor.location).toBe("FIELD");
});

it("bounds rejected branch alternatives by logical ELK requests, including exact cache hits", async () => {
  vi.spyOn(crop, "croppedFoldCandidates").mockReturnValue([]);
  const trace: NonNullable<Parameters<typeof circuitInlineTrace.run>[0]> = [];
  const decisions: NonNullable<Parameters<typeof foldDecisionTrace.run>[0]> =
    [];
  const result = await foldDecisionTrace.run(decisions, () =>
    circuitInlineTrace.run(trace, () =>
      renderSchematicPacket(fixture.ir, request, fixture.presentation),
    ),
  );
  expect(result.ok).toBe(true);
  const decision = required(decisions[0]);
  const work = required(required(required(trace[0]).runs[0]).power).work;
  expect(decision.branchRequests).toBe(2);
  expect(decision.qualityRequests).toBe(0);
  expect(work.calls - decision.referenceRequests).toBe(2);
  expect(MAX_FOLD_BRANCH_LAYOUTS).toBe(2);
  expect(MAX_FOLD_EXTRA_REQUESTS).toBe(4);
  expect(work.calls).toBeLessThanOrEqual(work.limit);
}, 30000);

it("rejects an endpoint ownership substitution", () => {
  expect(
    foldCandidateAllowed(fixture.ir, candidate, candidate, packet.page),
  ).toBe(true);
  const edge = required(candidate.prepared.layout.edges[0]);
  const other = required(
    candidate.prepared.layout.edges.find(
      (e) => e.sourcePortId !== edge.sourcePortId,
    ),
  );
  const bad: RootedCandidate = {
    ...candidate,
    prepared: {
      ...candidate.prepared,
      layout: {
        ...candidate.prepared.layout,
        edges: candidate.prepared.layout.edges.map((e) =>
          e === edge ? { ...e, sourcePortId: other.sourcePortId } : e,
        ),
      },
    },
  };
  expect(foldCandidateAllowed(fixture.ir, bad, candidate, packet.page)).toBe(
    false,
  );
});

it("rejects permuted phase ports even when conductor identities survive", () => {
  const ports = candidate.prepared.layout.ports;
  const a = required(
    ports.find((p) => p.id.includes("pole1") && p.id.endsWith('"in"]')),
  );
  const b = required(
    ports.find(
      (p) =>
        p.id.includes("pole2") &&
        p.nodeId !== a.nodeId &&
        p.id.endsWith('"in"]'),
    ),
  );
  const bad: RootedCandidate = {
    ...candidate,
    prepared: {
      ...candidate.prepared,
      layout: {
        ...candidate.prepared.layout,
        ports: ports.map((p) =>
          p === a ? { ...p, y: b.y } : p === b ? { ...p, y: a.y } : p,
        ),
      },
    },
  };
  expect(bad.prepared.graph.edges).toEqual(candidate.prepared.graph.edges);
  expect(foldCandidateAllowed(fixture.ir, bad, candidate, packet.page)).toBe(
    false,
  );
});

it("rejects a displaced pole that breaks its authored mechanical gang", () => {
  const pole = required(
    candidate.prepared.graph.nodes.find(
      (n) => n.kind === "symbol" && n.classification === "power-contact",
    ),
  );
  const bad: RootedCandidate = {
    ...candidate,
    prepared: {
      ...candidate.prepared,
      layout: {
        ...candidate.prepared.layout,
        nodes: candidate.prepared.layout.nodes.map((n) =>
          n.id === pole.id && n.primitiveOrigin
            ? {
                ...n,
                x: n.x + 20,
                primitiveOrigin: {
                  ...n.primitiveOrigin,
                  x: n.primitiveOrigin.x + 20,
                },
              }
            : n,
        ),
      },
    },
  };
  expect(
    rootedGangSegments(fixture.ir, bad.prepared.graph, bad.prepared.layout),
  ).toMatchObject({
    ok: false,
    error: { code: "R006", details: { reason: "mechanical-gang" } },
  });
  expect(foldCandidateAllowed(fixture.ir, bad, candidate, packet.page)).toBe(
    false,
  );
});
