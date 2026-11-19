import type { Draft, RenderedSheet } from "./types.js";
import type { IssuedDocument } from "./document-types.js";
import { navigationGeometry } from "./navigation-walk.js";
import { printableTextMetrics } from "../symbols/printable-font.js";
import { text } from "./svg.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";

function scope(draft: Draft) {
  return draft.navigationView?.key ?? JSON.stringify(draft.views ?? []);
}

export function terminalInventoryPointers(
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  documents: readonly IssuedDocument[],
): RenderedSheet[] {
  const inventories = documents
    .filter((d) => d.kind === "terminals" || d.kind === "terminal-strip")
    .flatMap((d) => d.rows);
  const measurements = new Map<number, ReturnType<typeof navigationGeometry>>();
  return sheets.map((sheet, index) => {
    const draft = drafts[index];
    if (!draft?.terminalStrip) return sheet;
    const targets = new Map<string, { sheet: number; ref: string }>();
    const duplicate = new Set<string>();
    for (const row of inventories) {
      const owner = drafts[row.sheet - 1];
      const issued = sheets[row.sheet - 1];
      if (!owner || !issued || scope(owner) !== scope(draft)) continue;
      const geometry =
        measurements.get(row.sheet) ?? navigationGeometry(issued.svg);
      measurements.set(row.sheet, geometry);
      const marks = geometry.filter(
        (g) =>
          g.visible &&
          Number(g.style?.opacity ?? 1) > 0 &&
          g.node.attrs["data-strip-row"] === row.nativeKey,
      );
      const ref = marks[0]?.node.text;
      if (marks.length !== 1 || !ref) continue;
      if (targets.has(row.nativeKey)) duplicate.add(row.nativeKey);
      targets.set(row.nativeKey, {
        sheet: row.sheet,
        ref,
      });
    }
    for (const key of duplicate) targets.delete(key);
    if (!targets.size) return sheet;
    return { ...sheet, svg: stripInventoryInk(sheet.svg, targets) };
  });
}

function stripInventoryInk(
  svg: string,
  targets: ReadonlyMap<string, { sheet: number; ref: string }>,
) {
  const replacements = new Map<string, string>();
  for (const { node, visible } of navigationGeometry(svg)) {
    const key = node.attrs["data-strip-terminal"];
    const target = key === undefined ? undefined : targets.get(key);
    if (!visible || key === undefined || target === undefined) continue;
    const label = node.children.find(
      (n) => n.attrs["data-strip-inventory-label"] === key,
    );
    const body = node.children.find((n) => n.name === "rect")?.attrs;
    const ref = node.attrs["data-strip-ref"];
    if (!body || !ref || label?.text !== ref || target.ref !== ref) continue;
    const token = `S${String(target.sheet).padStart(2, "0")}`;
    const x = Number(body.x),
      y = Number(label.attrs.y),
      w = Number(body.width);
    if (
      printableTextMetrics(ref, 2.5).advance +
        printableTextMetrics(token, 2.5).advance +
        1.5 >
      w
    )
      throw Error(`Strip row ${ref} cannot show its inventory sheet at 2.5 mm`);
    replacements.set(
      attr(key),
      text(x + 0.4, y, ref, 2.5) +
        text(x + w - 0.4, y, token, 2.5, "end").replace(
          "<text ",
          `<text data-strip-inventory="${target.sheet}" `,
        ),
    );
  }
  // The marker locates the exact generated Tn/Rn baseline without changing
  // the terminal body, labels, conductor stubs, or jumper approach geometry.
  return svg.replace(
    /<text\b[^>]*data-strip-inventory-label="([^"]*)"[^>]*>[^<]*<\/text>/gu,
    (match, key: string) => replacements.get(key) ?? match,
  );
}
