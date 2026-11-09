// Raw PDF extraction, including spaces and PDF-only line breaks. No matching
// against SVG text strings: exact-line matching would hide a PDF-only defect.
export async function pdfIdentifierRuns(page) {
  const content = await page.getTextContent({ disableNormalization: true });
  const viewport = page.getViewport({ scale: 25.4 / 72 });
  return content.items
    .filter((item) => typeof item.str === "string" && item.str.length)
    .map((item) => {
      const [x, y] = viewport.convertToViewportPoint(
        item.transform[4],
        item.transform[5],
      );
      const size =
        (Math.hypot(item.transform[2], item.transform[3]) * 25.4) / 72;
      return {
        text: item.str,
        anchor: { x, y },
        bbox: { x, y: y - size, w: (item.width * 25.4) / 72, h: size },
      };
    });
}
