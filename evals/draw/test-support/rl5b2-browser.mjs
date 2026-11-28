import { drawingContextOptions } from "../browser.mjs";
import { catalogRoleObservation } from "../catalog-roles.mjs";

export const MOTOR_AUDIT_FUNCTIONS = [
  ["K1", "coil"],
  ["K1", "aux13"],
  ["PB1", "contact11"],
  ["OL1", "aux95"],
  ["CB1", "pole1"],
  ["CB1", "pole2"],
  ["CB1", "pole3"],
  ["M1", "motor_load"],
].map(([value, key]) => ({
  device: { by: "designation", value },
  key,
}));

export function singleGroupReq(title, id, label, functions) {
  return {
    format: "schematic-packet-request/0.1",
    index: false,
    page: { size: "tabloid", orientation: "landscape", marginMm: 10 },
    views: [
      {
        format: "circuit-view-request/0.1",
        title,
        flow: "left-to-right",
        groups: [{ id, label, functions, conductors: [] }],
      },
    ],
  };
}

export const uidByDesignation = (ir) =>
  Object.fromEntries(ir.devices.map((d) => [d.designation, d.uid]));

export function runCatalogRoleObs(id, g, ir, sheet) {
  return catalogRoleObservation({ id }, sheet, g, ir, (dq, issues, extra) => ({
    dq,
    status: issues.length ? "fail" : (extra.status ?? "pass"),
    ...extra,
  }));
}

export function obsDiagnostic(obs, label = "") {
  const payload = JSON.stringify({
    status: obs?.status,
    findings: obs?.evidence?.findings ?? [],
    notMeasured: obs?.evidence?.notMeasured ?? [],
  });
  return label ? `${label}: ${payload}` : payload;
}

export function createPageRunner(getBrowser) {
  const activeContexts = new Set();
  async function withPage(fn) {
    const context = await getBrowser().newContext(drawingContextOptions);
    activeContexts.add(context);
    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      activeContexts.delete(context);
      await context.close().catch(() => {});
    }
  }
  async function closeActiveContexts() {
    const pending = [...activeContexts];
    activeContexts.clear();
    await Promise.all(pending.map((ctx) => ctx.close().catch(() => {})));
  }
  return { withPage, closeActiveContexts };
}
