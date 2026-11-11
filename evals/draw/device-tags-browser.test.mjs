import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { deviceTags } from "./checks.mjs";
import { evaluateSheet } from "./evaluate.mjs";
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
const ir = {
  devices: [
    {
      uid: "a",
      designation: "TB 1",
      typeId: "t",
      description: "Field terminals",
    },
  ],
  deviceTypes: [
    {
      id: "t",
      catalog: { orderNumber: "P/1-A" },
      terminals: [{ key: "X1.1" }],
    },
  ],
  functions: [],
  nets: [],
};
const refs = [{ deviceUid: "a" }];
const svg = (s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="120mm" viewBox="0 0 200 120">${s}</svg>`;
const text = (field, s, y, attrs = "") =>
  `<text x="15" y="${y}" font-size="2.7" data-tag-owner-uid="a" data-tag-kind="body" data-tag-block="a" data-tag-field="${field}" ${attrs}>${s}</text>`;
const full = () =>
  text("designation", "TB 1", 20) +
  text("description", "Field terminals", 25) +
  text("part", "P/1-A", 30);
const body = (content) =>
  `<g data-device-uid="a"><rect x="10" y="10" width="80" height="40" fill="none" stroke="black"/>${content}</g>`;

it("measures owned fields without introducing appearances, joins or terminals", async () => {
  const g = await openSheet(page, svg(body(full())));
  expect(deviceTags(g, ir, refs, true)).toEqual([]);
  expect(g.devices).toHaveLength(1);
  expect(g.terminals).toHaveLength(0);
  const bare = await openSheet(
    page,
    svg(body(full().replaceAll(/ data-tag-[a-z-]+="[^"]*"/g, ""))),
  );
  expect(g.shapes.map((s) => [s.points, s.bbox, s.conductor])).toEqual(
    bare.shapes.map((s) => [s.points, s.bbox, s.conductor]),
  );
  expect(deviceTags(bare, ir, refs, true)[0].missing).toHaveLength(3);
});
it.each([
  ['style="display:none"', ""],
  ['style="visibility:hidden"', ""],
  ['style="opacity:0"', ""],
  ['fill="none"', ""],
  [
    'clip-path="url(#cut)"',
    '<defs><clipPath id="cut"><rect x="15" y="23" width="1" height="4"/></clipPath></defs>',
  ],
])(
  "rejects invisible or partially clipped authored text: %s",
  async (attrs, defs) => {
    const content =
      text("designation", "TB 1", 20) +
      text("description", "Field terminals", 25, attrs) +
      text("part", "P/1-A", 30);
    const g = await openSheet(page, svg(defs + body(content)));
    expect(deviceTags(g, ir, refs, true)[0].missing).toContain(
      "authored description",
    );
  },
);
it("rejects ancestor clipping and a foreign declared owner, even with shared text", async () => {
  const clipped = `<defs><clipPath id="cut"><rect width="1" height="1"/></clipPath></defs><g clip-path="url(#cut)">${body(full())}</g>`;
  expect(
    deviceTags(await openSheet(page, svg(clipped)), ir, refs, true)[0].missing,
  ).toHaveLength(3);
  const foreign = body(full()).replace(
    'data-device-uid="a"',
    'data-device-uid="b"',
  );
  expect(
    deviceTags(
      await openSheet(page, svg(foreign)),
      {
        ...ir,
        devices: [
          ...ir.devices,
          { ...ir.devices[0], uid: "b", designation: "TB 2" },
        ],
      },
      refs,
      true,
    ).find((f) => f.designation === "TB 1").missing,
  ).toHaveLength(3);
});
it("does not accept a title or another sheet's tag", async () => {
  await openSheet(page, svg(body(full())));
  const other = await openSheet(
    page,
    svg(body("<title>TB 1 Field terminals P/1-A</title>")),
  );
  expect(deviceTags(other, ir, refs, true)[0].missing).toHaveLength(3);
});
it("resolves fixed qualified references and local keys, retaining reference-only semantics", async () => {
  const terminal =
    "{&quot;deviceUid&quot;:&quot;a&quot;,&quot;terminalKey&quot;:&quot;X1.1&quot;}";
  const ref = `<g data-tag-owner-uid="a" data-tag-kind="reference" data-tag-block="end" data-tag-field="designation" data-tag-terminal-id="${terminal}" data-tag-ref="a"><text x="100" y="20" font-size="2.7">Off-view at TB 1.X1.1</text></g>`;
  const tag = `<g data-device-uid="a" data-tag-kind="reference">${full().replaceAll('data-tag-kind="body"', 'data-tag-kind="reference"')}</g>`;
  const g = await openSheet(page, svg(tag + ref));
  expect(g.devices).toHaveLength(0);
  expect(g.terminals).toHaveLength(0);
  expect(deviceTags(g, ir, [], true)).toEqual([]);
  const bad = await openSheet(
    page,
    svg(tag + ref.replace('data-tag-ref="a"', 'data-tag-ref="broken"')),
  );
  expect(
    deviceTags(bad, ir, [], true).some(
      (f) => f.kind === "invalid-device-tag-reference",
    ),
  ).toBe(true);
  const masquerade = await openSheet(
    page,
    svg(
      tag.replace(
        "</g>",
        '<rect x="10" y="10" width="10" height="10"/><circle data-terminal-key="X1.1" cx="10" cy="10" r="1"/></g>',
      ),
    ),
  );
  expect(deviceTags(masquerade, ir, [], true)).toEqual([]);
  expect(masquerade.devices).toHaveLength(0);
  expect(masquerade.terminals).toHaveLength(0);
});
it.each(["communication", "connector-assembly"])(
  "assesses %s drawings instead of returning an empty tag check",
  async (kind) => {
    const g = await openSheet(page, svg(body(text("designation", "TB 1", 20))));
    const sheet = {
      number: 1,
      view: { format: "documentation-view/0.1", kind },
      references: refs,
      continuations: [],
    };
    const results = evaluateSheet(
      { id: "tags" },
      sheet,
      { sheets: [sheet] },
      g,
      ir,
      [],
      [],
      [],
    );
    expect(
      results.find((r) => r.dq === "DQ-06").evidence.findings[0].missing,
    ).toContain("authored description");
  },
);

it("excludes reference copies outside the current sheet viewport", async () => {
  const terminal =
    "{&quot;deviceUid&quot;:&quot;b&quot;,&quot;terminalKey&quot;:&quot;X1.1&quot;}";
  const outside = `<g transform="translate(300 0)" data-tag-owner-uid="b" data-tag-kind="reference" data-tag-field="designation" data-tag-block="outside" data-tag-terminal-id="${terminal}"><text x="10" y="20">TB 2.X1.1</text></g>`;
  const g = await openSheet(page, svg(body(full()) + outside));
  expect(g.deviceReferences).toHaveLength(0);
  const data = {
    ...ir,
    devices: [
      ...ir.devices,
      { ...ir.devices[0], uid: "b", designation: "TB 2" },
    ],
  };
  expect(deviceTags(g, data, [], true)).toEqual([]);
});

it("refuses forged body rows inside a reference annotation and malformed terminal IDs", async () => {
  const forged = `<g data-device-uid="a" data-tag-kind="reference">${full()}</g>`;
  const g = await openSheet(
    page,
    svg(body(text("designation", "TB 1", 20)) + forged),
  );
  expect(deviceTags(g, ir, refs, true)[0].missing).toContain(
    "authored description",
  );
  const malformed = `<g data-tag-owner-uid="a" data-tag-kind="reference" data-tag-block="bad" data-tag-field="designation" data-tag-terminal-id="bad-json"><text x="100" y="20">TB 1.X1.1</text></g>`;
  const invalid = await openSheet(page, svg(body(full()) + malformed));
  expect(
    deviceTags(invalid, ir, refs, true).some(
      (f) => f.kind === "invalid-device-tag-reference",
    ),
  ).toBe(true);
});

it("keeps repeated device appearances as separate physical blocks", async () => {
  const repeated = await openSheet(
    page,
    svg(body(full()) + `<g transform="translate(90 0)">${body(full())}</g>`),
  );
  expect(deviceTags(repeated, ir, refs, true)).toEqual([]);
  const split = await openSheet(
    page,
    svg(
      body(
        text("designation", "TB 1", 20) +
          text("description", "Field terminals", 25),
      ) +
        `<g transform="translate(90 0)">${body(text("part", "P/1-A", 30))}</g>`,
    ),
  );
  expect(deviceTags(split, ir, refs, true)[0].missing).toContain(
    "authored part P/1-A",
  );
});
