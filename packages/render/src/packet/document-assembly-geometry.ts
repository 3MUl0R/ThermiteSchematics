import type { ElectricalIr } from "@thermite/compiler";
import { buildConnectorAssemblyInventory } from "@thermite/query";
import type { Draft, PaperPage, RenderedSheet } from "./types.js";
import { navigationGeometry } from "./navigation-walk.js";
import { navigationZone } from "./navigation-location.js";
import { bounds } from "./page.js";
import { inside, project } from "../device-legend/geometry.js";
import { required } from "../presentation/util.js";

export const connectorPortKey = (uid: string, key: string) =>
  JSON.stringify([uid, key]);
export function assemblyPortGeometry(
  ir: Readonly<ElectricalIr>,
  drafts: readonly Draft[],
  sheets: readonly RenderedSheet[],
  page: PaperPage,
) {
  const inventory = buildConnectorAssemblyInventory(ir);
  const native = new Set(
    inventory.ports.map((p) => connectorPortKey(p.deviceUid, p.key)),
  );
  const parts = sheets.flatMap((sheet, i) => {
    if (!("kind" in sheet.view) || sheet.view.kind !== "connector-assembly")
      return [];
    const draft = required(drafts[i], "Missing assembly source sheet");
    const field = draft.drawingBounds ?? bounds(draft.title, page);
    const all = navigationGeometry(sheet.svg);
    const byNode = new Map(all.map((g) => [g.node, g]));
    const devices = new Set(
      all
        .filter((g) => g.visible && g.node.attrs["data-device-uid"])
        .map((g) => g.node.attrs["data-device-uid"]),
    );
    const ports = all.flatMap((g) => {
      const key = g.node.attrs["data-connector-port"],
        uid = g.deviceUid;
      if (!g.visible || !key || !uid || !native.has(connectorPortKey(uid, key)))
        return [];
      const circle = g.node.children.find((n) => n.name === "circle");
      const mark = circle && byNode.get(circle);
      if (!mark || !paintedStroke(mark) || !(Number(circle.attrs.r) > 0))
        return [];
      const point = project(
        {
          x: Number(circle.attrs.cx ?? 0),
          y: Number(circle.attrs.cy ?? 0),
          w: 0,
          h: 0,
        },
        mark.matrix,
      );
      if (!inside(point, mark.clip) || !inside(point, field)) return [];
      return [
        {
          id: connectorPortKey(uid, key),
          deviceUid: uid,
          portKey: key,
          sheet: sheet.number,
          zone: navigationZone(point.x, point.y, field),
          point,
        },
      ];
    });
    return [{ sheet: sheet.number, devices, ports, field }];
  });
  const targets = new Map<string, { sheet: number; zone: string }>();
  for (const part of parts)
    for (const port of part.ports)
      if (!targets.has(port.id)) targets.set(port.id, port);
  return { inventory, parts, targets };
}

export function paintedStroke(
  g: ReturnType<typeof navigationGeometry>[number],
) {
  const s = g.style ?? g.node.attrs;
  return (
    g.visible &&
    Number(s.opacity ?? 1) > 0 &&
    !["none", "transparent", "white", "#fff", "#ffffff", undefined].includes(
      s.stroke,
    ) &&
    Number(s["stroke-opacity"] ?? 1) > 0 &&
    Number(s["stroke-width"] ?? 1) > 0
  );
}
