import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import {
  compileProject,
  serializeIr,
} from "../../packages/compiler/dist/index.js";
import { buildDocumentation } from "../../packages/query/dist/index.js";
import { renderSchematicPacket } from "../../packages/render/dist/index.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { EVALS_VERSION } from "./version.mjs";
import { readReportSummary } from "./report-summary.mjs";
import { nativeRows } from "./m3-native.mjs";
import { sufficient } from "./document-dependencies.mjs";
import { expectedIdentifierCells } from "./identifier-policy.mjs";
import { m3Delivery } from "./m3-delivery.mjs";
import { buildSourceTables, scopeTables } from "./m3-documents.mjs";
import { documentObservations } from "./document-observations.mjs";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { hash } from "./support.mjs";
import {
  isExplicitEmptyState,
  matchesNativeEmptyState,
  nativeEmptyState,
} from "./native-empty-state.mjs";

const POLICY = { projection: "authored", relationIdentity: "authored" };

function makeObs(dq, findings, extra = {}) {
  return {
    id: `rl3/${dq}/sheet`,
    case: "rl3",
    dq,
    status: findings.length ? "fail" : "pass",
    evidence: { findingCount: findings.length, findings },
    ...extra,
  };
}

function mutateProtocolCell(svg, rowKey, replacement, preserveLines = []) {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const row = [...document.querySelectorAll("[data-report-row]")].find(
    (el) => el.getAttribute("data-report-row") === rowKey,
  );
  if (!row) throw Error(`Missing report row ${rowKey}`);
  const col = [...row.querySelectorAll("[data-report-column]")].find(
    (el) => el.getAttribute("data-report-column") === "2",
  );
  const texts = col ? [...col.querySelectorAll("text")] : [];
  if (!texts.length) throw Error(`Missing protocol text for ${rowKey}`);
  const keep = new Set(preserveLines);
  const protocolTexts = texts.filter((t) => !keep.has(t.textContent?.trim()));
  if (!protocolTexts.length)
    throw Error(`Missing replaceable protocol text for ${rowKey}`);
  protocolTexts[0].textContent = replacement;
  for (const extra of protocolTexts.slice(1)) extra.remove();
  return document.toString();
}

async function prepareRm3Packet(page, cable) {
  const compiled = await compileProject(
    "packages/core-library/test/fixtures/rm3",
  );
  if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
  const ir = structuredClone(compiled.ir);
  const link = ir.relations.find((r) => r.connection);
  if (cable) link.connection.cable = cable;
  const request = {
    format: "schematic-packet-request/0.1",
    views: [
      { format: "communication-view-request/0.1", medium: "ethernet" },
      { format: "documentation-view-request/0.1", kind: "network" },
    ],
  };
  const rendered = await renderSchematicPacket(
    ir,
    request,
    compiled.presentation,
  );
  if (!rendered.ok) throw Error(rendered.error.message);
  const packet = rendered.value;
  const svgs = packet.sheets.map((s) => embedPrintableFont(s.svg));
  const geometries = [];
  for (const svg of svgs) geometries.push(await openSheet(page, svg));
  const binding = {
    snapshotDigest: hash(JSON.stringify(serializeIr(ir))),
    presentationDigest: hash(JSON.stringify(compiled.presentation ?? null)),
    revision: compiled.presentation?.revision ?? "UNSPECIFIED",
  };
  const tables = scopeTables(
    packet,
    geometries,
    ir,
    buildSourceTables(ir, request, buildDocumentation),
    request,
  );
  Object.assign(tables, { binding, request });
  return { ir, request, packet, svgs, geometries, tables, binding, link };
}

function runChecks(env, geometries) {
  const reportSheet = env.packet.sheets[1];
  const obs = documentObservations({
    s: reportSheet,
    g: geometries[1],
    packet: env.packet,
    ir: env.ir,
    tables: env.tables,
    policy: POLICY,
    wireFindings: [],
    obs: makeObs,
    cohort: (f) => f,
  });
  const delivery = m3Delivery(
    env.packet.sheets[0],
    env.packet,
    geometries[0],
    geometries,
    env.ir,
    env.request,
    { binding: env.binding, tables: env.tables },
  );
  return { obs, delivery };
}

async function assertRm3ProtocolChecks(page, cable, preserveLines = []) {
  const env = await prepareRm3Packet(page, cable);
  const positive = runChecks(env, env.geometries);
  expect(positive.obs.every((r) => r.status === "pass")).toBe(true);
  expect(positive.delivery.findings).toEqual([]);
  expect(positive.delivery.targetFindings).toEqual([]);

  for (const token of ["unspecified", "Unspecified", "None", "null"]) {
    const mutatedSvg = mutateProtocolCell(
      env.svgs[1],
      env.link.uid,
      token,
      preserveLines,
    );
    expect(mutatedSvg).not.toBe(env.svgs[1]);
    const mutatedGeom = await openSheet(page, mutatedSvg);
    const painted = mutatedGeom.texts
      .filter((t) => t.row === env.link.uid && t.columnIndex === 1)
      .map((t) => t.text.trim());
    expect(painted).toEqual([token, ...preserveLines]);
    const checked = runChecks(env, [env.geometries[0], mutatedGeom]);
    expect(checked.obs[0].status).toBe("fail");
    expect(
      checked.obs[0].evidence.findings.some(
        (f) => f.kind === "report-null-placeholder",
      ),
    ).toBe(true);
    expect(
      checked.delivery.findings.some(
        (f) =>
          f.kind === "document-registry-row-mismatch" ||
          f.kind === "printed-document-target-insufficient",
      ),
    ).toBe(true);
  }
}

describe("checker protocol 5.51 — RL3 printed vocabulary parser alignment", () => {
  let browser, context, page;
  beforeAll(async () => {
    browser = await launch();
    context = await browser.newContext(drawingContextOptions);
    page = await context.newPage();
  });
  afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  it("keeps 5.49, 5.51, 5.53, 5.54, 5.55, 5.56, and 5.57 summaries readable under checker protocol 5.58", () => {
    expect(EVALS_VERSION).toBe("5.58");
    for (const evalsVersion of [
      "5.49",
      "5.51",
      "5.53",
      "5.54",
      "5.55",
      "5.56",
      "5.57",
    ]) {
      const sample = { evalsVersion, summary: { "DQ-19": { pass: 1 } } };
      expect(readReportSummary(sample)).toEqual(sample.summary);
    }
  });

  it("matches human connector-port endpoints in assemblies and io-ports while keeping physical terminals dotted", async () => {
    const cap = await compileProject("examples/cap-pagination");
    if (!cap.ok) throw Error(JSON.stringify(cap.diagnostics));
    const table = buildDocumentation(cap.ir, {
      format: "documentation-view-request/0.1",
      kind: "assemblies",
    });
    const catalog = nativeRows(cap.ir).filter((r) => r.kind === "assemblies");
    for (const row of table.rows) {
      const native = catalog.find((n) => n.key === row.key);
      expect(native).toBeDefined();
      const printed = {
        kind: "assemblies",
        key: row.key,
        cells: Object.fromEntries(row.cells.map((c, i) => [i, c])),
      };
      expect(sufficient(printed, native)).toBe(true);
      const dotted = {
        ...printed,
        cells: { ...printed.cells, 2: printed.cells[2].replace(": ", ".") },
      };
      expect(sufficient(dotted, native)).toBe(false);
    }

    const cells = expectedIdentifierCells(cap.ir, table);
    expect(cells.some((c) => c.identifiers.includes("R1: X01"))).toBe(true);
    expect(cells.some((c) => c.identifiers.includes("CAP1: P"))).toBe(true);

    const filtering = await compileProject("examples/report-filtering");
    if (!filtering.ok) throw Error(JSON.stringify(filtering.diagnostics));
    const terminals = buildDocumentation(filtering.ir, {
      format: "documentation-view-request/0.1",
      kind: "terminals",
    });
    const termCells = expectedIdentifierCells(filtering.ir, terminals);
    expect(termCells.some((c) => c.identifiers.includes("S1.P"))).toBe(true);
  });

  it("accepts explicit unspecified-protocol phrases and rejects bare null placeholders", () => {
    expect(isExplicitEmptyState("Protocol not specified in source")).toBe(true);
    expect(
      matchesNativeEmptyState(
        "Protocol not specified in source",
        nativeEmptyState("unspecified-protocol"),
      ),
    ).toBe(true);
    expect(
      matchesNativeEmptyState(
        "Protocol not specified in source\nCat6",
        nativeEmptyState("unspecified-protocol", "\nCat6"),
      ),
    ).toBe(true);
    for (const bad of ["unspecified", "Unspecified", "None", "null"]) {
      expect(
        matchesNativeEmptyState(bad, nativeEmptyState("unspecified-protocol")),
      ).toBe(false);
      expect(
        matchesNativeEmptyState(
          `${bad}\nCat6`,
          nativeEmptyState("unspecified-protocol", "\nCat6"),
        ),
      ).toBe(false);
    }
    expect(
      matchesNativeEmptyState(
        "EtherNet/IP",
        nativeEmptyState("unspecified-protocol"),
      ),
    ).toBe(false);
  });

  it("browser-measures RM3 network report: passes explicit protocol text and fails bare placeholder mutants with the same source table", async () => {
    await assertRm3ProtocolChecks(page);
    await assertRm3ProtocolChecks(
      page,
      { specification: "Cat6 shielded", lengthM: 12 },
      ["Cat6 shielded", "12 m"],
    );
    await assertRm3ProtocolChecks(
      page,
      { specification: "Not specified", lengthM: 12 },
      ["Not specified", "12 m"],
    );
  });
});
