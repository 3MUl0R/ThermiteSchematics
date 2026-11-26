import type { CircuitRouteState } from "./layout-routes.js";
import { circuitLandingGeometry, circuitLandingPort } from "./landing-ports.js";
import { escapeXmlAttribute as attr } from "../svg/escape.js";
import { required } from "../presentation/util.js";

/** Non-painted layout-site metadata, as for wiring incidence ports. These are
 * points within the unchanged native terminal mark, not extra terminal graphics. */
export function circuitLandingAnchors(state: CircuitRouteState) {
  return (state.graph.children ?? [])
    .flatMap((node) =>
      (node.ports ?? [])
        .filter((p) => circuitLandingPort(p.id).offset !== 0)
        .map((p) => {
          const geom = circuitLandingGeometry(p.id, state.nodes);
          const pt = state.suppressedStemPorts.has(geom.physicalPortId)
            ? geom.offsetPaintedLanding
            : geom.outerRoutePort;
          const cx = required(node.x, "Unplaced circuit landing") + pt.x;
          const cy = required(node.y, "Unplaced circuit landing") + pt.y;
          return `<g data-device-uid="${attr(geom.pin.terminal.deviceUid)}"><circle data-layout-port="${attr(p.id)}" data-circuit-landing-for="${attr(geom.pin.id)}" data-terminal-key="${attr(geom.pin.terminal.terminalKey)}" cx="${state.n(cx)}" cy="${state.n(cy)}" r=".001" fill="none" stroke="none"/></g>`;
        }),
    )
    .join("");
}
