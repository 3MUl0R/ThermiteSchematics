import { paintedWireUids } from "./conductor-ink.mjs";
import { canonical } from "./source-files.mjs";
import { symbolProfile } from "../../packages/schema/dist/index.js";

function gapExists(gap, requirement, types, fitsRole) {
  if (!gap || canonical(gap) !== canonical(requirement.allowedGap))
    return false;
  const inventory = types.filter((t) => t.library === gap.library);
  if (!inventory.length) return false;
  if (gap.capability === "digital-input-count")
    return (
      Math.max(
        ...inventory.map(
          (t) =>
            Object.values(t.functions ?? {}).filter(
              (f) =>
                f.kind === "channel" &&
                f.direction === "input" &&
                f.terminals?.length === 1,
            ).length,
        ),
      ) < gap.minimum
    );
  return !inventory.some((type) =>
    fitsRole({ kind: "device" }, type, gap.capability),
  );
}
function applyRequest(call) {
  if (
    call.argv?.[0] !== "agent" ||
    call.argv?.[1] !== "apply-source-patch" ||
    call.exit !== 0
  )
    return null;
  try {
    const request = JSON.parse(call.request ?? "null");
    return request?.dryRun === false ? request : null;
  } catch {
    return null;
  }
}
function recordedDigest(value) {
  return typeof value === "string" && value.startsWith("sha256-")
    ? Buffer.from(value.slice(7), "base64").toString("hex")
    : null;
}
function changedWireUids(applies) {
  const touched = new Set();
  for (const { call, request } of applies) {
    const targets = new Set(request.files?.map(({ path }) => path));
    for (const file of call.patchFiles ?? []) {
      if (
        !file.changed ||
        !targets.has(file.path) ||
        !call.before?.files?.[file.path] ||
        !call.after?.files?.[file.path] ||
        recordedDigest(file.beforeIntegrity) !== call.before.files[file.path] ||
        recordedDigest(file.afterIntegrity) !== call.after.files[file.path]
      )
        continue;
      const before = call.before.documents?.[file.path]?.objects;
      const after = call.after.documents?.[file.path]?.objects;
      if (!Array.isArray(before) || !Array.isArray(after)) continue;
      const prior = new Map(before.map((object) => [object.uid, object]));
      for (const object of after)
        if (
          object.kind === "wire" &&
          object.uid &&
          canonical(prior.get(object.uid)) !== canonical(object)
        )
          touched.add(object.uid);
    }
  }
  return touched;
}
function hasRule(version, patch) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return (
    !!match &&
    (+match[1] > 1 ||
      (+match[1] === 1 &&
        (+match[2] > 6 || (+match[2] === 6 && +match[3] >= patch))))
  );
}
function createAssessContext(
  { packet, sourceObjects, types, calls, diagnostics },
  { schematicSheets, drawingNames, drawnWires, fitsRole },
) {
  const byTag = new Map(
      sourceObjects.filter((o) => o.designation).map((o) => [o.designation, o]),
    ),
    byType = new Map(types.map((t) => [t.id, t])),
    drawn = drawingNames(packet),
    wireInk = drawnWires(packet);
  const applies = calls.flatMap((call) => {
    const request = applyRequest(call);
    return request && call.editsByThisCall?.length ? [{ call, request }] : [];
  });
  const changedWires = changedWireUids(applies);
  let paintedChangeWires;
  const uidNames = new Map(sourceObjects.map((o) => [o.uid, o.designation]));
  const warnings = diagnostics.map((d) => ({
    ...d,
    designation:
      d.designation ??
      uidNames.get(d.uid) ??
      /^([^:]+):/.exec(d.message ?? "")?.[1],
  }));
  const psuInputs = (psu) =>
    Object.values(byType.get(psu?.type)?.functions ?? {})
      .filter((f) => f.kind === "load")
      .flatMap((f) => f.terminals);
  const inputConductors = (psu, terminal) =>
    sourceObjects.filter(
      (o) =>
        ["wire", "jumper"].includes(o.kind) &&
        o.endpoints?.some(
          (e) => e?.device === psu.designation && e.terminal === terminal,
        ),
    );
  const deferredInput = (psu, terminal) =>
    psu.connectionReview?.terminals?.[terminal]?.status === "deferred" &&
    inputConductors(psu, terminal).length === 0 &&
    warnings.some(
      (d) => d.designation === psu.designation && d.code === "W905",
    );
  const hasPaintedChangeWire = (uid) =>
    (paintedChangeWires ??= new Set(
      schematicSheets(packet).flatMap((sheet) =>
        sheet.svg ? [...paintedWireUids(sheet.svg)] : [],
      ),
    )).has(uid);
  return {
    byTag,
    byType,
    drawn,
    wireInk,
    applies,
    changedWires,
    warnings,
    psuInputs,
    inputConductors,
    deferredInput,
    hasPaintedChangeWire,
    types,
    fitsRole,
    schematicSheets,
  };
}
function ownsRequirementSubject(tag, role, declaredGap, evidence, ctx) {
  const object = ctx.byTag.get(tag),
    type = ctx.byType.get(object?.type);
  if (ctx.fitsRole(object, type, role)) return true;
  if (!declaredGap) return false;
  if (!object)
    return (
      evidence?.unmodeled === true &&
      evidence.libraryGap.capability === role &&
      typeof tag === "string" &&
      tag.trim().length > 0
    );
  return (
    role === "level-switch" &&
    evidence.libraryGap.capability === role &&
    symbolProfile(type ?? {}) === "thermite:switch"
  );
}
function evaluateDeferredRequirement(
  requirement,
  evidence,
  names,
  gapSubjects,
  basePass,
  ctx,
) {
  const diagnosis = typeof evidence === "object" && evidence.diagnostic;
  const deferredJustified =
    requirement.obligation === "may" ||
    gapSubjects ||
    !!(
      diagnosis &&
      names?.length > 0 &&
      names.includes(diagnosis.designation) &&
      requirement.roles.some((role) =>
        ctx.fitsRole(
          ctx.byTag.get(diagnosis.designation),
          ctx.byType.get(ctx.byTag.get(diagnosis.designation)?.type),
          role,
        ),
      ) &&
      ctx.warnings.some(
        (d) =>
          d.code === diagnosis.code && d.designation === diagnosis.designation,
      )
    );
  const pass =
    basePass &&
    deferredJustified &&
    names.every(
      (tag) => ctx.drawn.has(tag) || (!ctx.byTag.has(tag) && gapSubjects),
    );
  return { pass, deferredJustified };
}
function evaluateActiveRequirement(
  requirement,
  row,
  summary,
  names,
  represented,
  basePass,
  ctx,
) {
  let pass =
    basePass &&
    represented &&
    (requirement.roles.length === 0 ||
      names.every((tag) =>
        requirement.roles.some((role) =>
          ctx.fitsRole(
            ctx.byTag.get(tag),
            ctx.byType.get(ctx.byTag.get(tag)?.type),
            role,
          ),
        ),
      )) &&
    requirement.roles.every((role) =>
      names.some((tag) =>
        ctx.fitsRole(
          ctx.byTag.get(tag),
          ctx.byType.get(ctx.byTag.get(tag)?.type),
          role,
        ),
      ),
    );
  if (requirement.roles.includes("psu"))
    pass =
      pass &&
      !names.some((tag) => {
        const psu = ctx.byTag.get(tag);
        return ctx
          .psuInputs(psu)
          .some((terminal) => ctx.deferredInput(psu, terminal));
      });
  if (requirement.normalState)
    pass =
      pass &&
      names.some((tag) =>
        Object.values(
          ctx.byType.get(ctx.byTag.get(tag)?.type)?.functions ?? {},
        ).some(
          (f) =>
            f.kind === "contact" && f.normal_state === requirement.normalState,
        ),
      );
  if (row?.status === "substituted") pass = pass && summary.trim().length >= 20;
  return pass;
}
function isRequirementRepresented(requirement, names, known, ctx) {
  const changeRow = /^(?:C|P)-CHANGE$/.test(requirement.id);
  return (
    known &&
    names.every((tag) => {
      const object = ctx.byTag.get(tag);
      if (changeRow && object.kind === "wire")
        return (
          ctx.changedWires.has(object.uid) &&
          ctx.hasPaintedChangeWire(object.uid)
        );
      return ctx.drawn.has(tag);
    })
  );
}
function buildRequirementBindings(requirement, row, names, ownsSubject, ctx) {
  return new Map(
    (names ?? []).map((tag) => [
      tag,
      requirement.roles.filter((role) =>
        row?.status === "deferred"
          ? ownsSubject(tag, role)
          : ctx.fitsRole(
              ctx.byTag.get(tag),
              ctx.byType.get(ctx.byTag.get(tag)?.type),
              role,
            ),
      ),
    ]),
  );
}
function evaluateRequirementDecision(requirement, rows, promptVersion, ctx) {
  const matches = rows.filter(
      (r) => typeof r.id === "string" && r.id.toUpperCase() === requirement.id,
    ),
    row = matches[0],
    evidence = row?.evidence,
    summary = typeof evidence === "string" ? evidence : evidence?.summary,
    names = row?.designations,
    known =
      Array.isArray(names) &&
      names.every((tag) => typeof tag === "string" && ctx.byTag.has(tag)),
    represented = isRequirementRepresented(requirement, names, known, ctx);
  const declaredGap =
    names?.length > 0 &&
    gapExists(evidence?.libraryGap, requirement, ctx.types, ctx.fitsRole);
  const ownsSubject = (tag, role) =>
    ownsRequirementSubject(tag, role, declaredGap, evidence, ctx);
  const gapSubjects =
    declaredGap &&
    requirement.roles.every((role) =>
      names.some((tag) => ownsSubject(tag, role)),
    ) &&
    names.every((tag) =>
      requirement.roles.some((role) => ownsSubject(tag, role)),
    );
  const basePass =
    matches.length === 1 &&
    ["satisfied", "substituted", "deferred"].includes(row?.status) &&
    typeof summary === "string" &&
    summary.trim().length >= 8 &&
    (known || (row?.status === "deferred" && gapSubjects)) &&
    (requirement.id !== "C-CHANGE" ||
      !hasRule(promptVersion, 1) ||
      names.length > 0);
  const outcome =
    row?.status === "deferred"
      ? evaluateDeferredRequirement(
          requirement,
          evidence,
          names,
          gapSubjects,
          basePass,
          ctx,
        )
      : {
          pass: evaluateActiveRequirement(
            requirement,
            row,
            summary,
            names,
            represented,
            basePass,
            ctx,
          ),
          deferredJustified: false,
        };
  return {
    id: requirement.id,
    pass: !!outcome.pass,
    row,
    deferredJustified: outcome.deferredJustified,
    bindings: buildRequirementBindings(
      requirement,
      row,
      names,
      ownsSubject,
      ctx,
    ),
  };
}
function invalidateRoleConflicts(decisions) {
  // Only a PLC and its onboard analog-input role may share identities.
  // Check every role pair: another shared role must not hide a mismatch.
  for (let i = 0; i < decisions.length; i++)
    for (let j = i + 1; j < decisions.length; j++) {
      const a = decisions[i],
        b = decisions[j];
      for (const [tag, roles] of a.bindings) {
        const other = b.bindings.get(tag);
        if (
          roles.length &&
          other?.length &&
          roles.some((role) =>
            other.some(
              (otherRole) =>
                role !== otherRole &&
                ![role, otherRole].every((r) =>
                  ["plc", "analog-input"].includes(r),
                ),
            ),
          )
        ) {
          a.pass = false;
          b.pass = false;
        }
      }
    }
}
function evaluateCoverage(sourceObjects, packet, ctx) {
  const allDeviceCoverage = sourceObjects
    .filter(
      (o) =>
        o.kind === "device" &&
        !ctx.fitsRole(o, ctx.byType.get(o.type), "terminal"),
    )
    .every((o) => ctx.drawn.has(o.designation));
  const drawnConductors = new Set(
    (packet?.coverage?.conductors ?? [])
      .filter((c) => c.appearances?.length)
      .map((c) => c.designation),
  );
  const psus = sourceObjects.filter((o) =>
    ctx.fitsRole(o, ctx.byType.get(o.type), "psu"),
  );
  const feedDrawn =
    psus.length > 0 &&
    psus.every((psu) => {
      const inputs = ctx.psuInputs(psu);
      const powerView = ctx
        .schematicSheets(packet)
        .some(
          (s) =>
            s.view.family === "power" &&
            s.view.root?.designation === psu.designation,
        );
      return (
        inputs.length > 0 &&
        inputs.every((terminal) => {
          if (ctx.deferredInput(psu, terminal)) return true;
          return ctx
            .inputConductors(psu, terminal)
            .some(
              (o) =>
                ctx.wireInk.has(o.uid) ||
                drawnConductors.has(o.designation ?? o.uid) ||
                powerView,
            );
        })
      );
    });
  return allDeviceCoverage && feedDrawn;
}
function buildDogfoodChecks({
  spec,
  promptVersion,
  validationExit,
  files,
  packet,
  packetFormats,
  applies,
  coverage,
  drawEvidence,
  rows,
  decisions,
  counts,
}) {
  const hasPacketIndex = packetFormats
    ? ["html", "json", "pdf"].every((ext) =>
        packetFormats[ext]?.sheets?.some((s) => s.view?.kind === "index"),
      )
    : !!packet?.sheets?.some((s) => s.view?.kind === "index");
  return {
    validation: validationExit === 0,
    viewsAndPacket:
      spec.views.every((name) => files[`drawings/${name}`] === true) &&
      ["html", "json", "pdf"].every(
        (ext) => files[`drawings/packet.${ext}`] === true,
      ) &&
      hasPacketIndex,
    guardedChange:
      applies.length > 0 &&
      files["drawings/before.json"] === true &&
      files["drawings/review.json"] === true,
    reports:
      spec.reports.every((kind) => files[`drawings/${kind}.csv`] === true) &&
      files["drawings/diagnostics.json"] === true &&
      files["drawings/cable.json"] === true,
    coverage,
    pdfV1V5: drawEvidence
      ? drawEvidence.format === "thermite-agent-draw-evidence/1.0" &&
        drawEvidence.V1 === true &&
        drawEvidence.V5 === true
      : null,
    requirementMatrix:
      rows.length === spec.requirements.length &&
      decisions.every((d) => d.pass),
    counts:
      ["localTypes", "sourceReads", "failedCalls"].every(
        (key) => Number.isInteger(counts?.[key]) && counts[key] >= 0,
      ) &&
      (!hasRule(promptVersion, 0) || counts.attemptedWrites === 0),
  };
}
function buildAssessResult(decisions, checks, sourceObjects, counts, ctx) {
  const expectedNames = new Set(
    decisions
      .filter((d) => d.row?.status === "deferred")
      .flatMap((d) => d.row.designations ?? []),
  );
  for (const object of sourceObjects)
    if (
      ctx.byType.get(object.type)?.connectionCoverage?.status === "partial" ||
      Object.values(object.connectionReview ?? {}).some((points) =>
        Object.values(points).some((p) => p.status === "deferred"),
      )
    )
      expectedNames.add(object.designation);
  const controllerTags = new Set(
    decisions.flatMap((d) =>
      [...d.bindings]
        .filter(([, roles]) => roles.includes("plc"))
        .map(([tag]) => tag),
    ),
  );
  const separateAnalogTags = new Set(
    decisions.flatMap((d) =>
      [...d.bindings]
        .filter(
          ([tag, roles]) =>
            roles.includes("analog-input") && !controllerTags.has(tag),
        )
        .map(([tag]) => tag),
    ),
  );
  return {
    pass:
      Object.entries(checks)
        .filter(([key]) => key !== "pdfV1V5")
        .every(([, v]) => v === true) && checks.pdfV1V5 !== false,
    checks,
    requirements: decisions.map(({ row, bindings, ...d }) => d),
    pending: [
      ...(checks.pdfV1V5 === null
        ? ["PDF V1/V5 requires E3 or blinded visual judgement"]
        : []),
      ...[...separateAnalogTags].map(
        (tag) =>
          `Separate analog input ${tag}: its link to the controlling PLC is not verified by this checker. Judge the authored integration; no backplane or expansion relation is inferred.`,
      ),
    ],
    counts,
    rubricPending: true,
    expectedWarnings: [...expectedNames]
      .filter((name) => ctx.byTag.get(name)?.kind === "device")
      .map((designation) => ({
        anyOf: ["W903", "W904", "W905"].map((code) => ({ code, designation })),
      })),
    actualWarnings: ctx.warnings.filter((d) => d.severity === "warning"),
  };
}
export function runAssessDogfood(
  {
    task,
    promptVersion = task.version,
    validationExit,
    files,
    packet,
    packetFormats = null,
    sourceObjects,
    types = [],
    calls,
    matrix,
    drawEvidence,
    counts,
    diagnostics = [],
  },
  helpers,
) {
  const spec = task.deliverables,
    rows = Array.isArray(matrix) ? matrix : [];
  const ctx = createAssessContext(
    { packet, sourceObjects, types, calls, diagnostics },
    helpers,
  );
  const decisions = spec.requirements.map((requirement) =>
    evaluateRequirementDecision(requirement, rows, promptVersion, ctx),
  );
  invalidateRoleConflicts(decisions);
  const coverage = evaluateCoverage(sourceObjects, packet, ctx);
  const checks = buildDogfoodChecks({
    spec,
    promptVersion,
    validationExit,
    files,
    packet,
    packetFormats,
    applies: ctx.applies,
    coverage,
    drawEvidence,
    rows,
    decisions,
    counts,
  });
  return buildAssessResult(decisions, checks, sourceObjects, counts, ctx);
}
