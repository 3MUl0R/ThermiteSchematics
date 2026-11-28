import { UNSELECTED_ATTACHMENT_STROKE_MM } from "./attachment-stroke.js";

type Point = readonly [number, number];
const n = (v: number) => String(Number(v.toFixed(3)));

export const ATTACHMENT_LABEL_CLEARANCE_MM = 0.85;
export const ATTACHMENT_JOG_STAGGER_MM = 1.6;
export const ATTACHMENT_MIN_JOG_STAGGER_MM = 1.2;

export type AttachmentLabelClearance = {
  readonly northBottom?: number;
  readonly southTop?: number;
  readonly lateralCrossTop?: number;
  readonly westRight?: number;
  readonly eastLeft?: number;
  readonly northLevel?: number;
  readonly northLevels?: number;
  readonly southLevel?: number;
  readonly southLevels?: number;
  readonly crossLevel?: number;
  readonly lateralSideLevel?: number;
};

function verticalAttachmentJogY(
  side: string,
  height: number,
  targetY: number | undefined,
  clearance?: AttachmentLabelClearance,
): number {
  if (side === "NORTH") {
    const base = Math.max(
      1,
      (clearance?.northBottom ?? 6.6) + ATTACHMENT_LABEL_CLEARANCE_MM,
    );
    const limit = targetY !== undefined ? Math.max(1, targetY - 1) : height - 1;
    const levels = clearance?.northLevels ?? 1;
    const level = clearance?.northLevel ?? 0;
    if (levels <= 1) return Math.min(base, limit);
    const step = Math.min(
      ATTACHMENT_JOG_STAGGER_MM,
      Math.max(
        ATTACHMENT_MIN_JOG_STAGGER_MM,
        Math.max(0, limit - base) / (levels - 1),
      ),
    );
    return Math.min(limit, base + level * step);
  }
  const base = Math.min(
    height - 1,
    (clearance?.southTop ?? height - 3.4) - ATTACHMENT_LABEL_CLEARANCE_MM,
  );
  const limit = targetY !== undefined ? Math.min(height - 1, targetY + 1) : 1;
  const levels = clearance?.southLevels ?? 1;
  const level = clearance?.southLevel ?? 0;
  if (levels <= 1) return Math.max(base, limit);
  const step = Math.min(
    ATTACHMENT_JOG_STAGGER_MM,
    Math.max(
      ATTACHMENT_MIN_JOG_STAGGER_MM,
      Math.max(0, base - limit) / (levels - 1),
    ),
  );
  return Math.max(limit, base - level * step);
}

function lateralAttachmentPoints(
  from: { x: number; y: number; side: string },
  to: { x: number; y: number },
  targetSide: string,
  width: number,
  height: number,
  labelClearance?: AttachmentLabelClearance,
): Point[] {
  const baseFromEdge = from.side === "WEST" ? 1 : width - 1,
    targetEdge = targetSide === "WEST" ? 1 : width - 1;
  if (from.side === targetSide) {
    const sideLevel = labelClearance?.lateralSideLevel ?? 0;
    let fromEdge = baseFromEdge;
    if (Math.abs(from.y - to.y) >= 1e-7 && sideLevel > 0) {
      const extra = (sideLevel - 1) * ATTACHMENT_JOG_STAGGER_MM;
      fromEdge =
        from.side === "WEST"
          ? Math.min(
              to.x - 1,
              (labelClearance?.westRight ?? 1) +
                ATTACHMENT_LABEL_CLEARANCE_MM +
                extra,
            )
          : Math.max(
              to.x + 1,
              (labelClearance?.eastLeft ?? width - 1) -
                ATTACHMENT_LABEL_CLEARANCE_MM -
                extra,
            );
    }
    return [
      [from.x, from.y],
      [fromEdge, from.y],
      [fromEdge, to.y],
      [to.x, to.y],
    ];
  }
  const baseCrossY =
    labelClearance?.lateralCrossTop !== undefined
      ? Math.min(
          4.5,
          Math.max(
            1,
            labelClearance.lateralCrossTop - ATTACHMENT_LABEL_CLEARANCE_MM,
          ),
        )
      : 4.5;
  const crossLevel = labelClearance?.crossLevel ?? 0;
  const crossY =
    crossLevel === 0
      ? baseCrossY
      : baseCrossY - crossLevel * ATTACHMENT_MIN_JOG_STAGGER_MM >= 0.8
        ? baseCrossY - crossLevel * ATTACHMENT_MIN_JOG_STAGGER_MM
        : Math.max(
            1,
            height - 1 - (crossLevel - 1) * ATTACHMENT_MIN_JOG_STAGGER_MM,
          );
  return [
    [from.x, from.y],
    [baseFromEdge, from.y],
    [baseFromEdge, crossY],
    [targetEdge, crossY],
    [targetEdge, to.y],
    [to.x, to.y],
  ];
}

/** Local catalog attachment for a function terminal, including a reused physical common. */
export function circuitAttachmentPoints(
  from: { x: number; y: number; side: string },
  to: { x: number; y: number },
  targetSide: string,
  width: number,
  height: number,
  labelClearance?: AttachmentLabelClearance,
): Point[] {
  if (targetSide === "WEST" || targetSide === "EAST")
    return lateralAttachmentPoints(
      from,
      to,
      targetSide,
      width,
      height,
      labelClearance,
    );
  const fromEdge = from.side === "NORTH" ? 1 : height - 1;
  if (from.side === targetSide) {
    if (Math.abs(from.x - to.x) < 1e-7)
      return [
        [from.x, from.y],
        [from.x, fromEdge],
        [to.x, fromEdge],
        [to.x, to.y],
      ];
    const jogY = verticalAttachmentJogY(
      from.side,
      height,
      to.y,
      labelClearance,
    );
    return [
      [from.x, from.y],
      [from.x, jogY],
      [to.x, jogY],
      [to.x, to.y],
    ];
  }
  const fromJogY = verticalAttachmentJogY(
    from.side,
    height,
    undefined,
    labelClearance,
  );
  const targetJogY = verticalAttachmentJogY(
    targetSide,
    height,
    to.y,
    labelClearance,
  );
  const bridgeX = Math.max(
    1,
    width - 1 - (labelClearance?.crossLevel ?? 0) * ATTACHMENT_JOG_STAGGER_MM,
  );
  return [
    [from.x, from.y],
    [from.x, fromJogY],
    [bridgeX, fromJogY],
    [bridgeX, targetJogY],
    [to.x, targetJogY],
    [to.x, to.y],
  ];
}

export function circuitAttachmentPathData(points: readonly Point[]): string {
  return points
    .map((p, i) => `${i ? "L" : "M"} ${n(p[0])} ${n(p[1])}`)
    .join(" ");
}

export function circuitAttachmentHalo(path: string): string {
  return `<path d="${path}" fill="none" stroke="white" stroke-width=".8"/>`;
}

export function circuitAttachmentLead(
  path: string,
  stroke = UNSELECTED_ATTACHMENT_STROKE_MM,
): string {
  return `<path data-electrical-role="terminal-lead" d="${path}" fill="none" stroke="#17212b" stroke-width="${n(stroke)}"/>`;
}

export function circuitAttachment(
  from: { x: number; y: number; side: string },
  to: { x: number; y: number },
  side: string,
  width: number,
  height: number,
  stroke = UNSELECTED_ATTACHMENT_STROKE_MM,
  labelClearance?: AttachmentLabelClearance,
): string {
  const path = circuitAttachmentPathData(
    circuitAttachmentPoints(from, to, side, width, height, labelClearance),
  );
  return `${circuitAttachmentHalo(path)}${circuitAttachmentLead(path, stroke)}`;
}
