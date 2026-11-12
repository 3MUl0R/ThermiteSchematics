// SVG commands are emitted to 0.001 mm/layout unit; Chromium adds float noise.
// This is a numerical allowance, never a permitted visible gap.
export const ENDPOINT_LANDING_TOLERANCE_MM = 0.01;
export function endpointLandingFindings(g) {
  return [...g.shapes, ...(g.relationLandings ?? [])].flatMap((s) => [
    ...(s.conductor &&
    (!Array.isArray(s.endpoints) ||
      !s.endpoints.some(
        (p) =>
          typeof p?.deviceUid === "string" &&
          p.deviceUid.length > 0 &&
          typeof p?.terminalKey === "string" &&
          p.terminalKey.length > 0,
      ))
      ? [
          {
            kind: "endpoint-landing-ownership-unavailable",
            element: s.element,
            designation: s.designation ?? s.wire ?? "conductor",
            ...(s.bbox ? { bbox: s.bbox } : { sheetLevel: true }),
            reason: "missing-physical-endpoint-exports",
            toleranceMm: ENDPOINT_LANDING_TOLERANCE_MM,
          },
        ]
      : []),
    ...(s.ownedLandings ?? []).flatMap((landing) => {
      const offsetMm =
        landing.anchor &&
        Math.hypot(
          landing.endpoint.x - landing.anchor.x,
          landing.endpoint.y - landing.anchor.y,
        );
      if (
        Number.isFinite(offsetMm) &&
        offsetMm <= ENDPOINT_LANDING_TOLERANCE_MM
      )
        return [];
      return [
        {
          kind: landing.reason
            ? "endpoint-landing-ownership-unavailable"
            : "endpoint-off-owned-anchor",
          element: s.element,
          designation:
            s.designation ?? s.wire ?? landing.deviceUid ?? "conductor",
          ...(s.bbox ? { bbox: s.bbox } : { sheetLevel: true }),
          end: landing.end,
          terminal: landing.terminal,
          deviceUid: landing.deviceUid,
          reason: landing.reason,
          offsetMm,
          toleranceMm: ENDPOINT_LANDING_TOLERANCE_MM,
        },
      ];
    }),
  ]);
}
