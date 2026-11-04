import { beforeAll, describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { compileProject, type ElectricalIr } from "@thermite/compiler";
import { renderSchematicPacket } from "@thermite/render";
import { packetPdf } from "../src/alpha-pdf.js";

let ir: ElectricalIr;
beforeAll(async () => {
  const compiled = await compileProject("examples/motor-starter");
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  ir = compiled.ir;
});
async function packet(title: string) {
  const result = await renderSchematicPacket(ir, {
    format: "schematic-packet-request/0.1",
    views: [
      {
        format: "circuit-view-request/0.1",
        title,
        notes: ["Voltage A1−A2; signal A → B; literal & <text> stays text."],
        groups: [
          {
            id: "unconnected-coil",
            functions: [
              { device: { by: "designation", value: "K1" }, key: "coil" },
            ],
            conductors: [],
          },
        ],
      },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function pdfStreams(bytes: Buffer): string {
  return [
    ...bytes
      .toString("latin1")
      .matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/gu),
  ]
    .flatMap((match) => {
      try {
        return [
          inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1"),
        ];
      } catch {
        return [];
      }
    })
    .join("\n");
}

describe("offline PDF glyph fallback", () => {
  it("embeds a math fallback for exact minus/arrow glyphs while preserving primary fonts and packet data", async () => {
    const input = await packet("A1−A2 → signal & return"),
      before = JSON.stringify(input);
    const pdf = await packetPdf(input, "Glyph coverage");
    expect(pdf.toString("latin1")).toContain("NotoSansMath-Regular");
    expect(pdf.toString("latin1")).toContain("NotoSans-Bold");
    expect(pdf.toString("latin1")).toContain("NotoSans-Regular");
    const cmap = pdfStreams(pdf);
    expect(cmap).toMatch(/<2212>/iu);
    expect(cmap).toMatch(/<2192>/iu);
    expect(JSON.stringify(input)).toBe(before);
    expect(await packetPdf(input, "Glyph coverage")).toEqual(pdf);
  });
  it("supports escaped numeric glyphs and inherited nested text without changing their Unicode values", async () => {
    const input = await packet("A1−A2 → signal & return");
    const changed = {
      ...input,
      sheets: input.sheets.map((sheet) => ({
        ...sheet,
        svg: sheet.svg
          .replaceAll("−", "&#x2212;")
          .replaceAll("→", "<tspan>&#8594;</tspan>"),
      })),
    };
    const streams = pdfStreams(await packetPdf(changed, "Escaped glyphs"));
    expect(streams).toMatch(/<2212>/iu);
    expect(streams).toMatch(/<2192>/iu);
  });
  it("still refuses a character outside both bundled font families", async () => {
    await expect(
      packetPdf(await packet("Unsupported 🚀"), "Unsupported"),
    ).rejects.toThrow('does not support "🚀" on sheet 1');
  });
  it("does not embed or select the fallback font when primary fonts cover all text", async () => {
    const input = await packet("Ordinary coil");
    const ordinary = {
      ...input,
      sheets: input.sheets.map((sheet) => ({
        ...sheet,
        svg: sheet.svg.replaceAll("−", "-").replaceAll("→", "to"),
      })),
    };
    const pdf = await packetPdf(ordinary, "Primary fonts");
    expect(pdf.toString("latin1")).not.toContain("NotoSansMath-Regular");
    expect(pdf.toString("latin1")).toContain("NotoSans-Bold");
  });
});

// Read the emitted geometry, not the searchable text layer: clipped-away PDF
// text remains searchable. Coordinates include the PDF graphics-state CTM.
type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
function pdfTextClips(bytes: Buffer) {
  const point = ([a, b, c, d, e, f]: Matrix, x: number, y: number): Point => [
    a * x + c * y + e,
    b * x + d * y + f,
  ];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0],
    clips: Point[][] = [],
    path: Point[] = [];
  const stack: { matrix: Matrix; clips: Point[][] }[] = [],
    text: { clip: Point[]; origin: Point }[] = [];
  for (const line of pdfStreams(bytes).split("\n")) {
    const tokens = line.trim().split(/\s+/u),
      op = tokens.pop(),
      values = tokens.map(Number);
    if (op === "q") stack.push({ matrix, clips });
    else if (op === "Q") ({ matrix, clips } = stack.pop()!);
    else if (op === "cm") {
      const [a, b, c, d, e, f] = values as Matrix,
        [ma, mb, mc, md] = matrix,
        [x, y] = point(matrix, e, f);
      matrix = [
        ma * a + mc * b,
        mb * a + md * b,
        ma * c + mc * d,
        mb * c + md * d,
        x,
        y,
      ];
    } else if (op === "m") path = [point(matrix, values[0]!, values[1]!)];
    else if (op === "l") path.push(point(matrix, values[0]!, values[1]!));
    else if (op === "W" || op === "W*" || line === "W n" || line === "W* n")
      clips = [...clips, path];
    else if (op === "BT")
      text.push({ clip: clips.at(-1)!, origin: [NaN, NaN] });
    else if (op === "Tm" && Number.isNaN(text.at(-1)!.origin[0]))
      text.at(-1)!.origin = point(matrix, values[4]!, values[5]!);
  }
  expect(stack).toHaveLength(0);
  return text;
}

// Local label coordinates deliberately cross the numeric MediaBox bounds.
// The folded viewport maps them back to the same visible position on paper.
async function clippedLabel(
  label: string,
  x: number,
  y: number,
  width: number,
) {
  const input = await packet("Clip geometry"),
    svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="431.8mm" height="279.4mm" viewBox="0 0 431.8 279.4">',
      '<g transform="translate(10 20)">',
      `<svg x="30" y="40" width="50" height="25" viewBox="${x - 10} ${y - 10} 200 100" overflow="hidden">`,
      '<defs><clipPath id="clip-label" clipPathUnits="userSpaceOnUse">',
      `<rect width="${width}" height="14" x="${x}" y="${y}"/>`,
      "</clipPath></defs>",
      `<text class="label-text label-terminal" clip-path="url(#clip-label)" x="${x + 3}" y="${y + 7}" font-family="monospace" font-size="10" dominant-baseline="middle" textLength="${width - 6}" lengthAdjust="spacingAndGlyphs">${label}</text>`,
      "</svg></g></svg>",
    ].join("\n");
  return { ...input, sheets: [{ ...input.sheets[0]!, svg }] };
}

describe("PDF label clipping geometry", () => {
  it.each([
    ["OL1", 1500, 100, 24.6],
    ["2/T1", 1210, 100, 30.8],
    ["W-PWR", 100, 1800, 37],
    ["FIELD", -300, -300, 37],
  ] as const)(
    "keeps %s visible beyond the untransformed page bounds",
    async (label, x, y, width) => {
      const input = await clippedLabel(label, x, y, width),
        before = JSON.stringify(input),
        pdf = await packetPdf(input, "Clip geometry"),
        texts = pdfTextClips(pdf),
        scale = 72 / 25.4,
        left = 42.5 * scale,
        top = 792 - 62.5 * scale;
      expect(texts).toHaveLength(1);
      // Check the actual PDF clip and text origin after every enclosing transform.
      // Merely checking extracted text would pass for the broken PDFs as well.
      expect(texts[0]!.clip).toHaveLength(4);
      const expected = [
        [left, top],
        [left + (width * scale) / 4, top],
        [left + (width * scale) / 4, top - (14 * scale) / 4],
        [left, top - (14 * scale) / 4],
      ];
      for (const [i, corner] of expected.entries())
        for (const axis of [0, 1] as const)
          expect(texts[0]!.clip[i]![axis]).toBeCloseTo(corner[axis]!, 4);
      expect(texts[0]!.origin[0]).toBeCloseTo(left + (3 * scale) / 4, 4);
      expect(texts[0]!.origin[1]).toBeLessThan(top);
      expect(texts[0]!.origin[1]).toBeGreaterThan(top - (14 * scale) / 4);
      expect(pdf.toString("latin1")).not.toContain("/SMask");
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("preserves an intentionally narrow clip instead of dropping clipping", async () => {
    const input = await clippedLabel("2/T1", 1500, 100, 30.8);
    input.sheets[0]!.svg = input.sheets[0]!.svg.replace(
      '<rect width="30.8"',
      '<rect width="2"',
    );
    const pdf = await packetPdf(input, "Narrow clip"),
      [text] = pdfTextClips(pdf);
    expect(text!.clip[1]![0] - text!.clip[0]![0]).toBeCloseTo(
      (2 * 72) / 25.4 / 4,
      4,
    );
    // Text starts outside this deliberately undersized clip and must stay hidden.
    expect(text!.origin[0]).toBeGreaterThan(text!.clip[1]![0]);
    expect(pdf.toString("latin1")).not.toContain("/SMask");
  });

  it("refuses an unrecognized label clip instead of silently losing it", async () => {
    const input = await clippedLabel("OL1", 1500, 100, 24.6);
    input.sheets[0]!.svg = input.sheets[0]!.svg.replace(
      "url(#clip-label)",
      "url(#missing)",
    );
    await expect(packetPdf(input, "Missing clip")).rejects.toThrow(
      "Unsupported PDF label clip on sheet 1. Use SVG/HTML or a supported rectangular label clip.",
    );
  });

  it("accepts reordered rectangle attributes and XML whitespace/quotes without changing geometry", async () => {
    const input = await clippedLabel("OL1", 1500, 100, 24.6),
      expected = await packetPdf(input, "Attribute order");
    for (const rect of [
      '<rect x="1500" y="100" width="24.6" height="14"/>',
      "<rect\n height = '14' x = '1500'\n width = '24.6' y = '100' ></rect>",
    ]) {
      const changed = {
        ...input,
        sheets: [
          {
            ...input.sheets[0]!,
            svg: input.sheets[0]!.svg.replace(/<rect[^>]*\/>/u, rect)
              .replace(
                '<clipPath id="clip-label" clipPathUnits="userSpaceOnUse">',
                "<clipPath\n clipPathUnits = 'userSpaceOnUse' id = 'clip-label' >",
              )
              .replace(
                'clip-path="url(#clip-label)"',
                "clip-path = 'url(#clip-label)'",
              ),
          },
        ],
      };
      expect(await packetPdf(changed, "Attribute order")).toEqual(expected);
    }
  });

  it.each([
    '<rect width="0" height="14" x="1500" y="100"/>',
    '<rect width="24.6" height="0" x="1500" y="100"/>',
    '<rect width="0" height="0" x="1500" y="100"/>',
  ])("drops text behind a zero-area clip: %s", async (rect) => {
    const input = await clippedLabel("OL1", 1500, 100, 24.6);
    input.sheets[0]!.svg = input.sheets[0]!.svg.replace(/<rect[^>]*\/>/u, rect);
    const before = JSON.stringify(input),
      pdf = await packetPdf(input, "Empty clip");
    expect(pdfTextClips(pdf)).toHaveLength(0);
    expect(pdf.toString("latin1")).not.toContain("/SMask");
    expect(pdfStreams(pdf)).not.toContain("NaN");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not validate font coverage for text hidden by an empty clip", async () => {
    const input = await clippedLabel("Hidden 🚀", 1500, 100, 24.6);
    input.sheets[0]!.svg = input.sheets[0]!.svg.replace(
      '<rect width="24.6"',
      '<rect width="0"',
    );
    const pdf = await packetPdf(input, "Invisible glyphs");
    expect(pdfTextClips(pdf)).toHaveLength(0);
  });

  it.each([
    '<circle cx="1500" cy="100" r="14"/>',
    '<rect width="24.6" height="14" x="1500" y="100" rx="2"/>',
    '<rect width="-1" height="14" x="1500" y="100"/>',
    '<rect width="NaN" height="14" x="1500" y="100"/>',
    '<rect width="24.6" height="14" x="1500" y="100" transform="translate(1 0)"/>',
  ])(
    "refuses an existing unsupported clip with sheet context and advice: %s",
    async (shape) => {
      const input = await clippedLabel("OL1", 1500, 100, 24.6);
      input.sheets[0]!.number = 7;
      input.sheets[0]!.svg = input.sheets[0]!.svg.replace(
        /<rect[^>]*\/>/u,
        shape,
      );
      await expect(packetPdf(input, "Unsupported clip")).rejects.toThrow(
        "Unsupported PDF label clip on sheet 7. Use SVG/HTML or a supported rectangular label clip.",
      );
    },
  );

  it.each([
    ["clip-path", 'clip-path="url(#clip-label)"'],
    ["clip-path", "clip-path = 'url(#clip-label)'"],
    ["mask", 'mask="url(#clip-label)"'],
    ["mask", "mask = 'url(#clip-label)'"],
  ])(
    "refuses remaining %s attributes on groups",
    async (attribute, authored) => {
      const input = await clippedLabel("OL1", 1500, 100, 24.6);
      input.sheets[0]!.number = 9;
      input.sheets[0]!.svg = input.sheets[0]!.svg.replace(
        "<g ",
        `<g ${authored} `,
      );
      await expect(packetPdf(input, "Group mask")).rejects.toThrow(
        `Unsupported PDF ${attribute} attribute on sheet 9. Use SVG/HTML or a supported rectangular label clip.`,
      );
    },
  );

  it("does not treat escaped text or other attribute values as clip/mask attributes", async () => {
    const input = await clippedLabel(
      "literal clip-path=&quot;url(#text)&quot; mask=&quot;none&quot;",
      1500,
      100,
      300,
    );
    input.sheets[0]!.svg = input.sheets[0]!.svg.replace(
      "<g ",
      '<g aria-label="literal clip-path=none mask=none" ',
    ).replace(
      "<text ",
      "<text aria-label=\"literal clip-path='url(#text)' mask='none'\" ",
    );
    const pdf = await packetPdf(input, "Literal attributes");
    expect(pdfTextClips(pdf)).toHaveLength(1);
    expect(pdf.toString("latin1")).not.toContain("/SMask");
  });

  it("keeps fallback font spans inside the same label clip", async () => {
    const input = await clippedLabel("A−B", 1500, 100, 24.6),
      pdf = await packetPdf(input, "Clipped fallback"),
      texts = pdfTextClips(pdf);
    expect(texts).toHaveLength(3);
    expect(pdf.toString("latin1")).toContain("NotoSansMath-Regular");
    for (const text of texts) {
      expect(text.clip).toEqual(texts[0]!.clip);
      expect(text.origin[0]).toBeGreaterThan(text.clip[0]![0]);
      expect(text.origin[0]).toBeLessThan(text.clip[1]![0]);
      expect(text.origin[1]).toBeLessThan(text.clip[0]![1]);
      expect(text.origin[1]).toBeGreaterThan(text.clip[2]![1]);
    }
    expect(pdf.toString("latin1")).not.toContain("/SMask");
  });

  it.each([
    ["machine-demo", "left-to-right"],
    ["machine-demo", "top-to-bottom"],
    ["conveyor-line", "left-to-right"],
    ["conveyor-line", "top-to-bottom"],
  ] as const)(
    "converts every label clip in %s / %s without mutating SVG",
    async (example, flow) => {
      const compiled = await compileProject(`examples/${example}`);
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
      const rendered = await renderSchematicPacket(
        compiled.ir,
        {
          format: "schematic-packet-request/0.1",
          layout: "compact",
          views: [
            {
              format: "schematic-view-request/0.1",
              root: { by: "designation", value: "M1" },
              family: "power",
              flow,
            },
          ],
        },
        compiled.presentation,
      );
      if (!rendered.ok) throw new Error(rendered.error.message);
      const input = rendered.value,
        before = JSON.stringify(input),
        pdf = await packetPdf(input, "Motor power"),
        labels = input.sheets.reduce(
          (count, sheet) =>
            count + [...sheet.svg.matchAll(/ clip-path=/gu)].length,
          0,
        );
      expect(labels).toBeGreaterThan(0);
      expect(pdf.toString("latin1")).not.toContain("/SMask");
      expect(JSON.stringify(input)).toBe(before);
    },
  );
});
