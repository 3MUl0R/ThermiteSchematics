vi.mock("./pdf-painted.mjs", () => ({
  paintedPdfItems: async (_page, items) => items,
}));
import { expect, it, vi } from "vitest";
import { identifierFindings } from "./identifier-checks.mjs";
import { expectedIdentifierCells } from "./identifier-policy.mjs";
import { pdfIdentifierRuns } from "./identifier-pdf.mjs";

const order = "6ES7212-1AE40-0XB0";
const ir = { devices: [], cables: [], relations: [], wires: [], jumpers: [] };
const table = {
  kind: "bom",
  columns: ["Qty", "Designations", "Location", "Mfr.", "Order number"],
  rows: [{ key: "row", cells: ["1", "", "", "", order], deviceUids: [] }],
};
function run(text, y = 20, x = 10) {
  return {
    text,
    anchor: { x, y },
    bbox: { x, y: y - 2, w: text.length, h: 2 },
  };
}
function geometry(runs = [run(order)]) {
  return {
    reportRows: ["row"],
    reportCells: [
      {
        row: "row",
        columnIndex: 4,
        element: "g-1",
        bbox: { x: 5, y: 5, w: 100, h: 40 },
      },
    ],
    texts: [
      {
        row: "row",
        columnIndex: 4,
        element: "text-1",
        painted: true,
        reportRuns: runs,
      },
    ],
  };
}
it.each(["svg", "html", "pdf"])(
  "detects a real internal-hyphen split independently in %s",
  (medium) => {
    const split = [run("6ES7212-1AE40-"), run("0XB0", 23.6)];
    const g = geometry(medium === "pdf" ? undefined : split);
    expect(identifierFindings(g, table, ir, medium, split)).toMatchObject([
      {
        kind: "identifier-line-break",
        medium,
        identifier: order,
        lineCount: 2,
        baselines: [20, 23.6],
      },
    ]);
  },
);
it("detects a punctuation-free split and positioned tspan runs in one parent text", () => {
  const changed = {
    ...table,
    rows: [{ ...table.rows[0], cells: ["1", "", "", "", "24280"] }], // authored Schneider example
  };
  expect(
    identifierFindings(geometry([run("24"), run("280", 23.6)]), changed, ir),
  ).toMatchObject([{ kind: "identifier-line-break" }]);
});
it("does not let matching SVG hide a PDF-only split or borrow PDF's clean result", () => {
  const g = geometry(),
    split = [run("6ES7212-1AE40-"), run("0XB0", 23.6)];
  expect(identifierFindings(g, table, ir)).toEqual([]);
  expect(identifierFindings(g, table, ir, "html")).toEqual([]);
  expect(identifierFindings(g, table, ir, "pdf", split)).toMatchObject([
    { kind: "identifier-line-break" },
  ]);
  expect(
    identifierFindings(geometry(split), table, ir, "pdf", [run(order)]),
  ).toEqual([]);
});
it("coalesces multiple same-line extraction runs and subpixel baseline noise", () => {
  const runs = [run("6ES7212-1AE40-"), run("0XB0", 20.05, 23)];
  expect(identifierFindings(geometry(runs), table, ir)).toEqual([]);
  expect(identifierFindings(geometry(), table, ir, "pdf", runs)).toEqual([]);
});
it("passes a source list whose complete identifiers occupy separate lines", () => {
  const source = {
    ...ir,
    devices: [
      { uid: "a", designation: "PUMP, EAST" },
      { uid: "b", designation: "PUMP-WEST" },
    ],
  };
  const t = {
    kind: "bom",
    columns: ["Qty", "Designations"],
    rows: [
      {
        key: "row",
        cells: ["2", "PUMP, EAST, PUMP-WEST"],
        deviceUids: ["a", "b"],
      },
    ],
  };
  const g = geometry([run("PUMP, EAST,"), run("PUMP-WEST", 23.6)]);
  g.reportCells[0].columnIndex = g.texts[0].columnIndex = 1;
  expect(identifierFindings(g, t, source)).toEqual([]);
});
it("preserves an identifier's internal spaces and Unicode normalization", () => {
  const t = {
    kind: "cables",
    columns: ["Cable"],
    rows: [{ key: "row", cells: ["Á / B-C"], deviceUids: [] }],
  };
  const cableGeometry = (runs) => {
    const g = geometry(runs);
    g.reportCells[0].columnIndex = g.texts[0].columnIndex = 0;
    return g;
  };
  expect(
    identifierFindings(cableGeometry([run("A\u0301 / B-C")]), t, ir),
  ).toEqual([]);
  expect(
    identifierFindings(cableGeometry([run("Á /"), run("B-C", 23.6)]), t, ir),
  ).toMatchObject([{ kind: "identifier-line-break" }]);
  expect(
    identifierFindings(cableGeometry([run("Á/B-C")]), t, ir),
  ).toMatchObject([{ kind: "identifier-text-mismatch" }]);
});
it.each(["6ES7212-1AE40-", "6ES7212-1AE40-…", order.toLowerCase(), ""])(
  "flags incomplete or changed rendered text %j",
  (value) => {
    expect(
      identifierFindings(geometry(value ? [run(value)] : []), table, ir),
    ).toMatchObject([{ kind: "identifier-text-mismatch", identifier: order }]);
  },
);
it("requires actual character baselines and measured cell rectangles", () => {
  expect(() =>
    identifierFindings({ ...geometry(), reportCells: undefined }, table, ir),
  ).toThrow(/cell rectangles missing/);
  expect(() =>
    identifierFindings({ ...geometry(), reportCells: [] }, table, ir),
  ).toThrow(/missing or ambiguous cell/);
  const g = geometry();
  delete g.texts[0].reportRuns;
  expect(() => identifierFindings(g, table, ir)).toThrow(/line boxes missing/);
  expect(() => identifierFindings(geometry(), table, ir, "pdf")).toThrow(
    /PDF runs missing/,
  );
});
it("ignores blank order numbers and prose, with no content-based column inference", () => {
  const t = {
    ...table,
    rows: [{ ...table.rows[0], cells: ["1", "", "", "", ""] }],
  };
  expect(identifierFindings(geometry([]), t, ir)).toEqual([]);
  expect(
    expectedIdentifierCells(ir, {
      ...table,
      columns: ["Qty", "Designations", "Location", "Mfr.", "Description"],
    }),
  ).toEqual([]);
  expect(() =>
    expectedIdentifierCells(ir, { ...table, kind: "new-kind" }),
  ).toThrow(/no column policy/);
});
it("extracts raw PDF whitespace and positions without an SVG-text match", async () => {
  const page = {
    getTextContent: async () => ({
      items: [
        { str: "A", transform: [1, 0, 0, 7, 10, 20], width: 3 },
        { str: " ", transform: [1, 0, 0, 7, 13, 20], width: 2 },
        { str: "B", transform: [1, 0, 0, 7, 15, 10], width: 3 },
      ],
    }),
    getViewport: () => ({ convertToViewportPoint: (x, y) => [x, 100 - y] }),
  };
  const runs = await pdfIdentifierRuns(page);
  expect(runs.map((r) => r.text)).toEqual(["A", " ", "B"]);
  expect(runs.map((r) => r.anchor.y)).toEqual([80, 80, 90]);
});

function terminalConnectionCase(column, runs) {
  const key = JSON.stringify(["owner", "1"]);
  const source = {
    devices: [
      { uid: "owner", designation: "XT1", location: "Panel A" },
      {
        uid: "a",
        designation: "X1",
        location: column === 4 ? "Panel A" : "Panel B",
      },
      {
        uid: "b",
        designation: "PS1",
        location: column === 4 ? "Panel A" : "Panel B",
      },
    ],
    wires: [
      {
        uid: "w1",
        endpoints: [
          { terminal: { deviceUid: "owner", terminalKey: "1" } },
          { terminal: { deviceUid: "a", terminalKey: "13" } },
        ],
      },
      {
        uid: "w2",
        endpoints: [
          { terminal: { deviceUid: "b", terminalKey: "+" } },
          { terminal: { deviceUid: "owner", terminalKey: "1" } },
        ],
      },
    ],
    jumpers: [],
    cables: [],
  };
  const cells = Array(7).fill("");
  cells[column] = "W1 -> X1.13; W2 -> PS1.+";
  const table = {
    kind: "terminals",
    columns: [
      "Device",
      "Location",
      "Terminal",
      "Description",
      "Same location connections",
      "Other / unspecified location connections",
      "State",
    ],
    rows: [{ key, cells, deviceUids: ["owner", "a", "b"] }],
  };
  const g = geometry(runs);
  g.reportRows = [key];
  g.reportCells[0].row = g.texts[0].row = key;
  g.reportCells[0].columnIndex = g.texts[0].columnIndex = column;
  return { g, table, source };
}
const completeEndpoints = () => [run("W1 -> X1.13;"), run("W2 -> PS1.+", 23.6)];
const brokenEndpoints = () => [
  run("W1 -> X1."),
  run("13; W2 -> PS1.", 23.6),
  run("+", 27.2),
];
it.each([4, 5])(
  "detects split terminal connection endpoint units in column %i independently in all media",
  (column) => {
    for (const medium of ["svg", "html", "pdf"]) {
      const { g, table, source } = terminalConnectionCase(
        column,
        medium === "pdf" ? completeEndpoints() : brokenEndpoints(),
      );
      expect(
        identifierFindings(g, table, source, medium, brokenEndpoints()),
      ).toMatchObject([
        {
          kind: "identifier-line-break",
          identifier: "X1.13",
          columnIndex: column,
          lineCount: 2,
        },
        {
          kind: "identifier-line-break",
          identifier: "PS1.+",
          columnIndex: column,
          lineCount: 2,
        },
      ]);
    }
  },
);
it.each([4, 5])(
  "allows terminal connection lists to wrap between complete endpoint units in column %i",
  (column) => {
    const { g, table, source } = terminalConnectionCase(
      column,
      completeEndpoints(),
    );
    for (const medium of ["svg", "html", "pdf"])
      expect(
        identifierFindings(g, table, source, medium, completeEndpoints()),
      ).toEqual([]);
  },
);
it("selects legacy identifiers from engine policy, never from a changed Channel cell", () => {
  const source = {
    devices: [
      {
        uid: "d",
        designation: "AI1",
        io: { channels: { hidden: { address: "I0.0" } } },
      },
    ],
    functions: [
      {
        id: { deviceUid: "d", functionKey: "hidden" },
        terminals: [{ deviceUid: "d", terminalKey: "3" }],
      },
    ],
  };
  const table = {
    kind: "io",
    columns: ["Device", "Channel"],
    rows: [
      {
        key: JSON.stringify(["d", "hidden"]),
        cells: ["AI1", "hidden"],
        deviceUids: ["d"],
      },
    ],
  };
  expect(
    expectedIdentifierCells(source, table).find((c) => c.column === 1)
      .identifiers,
  ).toEqual(["I0.0"]);
  table.rows[0].cells[1] = "I0.0";
  expect(
    expectedIdentifierCells(source, table, { projection: "legacy" }).find(
      (c) => c.column === 1,
    ).identifiers,
  ).toEqual(["hidden"]);
});
it("derives complete network endpoint identities independently of query-cell punctuation", () => {
  const source = {
    devices: [{ uid: "d", designation: "PLC1" }],
    relations: [
      {
        uid: "link",
        fromDeviceUid: "d",
        toDeviceUid: "d",
        connection: { fromPort: "P1", toPort: "P2" },
      },
    ],
  };
  const table = {
    kind: "network",
    columns: [
      "Link",
      "Protocol / medium",
      "End A / location",
      "End B / location",
    ],
    rows: [
      {
        key: "link",
        cells: ["link", "", "PLC1.P1", "PLC1: wrong"],
        deviceUids: ["d"],
      },
    ],
  };
  expect(
    expectedIdentifierCells(source, table)
      .filter((c) => c.column >= 2)
      .map((c) => c.identifiers),
  ).toEqual([["PLC1: P1"], ["PLC1: P2"]]);
  expect(
    expectedIdentifierCells(source, table, { projection: "legacy" })
      .filter((c) => c.column >= 2)
      .map((c) => c.identifiers),
  ).toEqual([["PLC1.P1"], ["PLC1.P2"]]);
});
