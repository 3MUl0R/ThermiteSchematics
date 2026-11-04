import { openSync } from "fontkit";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import type { RenderedPacket } from "@thermite/render";

const decodeText = (value: string) =>
  value.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|(amp|lt|gt|quot|apos));/giu,
    (_, code: string | undefined, name: string | undefined) =>
      code
        ? String.fromCodePoint(
            code[0]!.toLowerCase() === "x"
              ? parseInt(code.slice(1), 16)
              : Number(code),
          )
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
            name!.toLowerCase() as "amp"
          ]!,
  );
const encodeText = (value: string) =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/**
 * Keep the emitter's rectangular label clips, using native PDF clipping.
 * svg-to-pdfkit implements clipPath with a luminosity soft mask. Apple
 * PDFKit/Quartz (Preview, Quick Look) truncates these masks at the untransformed
 * page bounds, losing labels whose local coordinates lie outside those bounds
 * in a scaled/folded view.
 * An identity viewport produces a real PDF clip in the current coordinate
 * system instead. This handles only the internal emitter's rectangular clips;
 * the original SVG and its font-overhang protection remain unchanged.
 */
function withPdfLabelClips(svg: string, sheet: number): string {
  const attributePattern = /\s+([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/gu;
  const unsupported = (feature: string) =>
    new Error(
      `Unsupported PDF ${feature} on sheet ${sheet}. Use SVG/HTML or a supported rectangular label clip.`,
    );
  const attributes = (source: string, allowed: readonly string[]) => {
    const values = new Map<string, string>();
    let valid = true;
    const remainder = source.replace(
      attributePattern,
      (_, name: string, _quote: string, value: string) => {
        if (!allowed.includes(name) || values.has(name)) valid = false;
        values.set(name, value);
        return "";
      },
    );
    return valid && !remainder.trim() ? values : undefined;
  };
  const clips = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();
  for (const match of svg.matchAll(
    /<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/gu,
  )) {
    const clip = attributes(match[1]!, ["id", "clipPathUnits"]),
      rect = /^\s*<rect\b([^>]*?)(?:\/>|>\s*<\/rect>)\s*$/u.exec(match[2]!);
    if (
      !clip?.get("id") ||
      clip.get("clipPathUnits") !== "userSpaceOnUse" ||
      !rect
    )
      continue;
    const geometry = attributes(rect[1]!, ["x", "y", "width", "height"]),
      [x, y, width, height] = ["x", "y", "width", "height"].map((name) => {
        const value = geometry?.get(name)?.trim() ?? "";
        return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)
          ? Number(value)
          : NaN;
      });
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      width! < 0 ||
      height! < 0
    )
      continue;
    clips.set(clip.get("id")!, {
      x: x!,
      y: y!,
      width: width!,
      height: height!,
    });
  }
  const normalized = svg.replace(
    /<text\b([^>]*)>([\s\S]*?)<\/text>/gu,
    (text, attrs: string, body: string) => {
      const reference = [...attrs.matchAll(attributePattern)].find(
        (attribute) => attribute[1] === "clip-path",
      );
      if (!reference) return text;
      const id = /^url\(#([^)]+)\)$/u.exec(reference[3]!);
      const clip = id && clips.get(id[1]!);
      if (!clip) throw unsupported("label clip");
      const { x, y, width, height } = clip;
      if (width === 0 || height === 0) return "";
      return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}" overflow="hidden"><text${attrs.replace(reference[0], "")}>${body}</text></svg>`;
    },
  );
  // Inspect real attributes, not escaped label text or words in other values.
  // Any future group clips/masks must also avoid the converter's soft-mask path.
  for (const tag of normalized.matchAll(/<[A-Za-z][^>]*>/gu)) {
    for (const attribute of tag[0].matchAll(attributePattern)) {
      if (attribute[1] === "clip-path" || attribute[1] === "mask")
        throw unsupported(`${attribute[1]} attribute`);
    }
  }
  return normalized;
}

/** Font-only spans preserve the text chunk's shared anchor, baseline and position. */
function withPdfFontFallback(
  svg: string,
  sheet: number,
  primary: ReadonlySet<number>,
  math: ReadonlySet<number>,
): string {
  return svg.replace(
    /(<text\b[^>]*>)([\s\S]*?)(<\/text>)/gu,
    (_, open: string, body: string, close: string) => {
      const converted = body
        .split(/(<[^>]*>)/u)
        .map((part) => {
          if (part.startsWith("<")) return part;
          const runs: { fallback: boolean; value: string }[] = [];
          for (const char of decodeText(part)) {
            const fallback =
              !/\s/u.test(char) && !primary.has(char.codePointAt(0)!);
            if (fallback && !math.has(char.codePointAt(0)!))
              throw new Error(
                `PDF font does not support ${JSON.stringify(char)} on sheet ${sheet}. Use SVG/HTML or a supported label.`,
              );
            if (runs.at(-1)?.fallback === fallback) runs.at(-1)!.value += char;
            else runs.push({ fallback, value: char });
          }
          // Leave existing typography and converter input untouched without fallback.
          if (!runs.some((run) => run.fallback)) return part;
          return runs
            .map((run) =>
              run.fallback
                ? `<tspan font-family="ThermiteMath">${encodeText(run.value)}</tspan>`
                : encodeText(run.value),
            )
            .join("");
        })
        .join("");
      return open + converted + close;
    },
  );
}

/** Convert only an internally generated packet; never import arbitrary SVG documents. */
export async function packetPdf(
  packet: RenderedPacket,
  title: string,
): Promise<Buffer> {
  const regular = fileURLToPath(
    new URL("../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
  );
  const bold = fileURLToPath(
    new URL("../assets/fonts/NotoSans-Bold.ttf", import.meta.url),
  );
  const math = fileURLToPath(
    new URL("../assets/fonts/NotoSansMath-Regular.ttf", import.meta.url),
  );
  const coverage = (path: string) => {
    const font = openSync(path);
    if (!("characterSet" in font))
      throw new Error("Expected the bundled TrueType font.");
    return new Set(font.characterSet);
  };
  const regularCoverage = coverage(regular),
    boldCoverage = coverage(bold),
    mathCoverage = coverage(math);
  const primary = new Set(
    [...regularCoverage].filter((code) => boldCoverage.has(code)),
  );
  const svgs = packet.sheets.map((sheet) =>
    withPdfFontFallback(
      withPdfLabelClips(sheet.svg, sheet.number),
      sheet.number,
      primary,
      mathCoverage,
    ),
  );
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    info: {
      Title: title,
      Author: "Thermite Schematics",
      Creator: "Thermite Schematics",
      CreationDate: new Date(0),
      ModDate: new Date(0),
    },
  });
  // svg-to-pdfkit emits all anchors as URI annotations. Convert our known
  // sheet fragments into actual PDF destinations before their objects flush.
  const ref = doc.ref.bind(doc);
  const destinations = new Set(
    packet.sheets.map((sheet) => `#sheet-${sheet.number}`),
  );
  doc.ref = (data) => {
    const annotation = data as
      | { Type?: string; Subtype?: string; A?: { S?: string; URI?: unknown } }
      | undefined;
    if (
      annotation?.Type === "Annot" &&
      annotation.Subtype === "Link" &&
      annotation.A?.S === "URI"
    ) {
      const target = String(annotation.A.URI);
      if (!destinations.has(target))
        throw new Error(`Unknown packet PDF link: ${target}`);
      return ref({ ...data, A: { S: "GoTo", D: new String(target.slice(1)) } });
    }
    return ref(data);
  };
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const warnings: string[] = [];
  try {
    doc.registerFont("ThermiteRegular", regular);
    doc.registerFont("ThermiteBold", bold);
    doc.registerFont("ThermiteMath", math);
    const width = (packet.page.widthMm * 72) / 25.4,
      height = (packet.page.heightMm * 72) / 25.4;
    for (const [index, sheet] of packet.sheets.entries()) {
      doc.addPage({ size: [width, height], margin: 0 });
      doc.addNamedDestination(`sheet-${sheet.number}`, "Fit");
      SVGtoPDF(doc, svgs[index]!, 0, 0, {
        width,
        height,
        assumePt: false,
        fontCallback: (family, isBold, _italic, options) => {
          if (family === "ThermiteMath") {
            options.fauxBold = isBold;
            return "ThermiteMath";
          }
          return isBold ? "ThermiteBold" : "ThermiteRegular";
        },
        imageCallback: () => {
          throw new Error("Packet PDF cannot load external images.");
        },
        documentCallback: () => {
          throw new Error("Packet PDF cannot load external documents.");
        },
        warningCallback: (message) => warnings.push(message),
      });
    }
    doc.end();
  } catch (error) {
    (doc as unknown as Readable).destroy(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  const bytes = await completed;
  if (warnings.length)
    throw new Error(
      `PDF conversion failed validation: ${[...new Set(warnings)].join("; ")}`,
    );
  return bytes;
}
