import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
export async function pdfDocumentFixture(
  text = "LABEL",
  rotation = 0,
  embedded = true,
) {
  const doc = new PDFDocument({ autoFirstPage: false, compress: true }),
    chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.addPage({ size: [720, 360], margin: 0 });
  doc.page.dictionary.data.Rotate = rotation;
  if (embedded)
    doc.font(
      fileURLToPath(
        new URL(
          "../../packages/render/assets/fonts/NotoSans-Regular.ttf",
          import.meta.url,
        ),
      ),
    );
  doc.fontSize(12).text(text, 30, 30);
  doc.end();
  return done;
}
