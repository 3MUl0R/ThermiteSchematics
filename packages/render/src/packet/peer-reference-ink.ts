import { escapeXmlAttribute as attr } from "../svg/escape.js";
import type { Rect } from "../device-legend/geometry.js";
import { printableTextMetrics } from "../symbols/printable-font.js";
import { required } from "../presentation/util.js";
import { allocateNavigationSlots } from "./navigation-slots.js";
import { text } from "./svg.js";
import type { RenderedSheet } from "./types.js";

export interface PeerReference {
  kind:
    | "attachment"
    | "assembly-inventory"
    | "conductor-peer"
    | "terminal-interface";
  identity: readonly unknown[];
  value: string;
  owner: Rect;
}

export function emitPeerReferences(
  sheet: RenderedSheet,
  field: Rect,
  entries: readonly PeerReference[],
): RenderedSheet {
  if (!entries.length) return sheet;
  const requests = entries.map(({ kind, value, owner }, i) => {
    const id = `peer-reference/${sheet.number}/${i}`;
    return {
      owner,
      reservation: {
        id,
        ownerAppearance: id,
        ownerOccurrence: id,
        profileId: kind,
        space: "sheet-slot" as const,
        inkMm: {
          x: 0,
          y: 0,
          w: printableTextMetrics(value, 2.5).advance + 2,
          h: 4.6,
        },
        maximumForms: [value],
      },
    };
  });
  const slots = allocateNavigationSlots(
    requests,
    field,
    sheet.svg,
    sheet.number,
  );
  const markup = entries
    .map(({ kind, identity, value }, i) => {
      const box = required(
        slots[i]?.allocatedMm,
        "Missing peer reference slot",
      ).rect;
      return text(box.x + 1, box.y + 3, value, 2.5).replace(
        "<text ",
        `<text data-peer-reference="${kind}" data-peer-source="${attr(JSON.stringify(identity))}" `,
      );
    })
    .join("");
  return {
    ...sheet,
    svg: sheet.svg.replace(/<\/svg>(\s*)$/u, `${markup}</svg>$1`),
  };
}
