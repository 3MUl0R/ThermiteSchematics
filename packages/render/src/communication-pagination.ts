import type { ElectricalIr } from "@thermite/compiler";
import { buildCommunicationInventory } from "@thermite/query";
import { CircuitRenderError } from "./render-error-context.js";
import type {
  CommunicationDrawing,
  CommunicationViewRequest,
} from "./communication.js";

export interface CommunicationLayoutProfile {
  readonly preferredWidth: number;
  readonly layerGap: number;
  readonly clampPortKeys?: boolean;
  readonly clampCaptions?: boolean;
}

export type CommunicationFitFailureKind =
  "caption-width" | "port-identity-width" | "port-identity-split";

/** Typed fit refusal raised by communication box/text width checks, never layout or source integrity. */
export class CommunicationFitError extends Error {
  readonly kind: CommunicationFitFailureKind;

  constructor(kind: CommunicationFitFailureKind, message: string) {
    super(message);
    this.name = "CommunicationFitError";
    this.kind = kind;
  }
}

export function isCommunicationCompactFitError(error: unknown): boolean {
  if (error instanceof CommunicationFitError) return true;
  if (error instanceof CircuitRenderError)
    return (
      error.error.code === "R006" && error.error.reason === "unprintable-layout"
    );
  return false;
}

export interface CommunicationProjection {
  relations: Set<string>;
  devices: Set<string>;
  part: number;
  total: number;
  appearances: Map<string, number[]>;
}

export const COMPACT_ETHERNET_PROFILE: CommunicationLayoutProfile = {
  preferredWidth: 50,
  layerGap: 12,
  clampPortKeys: true,
  clampCaptions: true,
};

type CommunicationUnit = { relations: string[]; devices: string[] };
type CommunicationCoverage = NonNullable<
  CommunicationDrawing["topologyCoverage"]
>;
type PaginationResult =
  { ok: true; drawings: CommunicationDrawing[] } | { ok: false; error: Error };
type LayoutCommunication = (
  ir: Readonly<ElectricalIr>,
  request: CommunicationViewRequest,
  projection?: CommunicationProjection,
  profile?: CommunicationLayoutProfile,
) => Promise<CommunicationDrawing>;
type CommunicationPartDrawer = (
  items: readonly CommunicationUnit[],
  part: number,
  total: number,
  appearances: Map<string, number[]>,
) => Promise<CommunicationDrawing>;

function communicationUnits(
  ir: Readonly<ElectricalIr>,
  original: CommunicationCoverage,
): CommunicationUnit[] {
  const chosen = new Set(original.relationIds);
  const units: CommunicationUnit[] = buildCommunicationInventory(ir)
    .links.filter((l) => chosen.has(l.uid))
    .map((l) => ({
      relations: [l.uid],
      devices: [l.fromDeviceUid, l.toDeviceUid],
    }));
  const linked = new Set(units.flatMap((u) => u.devices));
  for (const uid of original.deviceUids)
    if (!linked.has(uid)) units.push({ relations: [], devices: [uid] });
  return units;
}

function communicationTrialAppearances(
  units: readonly CommunicationUnit[],
  original: CommunicationCoverage,
  widestPart: number,
) {
  // Reserve a device reference for every other possible part in trials.
  // Actual partitions can only require fewer references.
  return new Map(
    original.deviceUids.map((uid) => [
      uid,
      Array.from(
        {
          length: Math.max(
            0,
            units.filter((u) => u.devices.includes(uid)).length - 1,
          ),
        },
        () => widestPart - 1,
      ),
    ]),
  );
}

function assertCommunicationPageCoverage(
  drawings: readonly CommunicationDrawing[],
  original: CommunicationCoverage,
) {
  const equal = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const coverage = drawings.map((d) => {
    if (!d.topologyCoverage)
      throw new Error("Missing communication pagination coverage.");
    return d.topologyCoverage;
  });
  const portId = (p: { deviceUid: string; portKey: string }) =>
    JSON.stringify([p.deviceUid, p.portKey]);
  if (
    !equal(
      coverage.flatMap((c) => c.relationIds),
      original.relationIds,
    ) ||
    !equal(
      coverage.flatMap((c) => c.ports.map(portId)),
      original.ports.map(portId),
    ) ||
    !equal(
      [...new Set(coverage.flatMap((c) => c.deviceUids))],
      original.deviceUids,
    )
  )
    throw new Error(
      "Communication pagination did not conserve the original selection.",
    );
}

async function renderCommunicationParts(
  parts: readonly (readonly CommunicationUnit[])[],
  original: CommunicationCoverage,
  draw: CommunicationPartDrawer,
  fits: (drawing: CommunicationDrawing) => boolean,
  unfit: (drawing: CommunicationDrawing, message: string) => Error,
): Promise<PaginationResult> {
  const appearances = new Map<string, number[]>();
  parts.forEach((items, i) => {
    for (const uid of new Set(items.flatMap((u) => u.devices)))
      appearances.set(uid, [...(appearances.get(uid) ?? []), i + 1]);
  });
  const drawings: CommunicationDrawing[] = [];
  for (const [i, items] of parts.entries()) {
    const drawing = await draw(items, i + 1, parts.length, appearances);
    if (!fits(drawing))
      return {
        ok: false,
        error: unfit(
          drawing,
          "A communication pagination part exceeds the readable sheet bounds.",
        ),
      };
    drawings.push(drawing);
  }
  assertCommunicationPageCoverage(drawings, original);
  return { ok: true, drawings };
}

const UNFIT_UNIT_MESSAGE =
  "A complete communication link or device and its references cannot fit at readable size; use larger paper or shorter labels.";

function communicationPartDrawer(
  layout: LayoutCommunication,
  ir: Readonly<ElectricalIr>,
  request: CommunicationViewRequest,
  profile?: CommunicationLayoutProfile,
): CommunicationPartDrawer {
  return (items, part, total, appearances) =>
    layout(
      ir,
      request,
      {
        relations: new Set(items.flatMap((u) => u.relations)),
        devices: new Set(items.flatMap((u) => u.devices)),
        part,
        total,
        appearances,
      },
      profile,
    );
}

async function paginateCommunicationUnits(
  layout: LayoutCommunication,
  ir: Readonly<ElectricalIr>,
  request: CommunicationViewRequest,
  units: readonly CommunicationUnit[],
  original: CommunicationCoverage,
  fits: (drawing: CommunicationDrawing) => boolean,
  unfit: (drawing: CommunicationDrawing, message: string) => Error,
  profile?: CommunicationLayoutProfile,
): Promise<PaginationResult> {
  const widestPart = Number("8".repeat(String(units.length).length));
  const trialAppearances = communicationTrialAppearances(
    units,
    original,
    widestPart,
  );
  const draw = communicationPartDrawer(layout, ir, request, profile);
  const parts: CommunicationUnit[][] = [];
  let current: CommunicationUnit[] = [];
  for (const unit of units) {
    const candidate = [...current, unit];
    const trial = await draw(
      candidate,
      widestPart,
      widestPart,
      trialAppearances,
    );
    if (fits(trial)) {
      current = candidate;
      continue;
    }
    if (!current.length)
      return { ok: false, error: unfit(trial, UNFIT_UNIT_MESSAGE) };
    parts.push(current);
    current = [unit];
    const single = await draw(
      current,
      widestPart,
      widestPart,
      trialAppearances,
    );
    if (!fits(single))
      return { ok: false, error: unfit(single, UNFIT_UNIT_MESSAGE) };
  }
  parts.push(current);
  return renderCommunicationParts(parts, original, draw, fits, unfit);
}

async function retryCompactCommunicationPages(
  layout: LayoutCommunication,
  ir: Readonly<ElectricalIr>,
  request: CommunicationViewRequest,
  units: readonly CommunicationUnit[],
  original: CommunicationCoverage,
  fits: (drawing: CommunicationDrawing) => boolean,
  unfit: (drawing: CommunicationDrawing, message: string) => Error,
): Promise<CommunicationDrawing[] | undefined> {
  if (request.medium !== "ethernet") return undefined;
  try {
    const compactFull = await layout(
      ir,
      request,
      undefined,
      COMPACT_ETHERNET_PROFILE,
    );
    if (fits(compactFull)) {
      assertCommunicationPageCoverage([compactFull], original);
      return [compactFull];
    }
    if (units.length < 2) return undefined;
    const attempt = await paginateCommunicationUnits(
      layout,
      ir,
      request,
      units,
      original,
      fits,
      unfit,
      COMPACT_ETHERNET_PROFILE,
    );
    return attempt.ok ? attempt.drawings : undefined;
  } catch (error) {
    if (isCommunicationCompactFitError(error)) return undefined;
    throw error;
  }
}

export async function runCommunicationPagination(
  layout: LayoutCommunication,
  ir: Readonly<ElectricalIr>,
  request: CommunicationViewRequest,
  fits: (drawing: CommunicationDrawing) => boolean,
  unfit: (drawing: CommunicationDrawing, message: string) => Error,
): Promise<CommunicationDrawing[]> {
  // A malformed original layout must fail before attempting smaller parts.
  const full = await layout(ir, request);
  if (fits(full)) return [full];
  const original = full.topologyCoverage;
  if (!original) throw new Error("Missing communication topology coverage.");
  const units = communicationUnits(ir, original);
  if (units.length < 2) {
    const compact = await retryCompactCommunicationPages(
      layout,
      ir,
      request,
      units,
      original,
      fits,
      unfit,
    );
    return compact ?? [full];
  }
  const native = await paginateCommunicationUnits(
    layout,
    ir,
    request,
    units,
    original,
    fits,
    unfit,
  );
  if (native.ok) return native.drawings;
  const compact = await retryCompactCommunicationPages(
    layout,
    ir,
    request,
    units,
    original,
    fits,
    unfit,
  );
  if (compact) return compact;
  throw native.error;
}
