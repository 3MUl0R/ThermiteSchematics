import { painted } from "./review-geometry.mjs";

const ROUTE_TAGS = new Set(["path", "line", "polyline"]);
const MIN_VISIBLE_ALPHA = 0.2;

function segmentsLength(runs) {
  if (!Array.isArray(runs)) return 0;
  let total = 0;
  for (const [a, b] of runs) {
    if (!a || !b) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

function polylineLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
  return total;
}

function parseHexRgba(raw) {
  const hex = raw.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a = "f"] = [...hex].map((ch) => parseInt(ch + ch, 16));
    return [r, g, b, a / 255];
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  return null;
}

function parseRgbRgba(raw) {
  const m = raw.match(
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/u,
  );
  if (!m) return null;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  let a = 1;
  if (m[4] !== undefined) {
    a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  }
  return [r, g, b, a];
}

export function isVisibleStrokeColour(colour) {
  if (typeof colour !== "string") return false;
  const raw = colour.trim().toLowerCase();
  if (!raw || raw === "none" || raw === "transparent" || raw === "white")
    return false;
  const rgba = raw.startsWith("#") ? parseHexRgba(raw) : parseRgbRgba(raw);
  if (!rgba) return true;
  const [r, g, b, a] = rgba;
  if (!Number.isFinite(a) || a < MIN_VISIBLE_ALPHA) return false;
  return !(r === 255 && g === 255 && b === 255);
}

export function hasVisibleConductorInk(s, g) {
  if (!s || !ROUTE_TAGS.has(s.shapeTag)) return false;
  if (!(Number.isFinite(s.stroke) && s.stroke > 0)) return false;
  if (s.nativeBodyPainted === false || !painted(s)) return false;
  if (s.strokePainted === false) return false;
  if (s.strokeAlpha !== undefined && !(s.strokeAlpha >= MIN_VISIBLE_ALPHA))
    return false;
  if (s.strokeColour !== undefined && !isVisibleStrokeColour(s.strokeColour))
    return false;
  const t3 = g?.tranche3;
  if (t3?.routeStrokePaint) {
    const paint = t3.routeStrokePaint[s.element];
    if (!paint?.painted) return false;
  }
  if (t3?.routeInk) return segmentsLength(t3.routeInk[s.element]) > 0;
  if (s.strokeColour === undefined) return false;
  return polylineLength(s.points) > 0;
}
