import {
  cableEndpointOwnership,
  cableTerminations,
} from "./cable-endpoint-ownership.js";
import { cableRowLabels } from "./cable-row.js";
import { cableRowPlan } from "./cable-row-plan.js";
import { required } from "../presentation/util.js";
import type {
  CompiledProjectPresentation,
  ElectricalIr,
} from "@thermite/compiler";
import { buildCableSchedule, createQueryEngine } from "@thermite/query";

import {
  escapeXmlAttribute as attr,
  preflightTitleRenderText,
} from "../svg/escape.js";
import { prepareSchematicTitleContext } from "../title-block.js";
import type { RenderOutcome, SchematicViewRequest } from "../types.js";
import { normalizeSchematicView } from "../view-spec.js";

import type { Draft, PaperPage, SheetReference } from "./types.js";
import { failure } from "./errors.js";
import { bounds } from "./page.js";
import { n, text, line } from "./svg.js";
import {
  cableEndpointCards,
  cableCardContext,
  cableRowHeight,
} from "./cable-annotations.js";
import { offViewCardSvg } from "../off-view/svg.js";

export async function cableDrafts(
  ir: Readonly<ElectricalIr>,
  request: SchematicViewRequest,
  presentation: CompiledProjectPresentation | undefined,
  page: PaperPage,
): Promise<RenderOutcome<Draft[]>> {
  const normalized = normalizeSchematicView(ir, request);
  if (!normalized.ok) return normalized;
  const view = normalized.value.view;
  if (view.format !== "schematic-view/0.2" || view.intent !== "conductors")
    throw new Error("Expected a cable view.");
  const queried = createQueryEngine(ir).cable(request.root);
  if (!queried.ok) return queried;
  const schedule = buildCableSchedule(ir, view.root.cableUid);
  const preparedTitle = prepareSchematicTitleContext(
    ir.project.name,
    view,
    presentation,
  );
  if (!preparedTitle.ok) return preparedTitle;
  const title = preparedTitle.value,
    b = bounds(title, page, view);
  const sources = cableLabelSources(schedule);
  const preflight = preflightTitleRenderText(
    view,
    sources.map((value) => ({
      ownerKind: "cable",
      ownerId: schedule.cableUid,
      field: "title.authored-line",
      value,
    })),
  );
  if (!preflight.ok) return preflight;
  const left = b.x,
    right = b.x + b.w,
    jacketL = left + b.w * 0.35,
    jacketR = right - b.w * 0.35;
  const maxEnd = Math.floor((jacketL - left - 8) / 1.55);
  const annotations = cableEndpointCards(
    ir,
    schedule,
    view,
    jacketL - left - 8,
  );
  if (!annotations.ok) return annotations;
  if (maxEnd < 12 || sources.some((value) => [...value].length > 160))
    return failure(
      "unprintable-layout",
      "Cable labels exceed the supported print width. Shorten labels or use a larger page.",
    );
  const drafts: Draft[] = [];
  let content: string[] = [],
    refs: SheetReference[] = [],
    y = b.y,
    first = 0;
  function header() {
    refs = [];
    content = [
      text(left, b.y + 4, `CABLE ${schedule.designation}`, 4, "start", 700),
      text(left, b.y + 10, schedule.typeId, 2.6),
      text(
        left,
        b.y + 16,
        `${schedule.counts.total} cores / ${schedule.counts.spare} spare / ${schedule.counts.unassigned} unassigned`,
        2.6,
      ),
    ];
    const a = schedule.fromLocation ?? "END A",
      z = schedule.toLocation ?? "END B";
    if (
      a.length > maxEnd ||
      z.length > maxEnd ||
      schedule.typeId.length * 1.5 > b.w
    )
      return false;
    content.push(
      text(left, b.y + 25, a, 3, "start", 700),
      text(right, b.y + 25, z, 3, "end", 700),
    );
    y = b.y + 33;
    return true;
  }
  function finish(last: number) {
    const jacket = `<rect x="${n(jacketL)}" y="${n(b.y + 29)}" width="${n(jacketR - jacketL)}" height="${n(y - b.y - 24)}" rx="3" fill="none" stroke="#667085" stroke-width="0.45" stroke-dasharray="2 1"/>`;
    content.push(
      jacket,
      text(
        left,
        y + 13,
        "Solid: assigned   Dashed: spare   X: unterminated   ?: unassigned",
        2.5,
      ),
      text(
        left,
        y + 18,
        schedule.shield === true
          ? "Shielded construction; shield terminations are not specified by this view."
          : "Shield termination is not inferred from cable construction.",
        2.5,
      ),
    );
    drafts.push({
      view,
      title,
      content: content.join("\n"),
      links: [],
      references: refs,
      note: `Core inventory ${first + 1}-${last} of ${schedule.cores.length}. ${schedule.endOrder === "canonical" ? "Legacy endpoints shown in canonical order." : "End A/B follows authored endpoint order."}`,
    });
  }
  if (!header())
    return failure(
      "unprintable-layout",
      "Cable cabinet or type labels are too long for this page.",
    );
  for (let i = 0; i < schedule.cores.length; i++) {
    const core = schedule.cores[i]!;
    const planned = cableRowPlan(core, schedule.designation, {
      left,
      right,
      jacketL,
      jacketR,
    });
    if (!planned.ok) return planned;
    const { a, z, centerRows, usage, midOffset, extraHeight } = planned.value;
    const cards = required(
      annotations.value[i],
      "Missing cable endpoint cards",
    );
    const height = cableRowHeight(cards, [a, z, centerRows], extraHeight);
    if (y + height + 24 > b.y + b.h) {
      if (i === first)
        return failure(
          "unprintable-layout",
          `A cable core row cannot fit on this page. ${cableCardContext(cards)}. Use a larger page or change flow.`,
        );
      finish(i);
      first = i;
      header();
    }
    const midY = y + midOffset;
    const dashed = core.usage === "spare" || core.status === "unassigned";
    content.push(
      `<g data-cable-uid="${attr(schedule.cableUid)}" data-conductor-id="${attr(core.id)}" data-usage="${core.usage}" data-status="${core.status}">`,
      line(
        left + 1,
        midY,
        right - 1,
        midY,
        dashed ? 'stroke-dasharray="2 1"' : "",
      ),
    );
    const rowLabels = cableRowLabels(a, z, centerRows, usage, {
      left,
      right,
      y,
      midY,
    });
    cableEndpointOwnership(
      rowLabels,
      core,
      schedule.cableUid,
      a.length,
      z.length,
    );
    content.push(...rowLabels);
    const terminations = cableTerminations(ir, core, b, left, right, midY);
    refs.push(...terminations.references);
    content.push(...terminations.content);
    cards.forEach((card, index) => {
      if (card)
        content.push(
          offViewCardSvg(
            card,
            index === 0 ? left + 2 : right - card.width * 0.25 - 2,
            midY + 5 + usage.extraHeight,
            0.25,
          ),
        );
    });
    content.push("</g>");
    y += height;
  }
  finish(schedule.cores.length);
  return { ok: true, value: drafts };
}

function cableLabelSources(
  schedule: ReturnType<typeof buildCableSchedule>,
): string[] {
  return schedule.cores
    .flatMap((core) => [
      core.id,
      core.color,
      core.size ?? "",
      ...core.endpoints.flatMap((end) =>
        end === null ? [] : [end.display, end.location ?? ""],
      ),
    ])
    .concat(
      schedule.fromLocation ?? "",
      schedule.toLocation ?? "",
      schedule.typeId,
    );
}
