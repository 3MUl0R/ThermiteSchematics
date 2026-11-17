import { readFile } from "node:fs/promises";
import { sheetMeasurementSource, openSheet } from "./browser.mjs";
import { classifyTextGeometry } from "./text-classification.mjs";
import { retainLostText } from "./lost-text.mjs";
import { viewKey } from "./locators.mjs";
import {
  identifierContext,
  identifierErrorPattern,
} from "./identifier-errors.mjs";
export async function measurePacketGeometry(
  page,
  htmlPath,
  packet,
  ir,
  geometries,
) {
  await page.setContent(await readFile(htmlPath, "utf8"));
  await page.evaluate(() => document.fonts.ready);
  const measured = await page.evaluate(
    ({ source, pattern }) => {
      const measure = (0, eval)(`(${source})`);
      return Array.from(document.querySelectorAll("section>svg")).map((_, i) =>
        (() => {
          try {
            return {
              geometry: measure({
                selector: `#sheet-${i + 1}>svg`,
                textOnly: true,
              }),
            };
          } catch (error) {
            if (!new RegExp(pattern).test(error.message)) throw error;
            return { error: error.message, sheet: i + 1 };
          }
        })(),
      );
    },
    { source: sheetMeasurementSource(), pattern: identifierErrorPattern },
  );
  const htmlGeometry = measured.map((r) => {
    if (r.error) throw identifierContext(Error(r.error), r.sheet, "html");
    return r.geometry;
  });
  const htmlSvgs = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll("section>svg"),
      (svg) => svg.outerHTML,
    ),
  );
  for (const g of htmlGeometry) classifyTextGeometry(g, ir);
  retainLostText(
    htmlGeometry,
    packet.sheets.map((s) => viewKey(s.view)),
  );
  // Collect all tiled copies before deciding whether a semantic label was lost.
  for (const sheet of packet.sheets) {
    try {
      geometries.push(await openSheet(page, sheet.svg));
    } catch (error) {
      throw identifierContext(error, sheet.number, "svg");
    }
  }
  retainLostText(
    geometries,
    packet.sheets.map((s) => viewKey(s.view)),
  );
  return { htmlGeometry, htmlSvgs };
}
