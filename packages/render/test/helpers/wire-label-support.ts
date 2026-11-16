import { required } from "../fixtures.js";
export type Point = { x: number; y: number };
export function nativePath(d: string) {
  const tokens = d.match(/[MLHV]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/giu) ?? [];
  const result: Point[] = [];
  let x = 0,
    y = 0;
  while (tokens.length) {
    const command = tokens.shift();
    if (command === "M" || command === "L") {
      x = Number(tokens.shift());
      y = Number(tokens.shift());
    } else if (command === "H") x = Number(tokens.shift());
    else if (command === "V") y = Number(tokens.shift());
    else throw Error("Unexpected native path command");
    result.push({
      x: Number((x - 20).toFixed(3)),
      y: Number((y - 20).toFixed(3)),
    });
  }
  return result;
}
export function on(point: Point, route: readonly Point[]) {
  return route.slice(1).some((b, i) => {
    const a = required(route[i]);
    return Math.abs(a.x - b.x) < 0.001
      ? Math.abs(point.x - a.x) < 0.001 &&
          point.y >= Math.min(a.y, b.y) - 0.001 &&
          point.y <= Math.max(a.y, b.y) + 0.001
      : Math.abs(point.y - a.y) < 0.001 &&
          point.x >= Math.min(a.x, b.x) - 0.001 &&
          point.x <= Math.max(a.x, b.x) + 0.001;
  });
}
export function horizontalSupport(
  box: { left: number; right: number; top: number; bottom: number },
  route: readonly Point[],
  maxGap: number,
) {
  return route.slice(1).some((b, i) => {
    const a = required(route[i]);
    return (
      Math.abs(a.y - b.y) < 0.001 &&
      Math.min(a.x, b.x) <= box.left + 0.001 &&
      Math.max(a.x, b.x) >= box.right - 0.001 &&
      Math.max(box.top - a.y, a.y - box.bottom, 0) <= maxGap
    );
  });
}
