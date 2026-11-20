import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import {
  drawingContextOptions,
  launch,
  openSheet,
} from "../../../evals/draw/browser.mjs";
import { terminalLabelFindings } from "../../../evals/draw/caption-mark-clearance.mjs";

let browser: Browser, page: Page;
beforeAll(async () => {
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
});
afterAll(async () => browser?.close());

function drawing(x: number, sameOwner: boolean) {
  const winding = `<g data-circuit-mark="winding" stroke="black" stroke-width=".65" fill="none">
    <polyline points="10,12 ${x},15 10,18"/>
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="30mm" viewBox="0 0 80 30">
    <g data-device-uid="device" data-circuit-functions="[]">
      ${sameOwner ? winding : ""}
      <g data-terminal-key="X2"><text x="21" y="16" font-family="sans-serif" font-size="2.5">X2 [+1]</text></g>
    </g>
    ${sameOwner ? "" : `<g data-device-uid="other">${winding}</g>`}
  </svg>`;
}

it.each([
  { x: 20, sameOwner: true, fails: true },
  { x: 18, sameOwner: true, fails: false },
  { x: 20, sameOwner: false, fails: false },
])(
  "measures the painted winding join beside a suffixed terminal ($x, $sameOwner)",
  async ({ x, sameOwner, fails }) => {
    const findings = terminalLabelFindings(
      await openSheet(page, drawing(x, sameOwner)),
    );
    expect(findings).toEqual(
      fails
        ? [
            expect.objectContaining({
              kind: "terminal-label-body-clearance",
              terminalKey: "X2",
              text: "X2 [+1]",
              minimumMm: 0.5,
            }),
          ]
        : [],
    );
  },
);
