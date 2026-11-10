// Painted PDF extraction, including spaces and PDF-only line breaks. No matching
// against SVG text strings: exact-line matching would hide a PDF-only defect.
import { paintedPdfItems } from "./pdf-painted.mjs";
export async function pdfIdentifierRuns(page) {
  const content = await page.getTextContent({ disableNormalization: true });
  const viewport = page.getViewport({ scale: 25.4 / 72 });
  const items = content.items
    .filter((item) => typeof item.str === "string" && item.str.length)
    .map((item, index) => {
      const [x, y] = viewport.convertToViewportPoint(
        item.transform[4],
        item.transform[5],
      );
      const size =
        (Math.hypot(item.transform[2], item.transform[3]) * 25.4) / 72;
      return {
        text: item.str,
        extractionIndex: index,
        fontSize: size,
        anchor: { x, y },
        bbox: { x, y: y - size, w: (item.width * 25.4) / 72, h: size },
      };
    });
  const nonempty = content.items.filter(
    (item) => typeof item.str === "string" && item.str.trim(),
  );
  const measured = items.filter((item) => item.text.trim());
  const painted = await paintedPdfItems(page, measured, nonempty);
  // Extraction-only whitespace separates runs/columns; it carries no ink.
  // Preserve those separators while all character-bearing runs use PDF clips.
  return [...painted, ...items.filter((item) => !item.text.trim())]
    .sort((a, b) => a.extractionIndex - b.extractionIndex)
    .map(({ fontSize, extractionIndex, ...item }) => item);
}
