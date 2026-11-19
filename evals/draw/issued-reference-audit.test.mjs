import { expect, it } from "vitest";
import {
  footerReferenceFindings,
  peerReferenceFindings,
  stripInventoryFindings,
} from "./issued-reference-audit.mjs";

const reference = {
  peerReference: "attachment",
  peerSource: JSON.stringify(["R1", "X2", "CAP"]),
  text: "R1.X2 · CAP-X2 → 02.B4",
  painted: true,
};

it.each([
  ["wrong port", { ...reference, text: "R1.X4 · CAP-X2 → 02.B4" }],
  ["wrong zone", { ...reference, text: "R1.X2 · CAP-X2 → 02.B5" }],
  ["generic inventory", { ...reference, text: "See assembly schedule 02.B4" }],
  ["hidden pointer", { ...reference, painted: false }],
  ["erased reverse pointer", undefined],
])("rejects %s for a source-bound attachment", (_, mutation) => {
  const expected = [
    {
      kind: "attachment",
      source: ["R1", "X2", "CAP"],
      values: [reference.text],
    },
  ];
  expect(peerReferenceFindings(1, { texts: [reference] }, expected)).toEqual(
    [],
  );
  expect(
    peerReferenceFindings(1, { texts: mutation ? [mutation] : [] }, expected),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "issued-peer-reference-missing" }),
    ]),
  );
});

it("distinguishes the exact assembly inventory row from a drawn attachment", () => {
  const row = {
    ...reference,
    peerReference: "assembly-inventory",
    text: "R1.X09 · CBL1 inventory → 04.B3",
    peerSource: JSON.stringify(["R1", "X09", "CBL1"]),
  };
  const expected = [
    {
      kind: row.peerReference,
      source: ["R1", "X09", "CBL1"],
      values: [row.text],
    },
  ];
  expect(peerReferenceFindings(2, { texts: [row] }, expected)).toEqual([]);
  for (const changed of [
    { ...row, peerSource: JSON.stringify(["R1", "X09", "CBL2"]) },
    { ...row, text: row.text.replace("inventory ", "") },
    { ...row, text: row.text.replace("04.B3", "05.B3") },
  ])
    expect(
      peerReferenceFindings(2, { texts: [changed] }, expected),
    ).not.toEqual([]);
  // If the issued native row is hidden or omitted, a stale pointer is invalid.
  expect(peerReferenceFindings(2, { texts: [row] }, [])[0].kind).toBe(
    "issued-peer-reference-unbound",
  );
});

it("rejects missing, duplicate, hidden and wrong inventory targets", () => {
  const packet = {
    sheets: [
      { number: 2, view: { kind: "terminals" } },
      { number: 3, view: { kind: "terminal-strip" } },
    ],
  };
  const target = { key: '["T","17"]', ref: "T1/R17" };
  const inventory = {
    terminalStripInk: {
      viewKeys: ["view"],
      references: [{ key: target.key, text: target.ref }],
    },
  };
  const strip = {
    terminalStripInk: {
      viewKeys: ["view"],
      terminals: [
        {
          ...target,
          rect: { x: 100, y: 50, w: 16, h: 8 },
          texts: [{ text: "S02", painted: true }],
        },
      ],
    },
  };
  const row = { key: target.key, kind: "terminals", visible: true, sheet: 2 };
  expect(stripInventoryFindings(packet, [inventory, strip], [row], 1)).toEqual(
    [],
  );
  for (const mutated of [
    [],
    [{ ...row, visible: false }],
    [row, row],
    [{ ...row, key: "wrong" }],
  ])
    expect(
      stripInventoryFindings(packet, [inventory, strip], mutated, 1)[0].kind,
    ).toBe("strip-inventory-sheet-disagrees");
  strip.terminalStripInk.terminals[0].texts[0].text = "S01";
  expect(
    stripInventoryFindings(packet, [inventory, strip], [row], 1)[0].kind,
  ).toBe("strip-inventory-sheet-disagrees");
});

it("rejects a dangling, stale or erased circuit footer", () => {
  const sheet = { number: 1, view: { kind: "circuit" } };
  const foot = (text) => ({
    height: 200,
    texts: text
      ? [
          {
            text,
            painted: true,
            sheetText: true,
            bbox: { x: 20, y: 186, w: 90, h: 3 },
          },
        ]
      : [],
  });
  expect(footerReferenceFindings(sheet, foot(""), undefined)).toEqual([]);
  expect(
    footerReferenceFindings(
      sheet,
      foot("Device and function references S05"),
      5,
    ),
  ).toEqual([]);
  for (const [printed, target] of [
    ["device/function references in index", undefined],
    ["Device and function references S05", undefined],
    ["Device and function references S04", 5],
    ["", 5],
  ])
    expect(footerReferenceFindings(sheet, foot(printed), target)[0].kind).toBe(
      "circuit-footer-reference-disagrees",
    );
});

const shortReference = {
  kind: reference.peerReference,
  source: ["R1", "X2", "CAP"],
  values: [reference.text],
  compactValues: ["→ CAP-X2 02.B4"],
};
const marker = (text) => ({ ...reference, text, fontSize: 2.5 });

it("accepts a named compact peer and an unambiguous locator", () => {
  for (const text of ["→ CAP-X2 02.B4", "→ 02.B4"]) {
    expect(
      peerReferenceFindings(1, { texts: [marker(text)] }, [shortReference]),
    ).toEqual([]);
  }
});

it.each([
  ["wrong peer", marker("→ CAP-X4 02.B4"), [shortReference]],
  ["wrong zone", marker("→ 02.B5"), [shortReference]],
  [
    "undersized locator",
    { ...marker("→ 02.B4"), fontSize: 2.49 },
    [shortReference],
  ],
  [
    "ambiguous locator",
    marker("→ 02.B4"),
    [
      shortReference,
      {
        ...shortReference,
        source: ["R1", "X4", "DIFFERENT"],
      },
    ],
  ],
])("rejects a %s from measured short ink", (_, text, expected) => {
  expect(peerReferenceFindings(1, { texts: [text] }, expected)[0].kind).toBe(
    "issued-peer-reference-unbound",
  );
});

it("requires the visible, aligned, complete two-line form", () => {
  const lines = [
    {
      ...marker("R1.X2 · CAP-X2"),
      peerGroup: "g1",
      anchor: { x: 12, y: 15 },
      bbox: { x: 12, y: 13, w: 22, h: 2 },
    },
    {
      ...marker("→ 02.B4"),
      peerGroup: "g1",
      anchor: { x: 12, y: 18.5 },
      bbox: { x: 12, y: 16.5, w: 12, h: 2 },
    },
  ];
  const audit = (texts) =>
    peerReferenceFindings(1, { texts }, [shortReference]);
  expect(audit(lines)).toEqual([]);
  for (const mutation of [
    [lines[1]],
    [lines[0], { ...lines[1], painted: false }],
    [lines[0], { ...lines[1], text: "→ 02.B5" }],
    [lines[0], { ...lines[1], anchor: { x: 13, y: 18.5 } }],
    [lines[0], { ...lines[1], anchor: { x: 12, y: 15.3 } }],
  ])
    expect(audit(mutation)[0].kind).toBe("issued-peer-reference-unbound");
});
