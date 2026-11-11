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
const label = (
  uid,
  fn,
  x,
  value = "A1",
  role = "terminal",
  ownerKind = "port",
) => {
  const port = JSON.stringify([
    "port",
    JSON.stringify(["function", uid, fn]),
    "in",
  ]);
  const owner = ownerKind === "edge" ? JSON.stringify(["wire", "w"]) : port;
  const clip = `clip-${encode(JSON.stringify(["label", ownerKind, owner, role]))}`;
  return `<defs><clipPath id="${clip}"><rect width="200" height="100"/></clipPath></defs><text class="label-${role}" clip-path="url(#${clip})" x="${x}" y="18" font-size="2.5">${value}</text>`;
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

it.each([
  ["net", "port"],
  ["terminal", "edge"],
])("rejects the inconsistent %s role on a %s owner", async (role, kind) => {
  const g = await openSheet(
    page,
    svg(
      marker("owner", "feed", "A1", 100) +
        label("owner", "feed", 15, "A1", role, kind),
    ),
  );
  expect(terminalText(g)).toEqual([
    expect.objectContaining({
      kind: "invalid-terminal-caption-ownership",
      reason: "role-owner-mismatch",
    }),
  ]);
  if (kind === "port")
    expect(g.texts[0]).toMatchObject({
      deviceUid: "owner",
      terminal: "A1",
      labelRole: "net",
    });
});

it.each([
  [
    "unknown marker id",
    (body) => body.replace(/id="terminal-[^"]*"/, 'id="unresolved"'),
  ],
  [
    "different port id",
    (body) => body.replace(`${encode("in")}"`, `${encode("out")}"`),
  ],
  [
    "foreign marker identity",
    (body) =>
      body.replace(
        `terminal-${encode("owner")}--`,
        `terminal-${encode("foreign")}--`,
      ),
  ],
  [
    "inconsistent terminal key",
    (body) => body.replace('data-terminal-key="A1"', 'data-terminal-key="B1"'),
  ],
  [
    "missing device owner",
    (body) => body.replace(' data-device-uid="owner"', ""),
  ],
  [
    "missing terminal owner",
    (body) => body.replace(' data-terminal-key="A1"', ""),
  ],
  [
    "duplicate marker declaration",
    (body) => body.replace("</g>", `${body.match(/<circle[^>]*\/>/)[0]}</g>`),
  ],
])("fails closed on %s", async (_name, mutate) => {
  const body = mutate(marker("owner", "feed", "A1", 100));
  const g = await openSheet(page, svg(body + label("owner", "feed", 15)));
  expect(terminalText(g)).toEqual([
    expect.objectContaining({
      kind: "invalid-terminal-caption-ownership",
      reason: "unresolved-terminal-caption-owner",
    }),
  ]);
});

it.each(["absent", "malformed"])(
  "rejects %s caption keys 5 mm apart near a marker",
  async (kind) => {
    const attrs = kind === "malformed" ? ' clip-path="url(#unrecognized)"' : "";
    const captions = [15, 20]
      .map(
        (x) =>
          `<text class="label-terminal" x="${x}" y="18" font-size="2.5"${attrs}>A1</text>`,
      )
      .join("");
    const g = await openSheet(
      page,
      svg(marker("owner", "feed", "A1", 18) + captions),
    );
    expect(terminalText(g)).toHaveLength(2);
    expect(
      terminalText(g).every(
        (f) =>
          f.kind === "invalid-terminal-caption-ownership" &&
          f.reason === "missing-caption-owner-key",
      ),
    ).toBe(true);
  },
);

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
