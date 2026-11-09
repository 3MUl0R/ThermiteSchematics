// Evidence-only geometry from the embedded programs and actual glyph placement.
import assert from "node:assert/strict";
import { isDeepStrictEqual as equal } from "node:util";
import { create } from "fontkit";
import { pdfText } from "./pdf.mjs";
import { pdfGlyphRuns } from "./pdf-ink-operators.mjs";
import { canonical, hash } from "./support.mjs";
import { pdfInkRegion, outwardBox } from "./pdf-ink-policy.mjs";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
export async function derivePdfInk(page, document, row) {
  const list = await page.getOperatorList(),
    items = await pdfText(page, document.fontFamilies, document.fontCaps),
    matches = items
      .map((x, i) => ({ x, i }))
      .filter(
        ({ x }) =>
          x.text === row.text &&
          equal(canonical(x.bbox), canonical(row.instanceBbox)),
      );
  assert(
    matches.length === 1,
    "PDF ink requires one exact report text/em association",
  );
  const { x: item, i: textItem } = matches[0],
    fonts = new Map();
  const runs = pdfGlyphRuns(
    list,
    OPS,
    page.getViewport({ scale: 25.4 / 72 }).transform,
    (name, glyph) => {
      if (!fonts.has(name)) {
        const f = page.commonObjs.get(name);
        assert(
          f?.data?.length &&
            !f.missingFile &&
            !f.isType3Font &&
            !f.vertical &&
            !f.isInvalidPDFjsFont &&
            !f.remeasure,
          "PDF ink requires a supported embedded outline font",
        );
        assert(
          equal(f.fontMatrix, [0.001, 0, 0, 0.001, 0, 0]),
          "Unsupported PDF glyph advance matrix",
        );
        const font = create(Buffer.from(f.data));
        assert(
          Number.isFinite(font.unitsPerEm) && font.unitsPerEm > 0,
          "Invalid embedded PDF font units",
        );
        fonts.set(name, { font, sha256: hash(f.data) });
      }
      const { font, sha256 } = fonts.get(name);
      // pdf.js can retain an unmapped space: it advances, but paints no outline.
      assert(
        glyph.isInFont || /^\s+$/u.test(glyph.unicode),
        "Missing embedded PDF glyph",
      );
      if (!glyph.isInFont)
        return { sha256, unitsPerEm: font.unitsPerEm, box: null };
      assert(
        [...glyph.fontChar].length === 1 &&
          font.hasGlyphForCodePoint(glyph.fontChar.codePointAt(0)),
        "Missing PDF fontChar mapping",
      );
      const box = font.glyphForCodePoint(glyph.fontChar.codePointAt(0)).bbox;
      assert(
        [box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite),
        "Nonfinite PDF glyph bounds",
      );
      return {
        sha256,
        unitsPerEm: font.unitsPerEm,
        box: box.maxX > box.minX && box.maxY > box.minY ? box : null,
      };
    },
  );
  const associated = runs.filter(
    (r) =>
      // PDF extraction collapses adjacent literal spaces; geometry is matched too.
      r.text.trim().replace(/ +/g, " ") === item.text &&
      Math.abs(r.start[0] - item.bbox.x) < 0.001 &&
      Math.abs(r.start[1] - item.bbox.y - item.bbox.h) < 0.001 &&
      Math.abs(r.size - item.bbox.h) < 0.001 &&
      Math.abs(
        Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1]) - item.bbox.w,
      ) < 0.001,
  );
  assert(
    associated.length === 1,
    "PDF glyph/operator association is ambiguous or unsupported",
  );
  const run = associated[0];
  assert(
    run.points.length && run.points.length <= 400_000,
    "Missing or excessive PDF glyph outlines",
  );
  const xs = run.points.map((p) => p[0]),
    ys = run.points.map((p) => p[1]);
  const cropShape = {
    kind: "pdf-em-ink/1.0",
    inkBbox: outwardBox(
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ),
    marginPixels: 1,
    textItem,
    operators: run.operators,
    fontPrograms: [...run.fonts].sort(),
  };
  return {
    cropShape,
    sourceBbox: pdfInkRegion(
      row.sourceRender.page,
      row.instanceBbox,
      cropShape,
    ),
  };
}
