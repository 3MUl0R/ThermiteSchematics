import { afterAll, beforeAll, expect, it } from "vitest";
import { launch, drawingContextOptions, openSheet } from "./browser.mjs";
import { terminalText, textBounds } from "./checks.mjs";

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
const encode = (s) =>
  Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100">${body}</svg>`;
const marker = (uid, fn, terminal, x) =>
  `<g class="symbol function-symbol" data-symbol-id="test" data-device-uid="${uid}" data-function-key="${fn}"><circle class="terminal-marker" id="terminal-${[uid, terminal, "in"].map(encode).join("--")}" data-terminal-key="${terminal}" cx="${x}" cy="20" r=".5" fill="white" stroke="black"/></g>`;
const label = (uid, fn, x, value = "A1") => {
  const port = JSON.stringify([
    "port",
    JSON.stringify(["function", uid, fn]),
    "in",
  ]);
  const clip = `clip-${encode(JSON.stringify(["label", "port", port, "terminal"]))}`;
  return `<defs><clipPath id="${clip}"><rect width="200" height="100"/></clipPath></defs><text class="label-terminal" clip-path="url(#${clip})" x="${x}" y="18" font-size="2.5">${value}</text>`;
};

it("resolves a caption from its owned port, even beside a foreign marker", async () => {
  const g = await openSheet(
    page,
    svg(
      marker("owner", "feed", "A1", 100) +
        marker("foreign", "feed", "B1", 15) +
        label("owner", "feed", 15, "B1"),
    ),
  );
  expect(g.texts[0]).toMatchObject({
    labelRole: "terminal",
    deviceUid: "owner",
    terminal: "A1",
  });
  expect(g.texts[0].terminalAppearance).toBeTruthy();
});

it("keeps equal-spelled net labels semantic and still rejects real overlap", async () => {
  const netClip = `clip-${encode(JSON.stringify(["label", "edge", JSON.stringify(["wire", "w"]), "net"]))}`;
  const net = (x) =>
    `<defs><clipPath id="${netClip}"><rect width="200" height="100"/></clipPath></defs><text class="label-net" clip-path="url(#${netClip})" x="${x}" y="18" font-size="2.5">A1</text>`;
  const body = marker("owner", "feed", "A1", 100) + label("owner", "feed", 15);
  const separate = await openSheet(page, svg(body + net(25)));
  expect(
    separate.texts.find((t) => t.labelRole === "net").terminal,
  ).toBeUndefined();
  expect(terminalText(separate)).toEqual([]);
  const overlapping = await openSheet(page, svg(body + net(15)));
  expect(terminalText(overlapping)[0].kind).toBe(
    "duplicate-or-overlapping-terminal-text",
  );
  expect(textBounds(overlapping)[0].kind).toBe("text-text-overlap");
});

it("rejects duplicate captions on one body and retains separate drawn appearances", async () => {
  const body = marker("owner", "feed", "A1", 100) + label("owner", "feed", 15);
  const duplicate = await openSheet(
    page,
    svg(body + label("owner", "feed", 45)),
  );
  expect(terminalText(duplicate)).toHaveLength(1);
  const split = await openSheet(
    page,
    svg(
      body + marker("owner", "other", "A1", 140) + label("owner", "other", 25),
    ),
  );
  expect(split.texts[0].terminalAppearance).not.toBe(
    split.texts[1].terminalAppearance,
  );
  expect(terminalText(split)).toEqual([]);
});
