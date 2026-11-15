import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { netLabelRepetition } from "./checks.mjs";
let browser, page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => {
  await browser?.close();
});
const hex = (s) =>
  Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const port = (uid) =>
  `port-${hex(JSON.stringify(["port", JSON.stringify(["function", uid, "feed"]), "in"]))}`;
const marker = (uid, x) =>
  `<g class="symbol function-symbol" data-symbol-id="test" data-device-uid="${uid}" data-function-key="feed"><circle class="terminal-marker" id="terminal-${[uid, "1", "in"].map(hex).join("--")}" data-terminal-key="1" cx="${x}" cy="20" r=".5" fill="white" stroke="black"/></g>`;
function drawing({ far = false, falseSource = false } = {}) {
  const clip = `clip-${hex(JSON.stringify(["label", "edge", '["wire","w"]', "net"]))}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100">${marker("a", 10)}${marker("b", 190)}<path data-wire-uid="w" data-source-device-uid="${falseSource ? "b" : "a"}" data-source-terminal-key="1" data-target-device-uid="${falseSource ? "a" : "b"}" data-target-terminal-key="1" data-route-source-port-key="${port(falseSource ? "b" : "a")}" data-route-target-port-key="${port(falseSource ? "a" : "b")}" data-edge-key="edge-${hex('["wire","w"]')}" d="M10 20 H190" stroke="black" fill="none"/><defs><clipPath id="${clip}"><rect width="200" height="100"/></clipPath></defs><text class="label-net" clip-path="url(#${clip})" x="${far ? 170 : 30}" y="18" font-size="2.7">N1</text></svg>`;
}
it("222.3 painted label at the target fails with coherent false source claims", async () => {
  expect(netLabelRepetition(await openSheet(page, drawing()))).toEqual([]);
  const g = await openSheet(page, drawing({ far: true, falseSource: true }));
  expect(netLabelRepetition(g).map((f) => f.kind)).toEqual([
    "net-label-source-geometry-mismatch",
    "net-label-not-at-route-source",
  ]);
});
