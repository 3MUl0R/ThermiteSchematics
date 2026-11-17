import {
  nativePowerTopology,
  rootedProtectionNeeds,
  RootedTopologyUnavailable,
} from "./element-native-topology.mjs";
import { viewBindings, inView } from "./tranche4-views.mjs";
import { finding } from "./review-geometry.mjs";
export function rootedElementGaps(
  packet,
  geometries,
  ir,
  request,
  appearances,
) {
  const findings = [],
    failures = [],
    bindings = viewBindings(request, ir);
  for (const [view, v] of request.views.entries()) {
    if (v.family !== "power" || !v.root) continue;
    const roots = ir.devices.filter((d) =>
      v.root.by === "uid"
        ? d.uid === v.root.value
        : d.designation === v.root.value,
    );
    const issued = packet.sheets.map((s, i) => ({ s, i }));
    let sheets = issued.filter(({ i }) =>
      inView(geometries[i], bindings[view]),
    );
    const rootRequests = request.views.filter(
      (q) =>
        q.family === "power" &&
        q.root &&
        roots.length === 1 &&
        (q.root.by === "uid"
          ? q.root.value === roots[0].uid
          : q.root.value === roots[0].designation),
    );
    if (!sheets.length && rootRequests.length === 1)
      sheets = issued.filter(
        ({ s }) =>
          s.view?.family === "power" &&
          roots.length === 1 &&
          s.view.root?.deviceUid === roots[0].uid,
      );
    const fail = (reason, extra = {}) =>
      failures.push({
        ...finding(
          "element-navigation-rooted-topology-unavailable",
          {},
          { reason, view, root: v.root, ...extra },
        ),
        sheet: sheets[0]?.s.number ?? packet.sheets[0]?.number,
      });
    try {
      if (roots.length !== 1 || !sheets.length)
        throw new RootedTopologyUnavailable(
          "Rooted request or issued view unavailable",
        );
      const topology = nativePowerTopology(ir);
      for (const need of rootedProtectionNeeds(ir, roots[0], topology)) {
        const { fn, ...witness } = need;
        if (
          appearances.some(
            (a) =>
              a.uid === fn.id.deviceUid &&
              a.functionKey === fn.id.functionKey &&
              (a.view === view || sheets.some((s) => s.i === a.geometryIndex)),
          )
        )
          continue;
        const d = ir.devices.find((d) => d.uid === fn.id.deviceUid),
          evidence = {
            view,
            root: v.root,
            deviceUid: fn.id.deviceUid,
            sourceFunction: fn.id.functionKey,
            nativeSource: fn.source,
            nativeWitness: witness,
            locator: {
              requestView: view,
              function: fn.id,
              issuedSheets: sheets.map((s) => s.s.number),
            },
          };
        if (!need.mandatory) {
          fail(
            "Native topology does not determine the selected branch",
            evidence,
          );
          continue;
        }
        findings.push({
          ...finding(
            "native-rooted-element-appearance-missing",
            {
              element: `native-function/${fn.id.deviceUid}/${fn.id.functionKey}`,
              designation: `${d.designation}.${fn.id.functionKey}`,
            },
            evidence,
          ),
          sheet: sheets[0].s.number,
        });
      }
    } catch (error) {
      if (!(error instanceof RootedTopologyUnavailable)) throw error;
      fail(error.message);
    }
  }
  return { findings, failures };
}
