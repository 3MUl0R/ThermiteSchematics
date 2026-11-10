import type { Draft } from "./types.js";
import type { RenderOutcome } from "../types.js";

import { circuitTextLines, type CircuitDrawing } from "../circuit.js";
import type { CommunicationDrawing } from "../communication.js";

import { escapeXmlAttribute as attr } from "../svg/escape.js";

import type {
  CommunicationContinuationBlock,
  CircuitContinuationBlock,
} from "./types.js";
import { assemblyNoteLines, text } from "./svg.js";

const communicationPartNotice =
  "Whole port links; repeated bodies describe the same device with other ports. P = view part, S = packet sheet.";
function communicationReferenceLines(
  label: string,
  targets: readonly { part: number; sheet: number }[],
  width: number,
): string[] {
  return assemblyNoteLines(
    `${label} -> ${targets.map((t) => `P${t.part}/S${String(t.sheet).padStart(2, "0")}`).join(", ")}`,
    width,
  );
}
export function communicationPartLines(
  drawing: CommunicationDrawing,
  width: number,
): string[] {
  if (!drawing.pagination) return [];
  return [
    ...assemblyNoteLines(communicationPartNotice, width),
    ...drawing.pagination.devices.flatMap((d) =>
      communicationReferenceLines(
        d.designation,
        d.parts.map((part) => ({ part, sheet: 100 })),
        width,
      ),
    ),
  ];
}
export function emitCommunicationContinuationBlock(
  block: CommunicationContinuationBlock,
): string {
  let y = block.y;
  const out = assemblyNoteLines(communicationPartNotice, block.width).map(
    (s) => {
      const row = text(block.x, y, s, 2.5);
      y += 3.5;
      return row;
    },
  );
  for (const row of block.rows) {
    out.push(
      `<g data-communication-continuation-device="${attr(row.deviceUid)}" data-communication-view="${block.view}" data-from-part="${block.part}" data-destination-parts="${attr(JSON.stringify(row.targets.map((t) => t.part)))}" data-destination-sheets="${attr(JSON.stringify(row.targets.map((t) => t.sheet)))}">`,
    );
    for (const s of communicationReferenceLines(
      row.label,
      row.targets,
      block.width,
    )) {
      out.push(text(block.x, y, s, 2.5));
      y += 3.5;
    }
    out.push("</g>");
  }
  return out.join("");
}
const circuitPartNotice =
  "Whole wires; repeated symbols and terminal IDs describe the same physical equipment. P = group part, S = packet sheet.";
function circuitContinuationLines(
  label: string,
  parts: readonly number[],
  sheets: readonly number[],
  width: number,
): string[] {
  return circuitTextLines(
    `${label} -> ${parts.map((part, i) => `P${part}/S${String(sheets[i] ?? 100).padStart(2, "0")}`).join(", ")}`,
    width,
  );
}
export function circuitPartHeight(
  group: CircuitDrawing,
  width: number,
): number {
  if (!group.pagination) return 0;
  const lines =
    circuitTextLines(circuitPartNotice, width).length +
    group.pagination.terminals.reduce(
      (count, t) =>
        count + circuitContinuationLines(t.label, t.parts, [], width).length,
      0,
    );
  return 4 + lines * 3.5;
}
export function emitCircuitContinuationBlock(
  block: CircuitContinuationBlock,
): string {
  let y = block.y;
  const out = circuitTextLines(circuitPartNotice, block.width).map((s) => {
    const row = text(block.x, y, s, 2.5);
    y += 3.5;
    return row;
  });
  for (const row of block.rows) {
    out.push(
      `<g data-circuit-continuation="${attr(block.group)}" data-from-part="${block.part}" data-continuation-terminal="${attr(row.id)}" data-destination-parts="${attr(JSON.stringify(row.targets.map((t) => t.part)))}" data-destination-sheets="${attr(JSON.stringify(row.targets.map((t) => t.sheet)))}">`,
    );
    for (const s of circuitContinuationLines(
      row.label,
      row.targets.map((t) => t.part),
      row.targets.map((t) => t.sheet),
      block.width,
    )) {
      out.push(text(block.x, y, s, 2.5));
      y += 3.5;
    }
    out.push("</g>");
  }
  return out.join("");
}

export { drawingContinuations } from "./rooted-links.js";

export function resolveCircuitContinuations(drafts: Draft[]): void {
  for (const draft of drafts)
    draft.circuitBlocks = (draft.circuitParts ?? []).map(
      ({ drawing, x, y, width }) => ({
        group: drawing.id,
        part: drawing.pagination!.part,
        x,
        y,
        width,
        rows: drawing.pagination!.terminals.map((t) => ({
          id: t.id,
          label: t.label,
          targets: t.parts.map((part) => {
            const sheet = drafts.findIndex((d) =>
              d.circuitParts?.some(
                (p) =>
                  p.drawing.id === drawing.id &&
                  p.drawing.pagination!.part === part,
              ),
            );
            if (sheet < 0)
              throw new Error("Circuit continuation destination is missing.");
            return { part, sheet: sheet + 1 };
          }),
        })),
      }),
    );
}
