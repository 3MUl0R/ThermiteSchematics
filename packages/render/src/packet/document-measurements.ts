import { intersection, project, type Rect } from "../device-legend/geometry.js";
import type { NavigationGeometry } from "./navigation-walk.js";

/** Per immutable generated sheet; never retained across renders or IR edits. */
export function documentMeasurements(geometry: readonly NavigationGeometry[]) {
  const byId = new Map<string, NavigationGeometry>(),
    byNode = new Map<NavigationGeometry["node"], NavigationGeometry>(),
    indices = new Map<NavigationGeometry, number>(),
    texts = new Map<NavigationGeometry["node"], boolean>();
  for (const [index, g] of geometry.entries()) {
    const id = g.node.attrs.id;
    if (id !== undefined && !byId.has(id)) byId.set(id, g);
    if (!byNode.has(g.node)) byNode.set(g.node, g);
    if (!indices.has(g)) indices.set(g, index);
  }
  let rectangles: { index: number; box: Rect }[] | undefined;
  return {
    byId,
    byNode,
    texts,
    covered(ink: Rect, g: NavigationGeometry) {
      rectangles ??= geometry.flatMap((later, index) => {
        if (!later.visible || later.node.name !== "rect") return [];
        const s = later.style ?? later.node.attrs,
          a = later.node.attrs;
        if (
          s.fill === "none" ||
          s.fill === "transparent" ||
          Number(s.opacity ?? 1) === 0
        )
          return [];
        const box = intersection(
          project(
            {
              x: Number(a.x ?? 0),
              y: Number(a.y ?? 0),
              w: Number(a.width),
              h: Number(a.height),
            },
            later.matrix,
          ),
          later.clip,
        );
        return box ? [{ index, box }] : [];
      });
      const index = indices.get(g) ?? -1;
      return rectangles.some(
        (later) => later.index > index && !!intersection(ink, later.box),
      );
    },
  };
}
export type DocumentMeasurements = ReturnType<typeof documentMeasurements>;
