// Table rules and backgrounds have separate cell measurements. Avoid
// flattening ink that no checker consumes on long report packets.
export function sheetShapeCandidate({
  e,
  id,
  conductor,
  lead,
  outline,
  symbol,
  mark,
  cls,
  hasRepeatLabels,
}) {
  return (
    conductor ||
    lead ||
    id.primitiveRole ||
    id.qualifier ||
    id.attachment ||
    id.attachmentCandidate ||
    id.loopConductor ||
    id.loopCandidate ||
    outline ||
    symbol ||
    mark ||
    id.terminal ||
    id.glyphBody ||
    hasRepeatLabels ||
    id.navigationAnnotation ||
    id.mechanicalAssociation ||
    cls.includes("junction-dot") ||
    e.hasAttribute("data-wiring-junction")
  );
}

export function faceSegments(
  c,
  { e, id, outline, symbol, mark },
  functionInterface,
  css,
  clip,
  matrix,
) {
  if (outline || id.terminal || id.qualifier || css.strokeDasharray !== "none")
    return undefined;
  const interfaceMark =
    mark &&
    c.elementsById
      .get(id.symbolGroup)
      ?.querySelector("[data-function-interface]");
  return functionInterface || mark === "motor" || symbol || interfaceMark
    ? c.strokeInk(e, clip, matrix, true)
    : undefined;
}

export function sheetWithClearanceGeometry(c, shapes) {
  const { h } = c;
  const frameAudit = c.options.textOnly ? null : h.measureNetLabelFrames(c);
  const trunks = c.options.textOnly ? null : h.sourceTrunkFields(c);
  return {
    ...h.trancheSheetFields(c),
    ...h.layoutRegionFields(c),
    ...h.potentialRailFields(c),
    circuitCaptionFallbacks: h.circuitCaptionFallbacks(c),
    ...(c.options.textOnly
      ? {}
      : {
          faceOutlines: shapes.filter((s) => s.faceOnly),
          ...h.collectCircuitInk(c),
          cableCaptionMarks: h.cableCaptionMarks(c),
          terminalLabelClearances: h.terminalLabelClearances(
            c,
            h.terminalLabelClearanceMm,
          ),
          circuitCaptionClearances: h.circuitCaptionClearances(
            c,
            h.terminalLabelClearanceMm,
          ),
          netLabelFrameOverlaps: frameAudit.overlaps,
          ...(frameAudit.gaps.length
            ? { netLabelFrameGaps: frameAudit.gaps }
            : {}),
          netLabelSourceFrames: h.netLabelSourceFrames(c, shapes, trunks),
          ...trunks,
          collapsedCableAssemblies: h.collapsedCableAssemblies(c),
          outsideRouteScopes: h.outsideRouteScopes(c),
          terminalOutsideBodies: h.terminalOutsideBodies(c),
        }),
  };
}
