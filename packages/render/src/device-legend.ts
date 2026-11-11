import {
  legendFreeRegions,
  legendFitDiagnostic,
} from "./device-legend/failure.js";
import { printableTextMetrics } from "./symbols/printable-font.js";
import { required } from "./presentation/util.js";
import type { ElectricalIr } from "@thermite/compiler";
import {
  planDeviceTag,
  deviceTagFields,
  type DeviceTagPlan,
} from "./device-tags.js";
import { preflightDeviceTagSources } from "./svg/escape.js";
import type { NormalizedSchematicView, RenderOutcome } from "./types.js";
import { generatedSvgInk } from "./device-legend/svg-ink.js";
import { placeLegend, legendColumns } from "./device-legend/placement.js";
import { legendSvg } from "./device-legend/emission.js";
import type { Rect } from "./device-legend/geometry.js";
export { generatedSvgInk } from "./device-legend/svg-ink.js";
export function rootedLegendView(view: {
  format: string;
  family?: string;
  intent?: string;
}) {
  return (
    view.format.startsWith("schematic-view/") &&
    ["power", "control"].includes(view.family ?? "") &&
    view.intent !== "conductors"
  );
}
/** Final sheet only: no ELK geometry, electrical appearance, net or reference changes. */
export function addDeviceLegend(
  ir: Readonly<ElectricalIr>,
  svg: string,
  area: Rect,
  scale = 1,
  continuous = false,
  view?: NormalizedSchematicView,
): RenderOutcome<string> {
  const measured = generatedSvgInk(svg, scale),
    uids = [...measured.bodies.keys()];
  if (!uids.length) return { ok: true, value: svg };
  uids.sort((a, b) => {
    const x = required(measured.bodies.get(a), "Missing legend geometry"),
      y = required(measured.bodies.get(b), "Missing legend geometry");
    return x.y - y.y || x.x - y.x || (a < b ? -1 : a > b ? 1 : 0);
  });
  const plans = plannedTags(ir, measured, uids, area, view);
  if (!plans.ok) return plans;
  const tags = plans.value,
    variants = [tags];
  let layout = placeLegend(tags, area, measured.ink, measured.regions);
  // 50 mm is a cap. Legal rewrapping can fit an existing narrower free lane;
  // these bounded font plans add no electrical/layout/routing search attempts.
  for (const width of [46, 42, 38, 34]) {
    if (layout) break;
    const wrapped = plannedTags(ir, measured, uids, area, view, width);
    if (wrapped.ok) {
      variants.push(wrapped.value);
      layout = placeLegend(wrapped.value, area, measured.ink, measured.regions);
    }
  }
  if (!layout && continuous) {
    const block = legendColumns(tags, 1);
    layout = {
      ...block,
      box: {
        x: area.x + area.w + 4,
        y: area.y,
        w: block.box.w,
        h: block.box.h,
      },
    };
  }
  if (!layout) {
    const free = legendFreeRegions(area, [
      ...measured.ink,
      ...measured.regions,
    ]);
    for (const region of free)
      for (const variant of variants)
        layout ??= placeLegend(variant, region, measured.ink, measured.regions);
    if (!layout)
      return unfitLegend(
        variants,
        required(free[0], "Missing free-region trial"),
      );
  }
  let result = svg.replace(
    /<\/svg>(\s*)$/,
    (_, tail: string) => legendSvg(layout, scale) + "</svg>" + tail,
  );
  if (continuous)
    result = expandContinuousCanvas(
      result,
      Math.max(area.x + area.w, layout.box.x + layout.box.w + 4) / scale,
      Math.max(area.y + area.h, layout.box.y + layout.box.h + 4) / scale,
    );
  return { ok: true, value: result };
}
function expandContinuousCanvas(svg: string, width: number, height: number) {
  return svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/viewBox="[^"]*"/, `viewBox="0 0 ${width} ${height}"`)
      .replace(/\bwidth="[^"]*"/, `width="${width}"`)
      .replace(/\bheight="[^"]*"/, `height="${height}"`),
  );
}
function legendFailure(
  device: string,
  field: string,
  width: number,
  height: number,
  area: Rect,
): RenderOutcome<never> {
  return {
    ok: false,
    error: {
      code: "R006",
      root: device,
      reason: "unprintable-layout",
      message: `Device ${device} legend field ${field} cannot be placed: complete legend requires ${width.toFixed(2)} × ${height.toFixed(2)} mm; available free region (largest tried) is ${area.w.toFixed(2)} × ${area.h.toFixed(2)} mm after 3 mm ink clearance. Use larger paper, another flow, or split the view.`,
      details: {
        device,
        field,
        requiredWidthMm: width,
        requiredHeightMm: height,
        availableWidthMm: area.w,
        availableHeightMm: area.h,
        clearanceMm: 3,
        capacityKind: "free-region",
        availableRegion: area,
      },
    },
  };
}

function plannedTags(
  ir: Readonly<ElectricalIr>,
  measured: import("./device-legend/svg-ink.js").SvgInk,
  uids: readonly string[],
  area: Rect,
  view?: NormalizedSchematicView,
  width = 50,
): RenderOutcome<DeviceTagPlan[]> {
  const tags: DeviceTagPlan[] = [];
  for (const uid of uids) {
    const device = required(
        ir.devices.find((d) => d.uid === uid),
        "Missing legend geometry",
      ),
      type = required(
        ir.deviceTypes.find((t) => t.id === device.typeId),
        "Missing legend geometry",
      );
    if (!measured.keys.get(uid)?.includes(device.designation))
      return legendFailure(
        device.designation,
        "designation key",
        50,
        2.7,
        area,
      );
    const fields = deviceTagFields(device, type);
    if (view) {
      const valid = preflightDeviceTagSources(
        view,
        fields.map((f) => f.source),
      );
      if (!valid.ok) return valid;
    }
    const plan = planDeviceTag(device, type, width);
    if (!plan.ok)
      return columnFailure(device.designation, fields, plan.error, area);
    tags.push(plan.value);
  }
  return { ok: true as const, value: tags };
}

function unfitLegend(
  variants: readonly (readonly DeviceTagPlan[])[],
  available: Rect,
): RenderOutcome<never> {
  const failure = required(
    variants
      .map((tags) => legendFitDiagnostic(tags, available))
      .sort(
        (a, b) =>
          Math.max(
            a.layout.box.w / Math.max(0.001, available.w),
            a.layout.box.h / Math.max(0.001, available.h),
          ) -
          Math.max(
            b.layout.box.w / Math.max(0.001, available.w),
            b.layout.box.h / Math.max(0.001, available.h),
          ),
      )[0],
    "Missing legend constraint",
  );
  const device = required(
    failure.tag.fields.find((f) => f.field === "designation"),
    "Missing legend designation",
  ).value;
  return legendFailure(
    device,
    failure.field,
    failure.layout.box.w,
    failure.layout.box.h,
    available,
  );
}

export function addContinuousLegend(
  ir: Readonly<ElectricalIr>,
  svg: string,
  view: NormalizedSchematicView,
): RenderOutcome<string> {
  if (!rootedLegendView(view)) return { ok: true, value: svg };
  const box = required(
    /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg) ?? undefined,
    "Missing continuous canvas",
  );
  return addDeviceLegend(
    ir,
    svg,
    { x: 0, y: 0, w: Number(box[1]) * 0.25, h: Number(box[2]) * 0.25 },
    0.25,
    true,
    view,
  );
}

function columnFailure(
  device: string,
  fields: ReturnType<typeof deviceTagFields>,
  error: import("./types.js").RenderFailure,
  area: Rect,
): RenderOutcome<never> {
  const details = "details" in error ? error.details : undefined;
  if (
    typeof details?.requiredMm !== "number" ||
    typeof details.field !== "string"
  )
    return { ok: false, error };
  const field = required(
      fields.find((f) => f.field === details.field),
      "Missing failing tag field",
    ),
    m = printableTextMetrics(
      field.value,
      field.field === "designation" ? 2.7 : 2.5,
      field.field === "designation",
      true,
    ),
    height = m.top - m.bottom + 3;
  const result = legendFailure(
    device,
    details.field,
    details.requiredMm + 6,
    height,
    { ...area, w: 50 },
  );
  if (result.ok || result.error.code !== "R006") return result;
  return {
    ...result,
    error: {
      ...result.error,
      details: { ...result.error.details, capacityKind: "column" },
      message: `Device ${device} legend field ${details.field} needs ${(details.requiredMm + 6).toFixed(2)} × ${height.toFixed(2)} mm; available column 50.00 × ${area.h.toFixed(2)} mm. Use a shorter authored designation or a wider approved column.`,
    },
  };
}
