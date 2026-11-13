import { beforeAll, afterAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileProject } from "@thermite/compiler";
import { renderCompactBenchmark } from "../../packages/render/src/internal/drawing-frame/benchmark.js";
import { embedPrintableFont } from "../../packages/cli/dist/printable-font.js";
import { launch, drawingContextOptions } from "./browser.mjs";
import { continuationGeometry } from "./frame-census/continuations.mjs";
import { verifyFrameCounts } from "./frame-census/contracts.mjs";

let browser, page, ir, presentation, template, narrow, folded;
beforeAll(async () => {
  const project = fileURLToPath(
    new URL("../../examples/machine-demo/", import.meta.url),
  );
  const compiled = await compileProject(project);
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  if (!compiled.ok) return;
  ir = compiled.ir;
  presentation = compiled.presentation;
  template = JSON.parse(
    await readFile(
      new URL(
        "../../examples/machine-demo/packet.request.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  narrow = await renderCompactBenchmark(
    ir,
    {
      ...template,
      page: { size: "a3", orientation: "landscape" },
      layout: "standard",
    },
    presentation,
  );
  expect(narrow.ok, JSON.stringify(narrow)).toBe(true);
  folded = await renderCompactBenchmark(
    ir,
    {
      ...template,
      page: { size: "a3", orientation: "landscape" },
      layout: "compact",
    },
    presentation,
  );
  expect(folded.ok, JSON.stringify(folded)).toBe(true);
  browser = await launch();
  page = await (await browser.newContext(drawingContextOptions)).newPage();
}, 120000);
afterAll(async () => {
  await browser?.close();
});
it("M-N1-LEGAL: the narrow repeat sweep uses legal fallback cuts without page growth", () => {
  expect(narrow.ok, JSON.stringify(narrow)).toBe(true);
  if (!narrow.ok) return;
  expect(
    verifyFrameCounts(
      [
        {
          case: "repeat-machine-demo-a3-landscape-standard-left-to-right",
          before: 22,
        },
      ],
      [
        {
          case: "repeat-machine-demo-a3-landscape-standard-left-to-right",
          pages: narrow.value.sheets.length,
        },
      ],
    ).after,
  ).toBe(22);
  for (const sheet of narrow.value.sheets) {
    expect(sheet.svg).toContain(`SHEET ${sheet.number} OF 22`);
    expect(sheet.svg).toContain(`>${sheet.number} of 22</text>`);
  }
});
it("M-N1-LEGAL/GAP: every final stub stays two millimetres long and joins its visible owned route", async () => {
  expect(narrow.ok && folded.ok).toBe(true);
  if (!narrow.ok || !folded.ok) return;
  expect(folded.value.sheets.length).toBe(20);
  let endpoints = 0;
  for (const sheet of [...narrow.value.sheets, ...folded.value.sheets]) {
    if (!sheet.continuations.length) continue;
    const actual = await continuationGeometry(
      page,
      embedPrintableFont(sheet.svg),
      sheet.continuations,
    );
    endpoints += actual.endpoints;
    expect(
      actual.findings,
      `sheet ${sheet.number}: ${JSON.stringify(actual.findings)}`,
    ).toEqual([]);
  }
  expect(endpoints).toBeGreaterThan(0);
});
it("detects a stub shifted inside its own visible route instead of starting at the cut edge", async () => {
  expect(narrow.ok).toBe(true);
  if (!narrow.ok) return;
  const sheet = narrow.value.sheets.find(
    (s) =>
      /<path d="M [^ ]+ [^ ]+ L [^ ]+ [^ ]+"/.test(s.svg) &&
      s.continuations.length,
  );
  expect(sheet).toBeDefined();
  if (!sheet) return;
  let changed = false;
  const svg = sheet.svg.replace(
    /(<a[^>]*data-continuation-id="[^"]+"[^>]*>\s*<path d=")M ([^ ]+) ([^ ]+) L ([^ ]+) ([^"]+)(")/g,
    (match, prefix, x, y, tx, ty, suffix) => {
      if (changed || +y !== +ty || Math.abs(Math.abs(+x - +tx) - 2) > 1e-6)
        return match;
      changed = true;
      const dx = +tx > +x ? -0.1 : 0.1;
      return `${prefix}M ${+x + dx} ${y} L ${+tx + dx} ${ty}${suffix}`;
    },
  );
  expect(changed).toBe(true);
  const actual = await continuationGeometry(
    page,
    embedPrintableFont(svg),
    sheet.continuations,
  );
  expect(
    actual.findings.some((f) => f.kind === "stub-not-on-visible-owned-route"),
  ).toBe(true);
});
it("M-N1-LEGAL: an impossible protected-width case refuses atomically", async () => {
  const request = {
    ...template,
    page: { size: "letter", orientation: "portrait" },
    layout: "standard",
    views: template.views.map((v) =>
      v.flow ? { ...v, flow: "top-to-bottom" } : v,
    ),
  };
  const result = await renderCompactBenchmark(ir, request, presentation);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "R006", reason: "unprintable-layout" },
  });
  if (result.ok) return;
  expect(result.error.message).toMatch(/protected width .*exceeds/);
  expect("value" in result).toBe(false);
});
