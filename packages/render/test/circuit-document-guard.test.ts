import { expect, it } from "vitest";
import type { RenderedPacket } from "../src/packet/types.js";
import { circuitPacketGuard } from "../src/layout/circuit-packet-guard.js";

function packet(): RenderedPacket {
  const fact = {
    kind: "port-link-status" as const,
    deviceUid: "device-n01",
    portKey: "B1",
  };
  const row = {
    id: "inventory/row/b1",
    nativeKey: "port/b1",
    displayName: "N01: B1",
    facts: [fact],
    columns: ["identity", "status"] as const,
    primitiveId: "sheet-3-row-b1",
    sheet: 3,
    zone: "A1",
    rectMm: { x: 10, y: 30, w: 80, h: 10 },
    anchorMm: { x: 50, y: 35 },
    anchorRule: "row-region-center/1" as const,
  };
  const identity = {
    snapshotDigest: "native-source",
    presentationDigest: "presentation",
    revision: "UNSPECIFIED",
  };
  const sheet = (number: number, svg: string) => ({
    number,
    view: {
      format: "documentation-view/0.1" as const,
      kind: "circuit" as const,
      title: "Circuit",
    },
    svg,
    references: [],
    continuations: [],
  });
  return {
    format: "schematic-packet/0.1",
    page: {
      size: "a3",
      orientation: "landscape",
      widthMm: 420,
      heightMm: 297,
      marginMm: 10,
    },
    sheets: [
      sheet(
        1,
        '<svg><g data-navigation-view="view"/><g id="caption-ink" data-document-dependency="dependency" data-document-note-id="note" data-document-caption-form="identities"><text x="11" y="103" font-size="2.5">Ports: network inventory 03.A1 (N01: B1).</text></g></svg>',
      ),
      sheet(2, '<svg><g data-navigation-view="view"/></svg>'),
      {
        ...sheet(
          3,
          '<svg><g data-document-id="inventory" data-document-origin="auto"><text x="10" y="20" font-size="2.5">network inventory</text><g id="sheet-3-row-b1" data-report-row="port/b1"><text x="10" y="35" font-size="2.5">N01: B1</text><text x="60" y="35" font-size="2.5">unconnected</text></g></g></svg>',
        ),
        view: {
          format: "documentation-view/0.1",
          kind: "network",
          title: "Network",
        },
      },
      sheet(4, '<svg><g data-navigation-view="view"/></svg>'),
    ],
    html: "",
    coverage: {} as RenderedPacket["coverage"],
    navigation: {
      format: "issued-navigation/0.1",
      snapshotDigest: "native-source",
      anchorRule: "function-terminal-centroid/2",
      quantumMm: 0.01,
      rounding: "decimal-half-up/1",
      seeds: [],
      measurementGaps: [],
      occurrences: [],
      canonicalGroups: [],
      pageRegions: [],
      reservations: [],
      annotations: [],
      documentFormat: "issued-documents/1",
      documents: [
        {
          ...identity,
          id: "inventory",
          kind: "network",
          label: "network inventory",
          autoOrigin: { dependencyIds: ["dependency"] },
          rows: [row],
        },
      ],
      dependencies: [
        {
          ...identity,
          id: "dependency",
          noteId: "note",
          need: "port-link-status",
          requiredFacts: [fact],
          requiredColumns: ["identity", "status"],
          subject: "Ports",
          owner: { viewKey: "view", noteId: "note", sheet: 1 },
          resolution: [{ documentId: "inventory", rows: [row.id] }],
          caption: {
            text: "Ports: network inventory 03.A1 (N01: B1).",
            primitiveId: "caption-ink",
            rectMm: { x: 10, y: 100, w: 100, h: 6 },
            form: "identities",
          },
        },
      ],
      autoDocuments: [
        {
          documentId: "inventory",
          dependencyIds: ["dependency"],
          sheets: [3],
        },
      ],
    },
  };
}

it("allows a legitimate circuit reduction with unchanged companion pages", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets.pop();
  expect(circuitPacketGuard(after, before)).toBe(true);
  expect(circuitPacketGuard(before, structuredClone(before))).toBe(true);
});

it.each([
  ["dependency", (p: RenderedPacket) => (p.navigation!.dependencies = [])],
  ["document", (p: RenderedPacket) => (p.navigation!.documents = [])],
  ["auto origin", (p: RenderedPacket) => (p.navigation!.autoDocuments = [])],
  [
    "resolution",
    (p: RenderedPacket) => (p.navigation!.dependencies![0]!.resolution = []),
  ],
  [
    "native row",
    (p: RenderedPacket) => (p.navigation!.documents![0]!.rows = []),
  ],
  [
    "caption metadata",
    (p: RenderedPacket) => delete p.navigation!.dependencies![0]!.caption,
  ],
  [
    "source fact",
    (p: RenderedPacket) => (p.navigation!.dependencies![0]!.requiredFacts = []),
  ],
] as const)("conserves %s metadata in both directions", (_, change) => {
  const before = packet(),
    after = structuredClone(before);
  change(after);
  expect(circuitPacketGuard(after, before)).toBe(false);
  expect(circuitPacketGuard(before, after)).toBe(false);
});

it.each([
  ["caption text", "(N01: B1)", "(N01: B2)"],
  ["caption primitive", 'id="caption-ink"', 'id="wrong-ink"'],
  [
    "caption owner",
    'data-document-note-id="note"',
    'data-document-note-id="other"',
  ],
  ["caption position", 'y="103"', 'y="203"'],
  [
    "caption visibility",
    '<g id="caption-ink"',
    '<g opacity="0" id="caption-ink"',
  ],
  [
    "caption transform",
    '<g id="caption-ink"',
    '<g transform="translate(0 10)" id="caption-ink"',
  ],
  ["caption size", 'font-size="2.5"', 'font-size="1.5"'],
] as const)("conserves painted %s independently of metadata", (_, from, to) => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[0]!.svg = after.sheets[0]!.svg.replace(from, to);
  expect(circuitPacketGuard(after, before)).toBe(false);
  expect(circuitPacketGuard(before, after)).toBe(false);
});

it("rejects changed companion ink and a removed page despite surviving metadata", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[2]!.svg = after.sheets[2]!.svg.replace(
    "unconnected",
    "connected",
  );
  expect(circuitPacketGuard(after, before)).toBe(false);
  const missing = structuredClone(before);
  missing.sheets.splice(2, 1);
  expect(circuitPacketGuard(missing, before)).toBe(false);
});

it("rejects disappearing caption ink and inherited styles that hide it", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[0]!.svg = '<svg><g data-navigation-view="view"/></svg>';
  expect(circuitPacketGuard(after, before)).toBe(false);
  const hidden = structuredClone(before);
  hidden.sheets[0]!.svg = hidden.sheets[0]!.svg.replace(
    "<svg>",
    '<svg visibility="hidden">',
  );
  expect(circuitPacketGuard(hidden, before)).toBe(false);
});

it("rejects a displaced caption even when its metadata follows the displacement", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[0]!.svg = after.sheets[0]!.svg.replace('y="103"', 'y="113"');
  after.navigation!.dependencies![0]!.caption!.rectMm.y += 10;
  expect(circuitPacketGuard(after, before)).toBe(false);
});

it("conserves owning-view placement independently of the caption rectangle", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[0]!.svg = after.sheets[0]!.svg.replace(
    'data-navigation-view="view"',
    'data-navigation-view="view" transform="translate(0 10)"',
  );
  expect(circuitPacketGuard(after, before)).toBe(false);
});

it("conserves reused authored row ink without requiring an automatic page", () => {
  const before = packet();
  delete before.navigation!.documents![0]!.autoOrigin;
  before.navigation!.autoDocuments = [];
  before.sheets[2]!.svg = before.sheets[2]!.svg.replace(
    'data-document-origin="auto"',
    'data-document-origin="authored"',
  );
  const after = structuredClone(before);
  after.sheets[2]!.svg = after.sheets[2]!.svg.replace(
    "unconnected",
    "connected",
  );
  expect(circuitPacketGuard(after, before)).toBe(false);
});

it("conserves the complete companion page, including its printed header", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[2]!.svg = after.sheets[2]!.svg.replace(
    ">network inventory<",
    ">wire inventory<",
  );
  expect(circuitPacketGuard(after, before)).toBe(false);
});

it("leaves unrelated requested reports to RT2a's existing pagination policy", () => {
  const before = packet();
  before.navigation!.dependencies = [];
  before.navigation!.autoDocuments = [];
  delete before.navigation!.documents![0]!.autoOrigin;
  before.sheets[0]!.svg = '<svg><g data-navigation-view="view"/></svg>';
  before.sheets[2]!.svg = before.sheets[2]!.svg.replace(
    'data-document-origin="auto"',
    'data-document-origin="authored"',
  );
  const after = structuredClone(before);
  after.navigation!.documents![0]!.rows[0]!.sheet = 4;
  expect(circuitPacketGuard(after, before)).toBe(true);
});

it("rejects unregistered companion paint replacing a circuit page", () => {
  const before = packet(),
    after = structuredClone(before);
  after.sheets[3]!.svg =
    '<svg><g data-document-origin="auto" data-document-id="unregistered"><text font-size="2.5" x="10" y="30">Extra inventory</text></g></svg>';
  expect(circuitPacketGuard(after, before)).toBe(false);
});

it("rejects added unregistered rows inside a reused authored inventory", () => {
  const before = packet();
  delete before.navigation!.documents![0]!.autoOrigin;
  before.navigation!.autoDocuments = [];
  before.sheets[2]!.svg = before.sheets[2]!.svg.replace(
    'data-document-origin="auto"',
    'data-document-origin="authored"',
  );
  const after = structuredClone(before);
  after.sheets[2]!.svg = after.sheets[2]!.svg.replace(
    "</g></svg>",
    '<g data-report-row="extra"><text font-size="2.5" x="10" y="50">N01: B2</text></g></g></svg>',
  );
  expect(circuitPacketGuard(after, before)).toBe(false);
});

it("conserves companion page ink outside the inventory wrapper", () => {
  const before = packet();
  before.sheets[2]!.svg = before.sheets[2]!.svg.replace(
    "</svg>",
    '<text font-size="2.5" x="10" y="260">Sheet 3</text></svg>',
  );
  const after = structuredClone(before);
  after.sheets[2]!.svg = after.sheets[2]!.svg.replace("Sheet 3", "Sheet 9");
  expect(circuitPacketGuard(after, before)).toBe(false);
});
