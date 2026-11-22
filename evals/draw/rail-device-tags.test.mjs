import { afterAll, beforeAll, expect, it } from "vitest";
import { drawingContextOptions, launch, openSheet } from "./browser.mjs";
import { deviceTags } from "./checks.mjs";
import { locationFragmentCaptionFindings } from "./headings-and-locations.mjs";
import { compileProject } from "../../packages/compiler/dist/index.js";
import { renderSchematic } from "../../packages/render/dist/index.js";
import { resolve } from "node:path";

let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await browser.newPage(drawingContextOptions);
  await page.emulateMedia({ media: "print" });
});
afterAll(async () => {
  await browser?.close();
});

const svgDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="150mm" height="100mm" viewBox="0 0 150 100">${body}</svg>`;

const railTagFixture = {
  ir: {
    devices: [
      {
        uid: "ps1",
        designation: "PS1",
        typeId: "t",
        description: "24 VDC supply",
      },
      {
        uid: "src1",
        designation: "SRC1",
        typeId: "t",
        description: "Main source",
      },
    ],
    deviceTypes: [{ id: "t", terminals: [{ key: "+" }] }],
    potentials: [
      {
        uid: "pot-24v",
        name: "+24VDC",
        netId: "net-24v",
        terminal: { deviceUid: "ps1", terminalKey: "+" },
      },
    ],
  },
  railWithoutTag:
    '<g class="symbol rail-symbol" transform="translate(80 40)" data-symbol-id="ais:rail-source" data-boundary-kind="potential" data-device-uid="ps1" data-designation="PS1" data-potential-uid="pot-24v" data-net-id="net-24v" data-potential-name="+24VDC">' +
    '<rect x="1" y="1" width="1" height="6" fill="none" stroke="#101828" stroke-width="0.3"/>' +
    '<line x1="2" y1="4" x2="4" y2="4" stroke="#101828" stroke-width="0.3"/>' +
    "</g>",
  sheetLegendOnly:
    '<g data-device-legend="true">' +
    '<rect class="device-legend-frame" x="10" y="10" width="40" height="20" fill="white" stroke="#667085" stroke-width="0.25"/>' +
    '<g data-device-legend-entry="true" data-device-reference-entry="true" data-tag-owner-uid="ps1" data-tag-kind="reference" data-tag-block="ps1" data-tag-key="PS1.+">' +
    '<text x="12" y="16" font-size="2.7" data-tag-owner-uid="ps1" data-tag-kind="reference" data-tag-block="ps1" data-tag-field="designation" data-tag-key="PS1.+">PS1</text>' +
    '<text x="12" y="20" font-size="2.5" data-tag-owner-uid="ps1" data-tag-kind="reference" data-tag-block="ps1" data-tag-field="description" data-tag-key="PS1.+">24 VDC supply</text>' +
    "</g></g>",
  offViewCard:
    '<g class="off-view-annotation">' +
    '<rect class="off-view-card" x="45" y="41" width="32" height="10" fill="none" stroke="#616b78" stroke-width="0.25"/>' +
    '<text x="47" y="45" font-size="2.7" data-tag-owner-uid="ps1" data-tag-kind="reference" data-tag-block="card" data-tag-field="designation" data-tag-terminal-id=\'{"deviceUid":"ps1","terminalKey":"+"}\'>Off-view at PS1.+</text>' +
    "</g>",
};

it("DQ-06 rejects an old-engine potential rail with legend/card only and accepts a local device tag (#432)", async () => {
  const { ir, railWithoutTag, sheetLegendOnly, offViewCard } = railTagFixture;
  const oldG = await openSheet(
    page,
    svgDoc(railWithoutTag + sheetLegendOnly + offViewCard),
  );
  expect(deviceTags(oldG, ir, [], true)).toContainEqual(
    expect.objectContaining({
      kind: "missing-rail-device-tag",
      deviceUid: "ps1",
      expectedDesignation: "PS1",
    }),
  );
  const railWithTag = railWithoutTag.replace(
    "</g>",
    '<text class="rail-device-tag" data-rail-device-tag="true" data-rail-device-uid="ps1" x="1" y="10.5" font-size="2.5" font-weight="700" fill="#344054">PS1</text></g>',
  );
  const newG = await openSheet(
    page,
    svgDoc(railWithTag + sheetLegendOnly + offViewCard),
  );
  expect(deviceTags(newG, ir, [], true)).toEqual([]);
});

it("DQ-06 validates rail owners against the authored IR potential, rejecting wrong or erased owner UIDs", async () => {
  const { ir, railWithoutTag, sheetLegendOnly, offViewCard } = railTagFixture;
  const railWithTag = railWithoutTag.replace(
    "</g>",
    '<text class="rail-device-tag" data-rail-device-tag="true" data-rail-device-uid="ps1" x="1" y="10.5" font-size="2.5" font-weight="700" fill="#344054">PS1</text></g>',
  );
  const wrongOwnerAndTag = railWithTag
    .replaceAll('data-device-uid="ps1"', 'data-device-uid="src1"')
    .replaceAll('data-rail-device-uid="ps1"', 'data-rail-device-uid="src1"')
    .replace(">PS1</text>", ">SRC1</text>");
  const wrongOwnerFindings = deviceTags(
    await openSheet(
      page,
      svgDoc(wrongOwnerAndTag + sheetLegendOnly + offViewCard),
    ),
    ir,
    [],
    true,
  );
  expect(wrongOwnerFindings).toContainEqual(
    expect.objectContaining({
      kind: "invalid-device-tag-owner",
      reason: "rail-owner-mismatch",
      expectedDeviceUid: "ps1",
    }),
  );
  expect(wrongOwnerFindings).toContainEqual(
    expect.objectContaining({
      kind: "missing-rail-device-tag",
      expectedDesignation: "PS1",
    }),
  );
  const erasedOwner = railWithTag.replace(' data-device-uid="ps1"', "");
  expect(
    deviceTags(
      await openSheet(
        page,
        svgDoc(erasedOwner + sheetLegendOnly + offViewCard),
      ),
      ir,
      [],
      true,
    ),
  ).toContainEqual(
    expect.objectContaining({
      kind: "invalid-device-tag-owner",
      reason: "rail-owner-missing",
      expectedDeviceUid: "ps1",
    }),
  );
});

it("motor-starter and machine-demo potential rails emit legible local PS1 tags in LTR and TTB", async () => {
  for (const [example, root] of [
    ["examples/motor-starter", "K1"],
    ["examples/machine-demo", "K1"],
  ]) {
    const compiled = await compileProject(resolve(example));
    expect(compiled.ok).toBe(true);
    for (const flow of ["left-to-right", "top-to-bottom"]) {
      const view = {
        format: "schematic-view-request/0.1",
        family: "control",
        root: { by: "designation", value: root },
        flow,
      };
      const rendered = await renderSchematic(compiled.ir, view);
      expect(rendered.ok).toBe(true);
      const g = await openSheet(page, rendered.value.svg);
      expect(g.potentialRails.length).toBeGreaterThan(0);
      const railFindings = deviceTags(
        g,
        compiled.ir,
        [],
        true,
        rendered.value.view,
      ).filter((f) => f.kind === "missing-rail-device-tag");
      expect(railFindings).toEqual([]);
    }
  }
});

it("DQ-02 location fragment caption check validates location identity, not position alone", async () => {
  const frameWithCaption = (captionText) =>
    svgDoc(
      '<g class="location-group" data-location="FIELD">' +
        '<rect class="location-frame" x="20" y="20" width="60" height="40" fill="#f7f8fa" stroke="#667085" stroke-width="0.35"/>' +
        "</g>" +
        '<g class="symbol" data-device-uid="d1" data-designation="M1">' +
        '<rect x="35" y="32" width="12" height="12" fill="white" stroke="#101828" stroke-width="0.3"/>' +
        "</g>" +
        (captionText
          ? `<text class="location-fragment-caption" data-location-fragment-caption="loc-field" data-location-name="FIELD" x="22" y="25" font-size="2.5" font-weight="700" fill="#475569">${captionText}</text>`
          : ""),
    );
  const passing = await openSheet(page, frameWithCaption("FIELD (CONT.)"));
  expect(locationFragmentCaptionFindings(passing)).toEqual([]);
  const plainPassing = await openSheet(page, frameWithCaption("FIELD"));
  expect(locationFragmentCaptionFindings(plainPassing)).toEqual([]);
  const wrongName = await openSheet(page, frameWithCaption("WRONG-LOCATION"));
  expect(locationFragmentCaptionFindings(wrongName)).toContainEqual(
    expect.objectContaining({
      kind: "unlabeled-location-fragment",
      locationName: "FIELD",
      foundCaptions: ["WRONG-LOCATION"],
    }),
  );
  const missing = await openSheet(page, frameWithCaption(""));
  expect(locationFragmentCaptionFindings(missing)).toContainEqual(
    expect.objectContaining({
      kind: "unlabeled-location-fragment",
      locationName: "FIELD",
      foundCaptions: [],
    }),
  );
});
