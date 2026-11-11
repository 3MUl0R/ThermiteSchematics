import { required } from "../presentation/util.js";
import { tagAttributes } from "../device-tag-ownership.js";
import {
  escapeXmlAttribute as attr,
  escapeXmlText as xml,
} from "../svg/escape.js";
import { n } from "../packet/svg.js";
import { LEGEND_TITLE, type LegendLayout } from "./placement.js";
export function legendSvg(layout: LegendLayout, scale = 1) {
  const { box } = layout;
  let svg = `<g data-device-legend="true" transform="scale(${n(1 / scale)})"><rect class="device-legend-frame" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="white" stroke="#667085" stroke-width="0.25"/>`;
  svg += `<text x="${n(box.x + 3)}" y="${n(box.y + 3.7)}" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="2.7" font-weight="bold" fill="#101828">${LEGEND_TITLE}</text>`;
  for (const e of layout.entries) {
    const uid = e.tag.ownerUid,
      key = required(
        e.tag.fields.find((f) => f.field === "designation"),
        "Missing legend geometry",
      ).value;
    svg += `<g data-device-legend-entry="true" ${tagAttributes(uid, undefined, "legend")} data-tag-key="${attr(key)}">`;
    for (const row of e.tag.rows)
      svg += `<text ${tagAttributes(uid, row.field, "legend")} data-tag-key="${attr(key)}" x="${n(box.x + e.x + row.x)}" y="${n(box.y + e.y + row.baseline)}" font-family="Thermite Sans, Thermite Math, sans-serif" font-size="${row.emMm}" font-weight="${row.bold ? "bold" : "normal"}" fill="#101828" xml:space="preserve" style="white-space:pre">${xml(row.text)}</text>`;
    svg += "</g>";
  }
  return svg + "</g>";
}
