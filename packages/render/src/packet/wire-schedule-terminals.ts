import type { ElectricalIr } from "@thermite/compiler";
import type { SvgNode } from "../device-legend/svg-tree.js";
import type { NavigationGeometry } from "./navigation-walk.js";
import type { Draft } from "./types.js";
import { sourceIncidences } from "./navigation-incidence.js";
import { terminalIdKey } from "../ordering.js";
import { required } from "../presentation/util.js";

/** Branch/junction dots and zero-paint routing stubs carry terminal provenance
 * for ray/landing audits, not physical terminal locations. */
export function isNonTerminalCircle(
  attrs: Readonly<Record<string, string>>,
): boolean {
  return (
    /\bjunction-dot\b/u.test(attrs.class ?? "") ||
    attrs["data-circuit-junction"] !== undefined ||
    attrs["data-wiring-junction"] !== undefined ||
    attrs["data-circuit-landing-for"] !== undefined ||
    attrs["data-wiring-landing-for"] !== undefined
  );
}

function parseTerminalTuple(raw: string, label: string): [string, string] {
  const terminal: unknown = JSON.parse(raw);
  if (
    !Array.isArray(terminal) ||
    terminal.length !== 2 ||
    terminal.some((s) => typeof s !== "string")
  )
    throw Error(`Invalid native ${label} terminal identity`);
  return [terminal[0], terminal[1]];
}

function portGroupTerminalKey(
  port: NavigationGeometry,
  native: ReadonlyMap<string, string> | undefined,
): string | undefined {
  const a = port.node.attrs;
  if (a["data-terminal-id"]) {
    const [uid, key] = parseTerminalTuple(a["data-terminal-id"], "port-group");
    const serialized = JSON.stringify([uid, key]);
    if (
      (port.deviceUid && port.deviceUid !== uid) ||
      (a["data-terminal-key"] && a["data-terminal-key"] !== key) ||
      (native && native.get(serialized) !== uid)
    )
      return undefined;
    return serialized;
  }
  if (a["data-loop-terminal"])
    return JSON.stringify(
      parseTerminalTuple(a["data-loop-terminal"], "loop port-group"),
    );
  if (a["data-layout-port"] && port.deviceUid && a["data-terminal-key"])
    return JSON.stringify([port.deviceUid, a["data-terminal-key"]]);
  return undefined;
}

const UNPAINTED_COLORS = new Set([
  "none",
  "transparent",
  "white",
  "#fff",
  "#ffffff",
  "rgb(255,255,255)",
  "rgba(0,0,0,0)",
]);

function isVisiblePaintColor(
  raw: string | undefined,
  fallback?: string,
): boolean {
  const value = (raw ?? fallback ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "");
  if (!value || UNPAINTED_COLORS.has(value)) return false;
  return !/^rgba\([^,]+,[^,]+,[^,]+,0(?:\.0+)?\)$/u.test(value);
}

/** A physical marker circle must be visible with positive radius and a visible fill or non-zero stroke. */
export function isPaintedMarkerCircle(g: NavigationGeometry): boolean {
  if (
    g.node.name !== "circle" ||
    !g.visible ||
    isNonTerminalCircle(g.node.attrs)
  )
    return false;
  if (!(Number(g.node.attrs.r) > 0)) return false;
  const s = g.style ?? g.node.attrs;
  if (!(Number(s.opacity ?? 1) > 0)) return false;
  const filled =
    Number(s["fill-opacity"] ?? 1) > 0 && isVisiblePaintColor(s.fill, "black");
  const stroked =
    Number(s["stroke-opacity"] ?? 1) > 0 &&
    parseFloat(s["stroke-width"] ?? "1") > 0 &&
    isVisiblePaintColor(s.stroke);
  return filled || stroked;
}

function portGroupTerminalKeys(
  ir: Readonly<ElectricalIr>,
  geometry: readonly NavigationGeometry[],
  keys: Map<SvgNode, string>,
) {
  const native = Array.isArray(ir.terminals)
    ? new Map(ir.terminals.map(({ id }) => [terminalIdKey(id), id.deviceUid]))
    : undefined;
  const byNode = new Map(geometry.map((g) => [g.node, g]));
  for (const g of geometry) {
    if (g.node.name !== "g" || !g.visible) continue;
    const key = portGroupTerminalKey(g, native);
    if (!key) continue;
    const paintedCircles = g.node.children.filter((n) => {
      const child = byNode.get(n);
      return child !== undefined && isPaintedMarkerCircle(child);
    });
    if (paintedCircles.length !== 1) continue;
    const circle = paintedCircles[0];
    if (circle && !keys.has(circle)) keys.set(circle, key);
  }
}

/** Adapter-owned native identities, never a designation inferred from ink. */
export function wireScheduleTerminalKeys(
  ir: Readonly<ElectricalIr>,
  draft: Draft,
  geometry: readonly NavigationGeometry[],
): ReadonlyMap<SvgNode, string> {
  const keys = new Map<SvgNode, string>();
  for (const g of geometry) {
    if (
      g.node.name !== "circle" &&
      !(g.node.name === "text" && g.node.attrs["data-pin-terminal"])
    )
      continue;
    const a = g.node.attrs;
    if (g.node.name === "circle" && isNonTerminalCircle(a)) continue;
    if (a["data-pin-terminal"]) {
      keys.set(
        g.node,
        JSON.stringify(parseTerminalTuple(a["data-pin-terminal"], "pin-list")),
      );
    } else if (a["data-loop-terminal"]) {
      keys.set(
        g.node,
        JSON.stringify(parseTerminalTuple(a["data-loop-terminal"], "loop")),
      );
    } else if (g.deviceUid && a["data-terminal-key"]) {
      keys.set(g.node, JSON.stringify([g.deviceUid, a["data-terminal-key"]]));
    }
  }
  portGroupTerminalKeys(ir, geometry, keys);
  if (
    draft.view.format === "schematic-view/0.2" &&
    draft.view.intent === "conductors"
  )
    cableTerminalKeys(ir, geometry, keys);
  return keys;
}

/** Cable rows print native end A then end B, omitting markers for null ends.
 * This binding uses the native core structure and the adapter's actual circles. */
function cableTerminalKeys(
  ir: Readonly<ElectricalIr>,
  geometry: readonly NavigationGeometry[],
  keys: Map<SvgNode, string>,
) {
  const incidences = sourceIncidences(ir);
  for (const g of geometry) {
    const a = g.node.attrs;
    if (g.node.name !== "g" || !a["data-cable-uid"] || !a["data-conductor-id"])
      continue;
    const ends = incidences.filter(
      (i) =>
        i.element.kind === "cable_conductor" &&
        i.element.cableUid === a["data-cable-uid"] &&
        i.element.conductorId === a["data-conductor-id"],
    );
    const circles = g.node.children.filter((n) => n.name === "circle");
    if (circles.length !== ends.length)
      throw Error("Native cable endpoint marker inventory mismatch");
    for (const [index, circle] of circles.entries()) {
      const terminal = required(
        ends[index],
        "Missing native cable endpoint",
      ).terminal;
      keys.set(
        circle,
        JSON.stringify([terminal.deviceUid, terminal.terminalKey]),
      );
    }
  }
}
