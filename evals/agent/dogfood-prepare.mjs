import { readFileSync } from "node:fs";
import { join } from "node:path";
import { libraryTypes } from "./source-files.mjs";
import {
  read,
  write,
  objects,
  locate,
  ok,
  query,
  replaceObject,
  addSource,
  device,
  wire,
  ep,
  docView,
  view,
} from "./task-support.mjs";

function buildBaseAddedObjects(ctx, pump) {
  const base = structuredClone(
    read(new URL("./fixtures/motor-starter.json", import.meta.url)),
  );
  const existing = new Set(objects(ctx.project).map((o) => o.designation));
  const added = base.objects.filter(
    (o) =>
      !existing.has(o.designation) &&
      !["W-PWR-014", "W-PWR-015"].includes(o.designation),
  );
  for (const object of added) {
    if (object.properties) {
      delete object.properties.size;
      delete object.properties.color;
    }
    if (object.kind === "cable")
      for (const core of object.conductors)
        core.usage = core.id === "2-" ? "spare" : "in-use";
  }
  if (!pump) {
    for (const object of added) {
      if (object.designation === "LS1") {
        object.designation = "PX1";
        object.type = "core:prox-pnp-3wire";
        object.description =
          "Generic PNP discharge sensor; physical selected-part pinout remains for review";
      }
      for (const endpoint of object.endpoints ?? [])
        if (endpoint?.device === "LS1") {
          endpoint.device = "PX1";
          endpoint.terminal = endpoint.terminal === "13" ? "1" : "4";
        }
      if (typeof object.description === "string")
        object.description = object.description.replaceAll("LS1", "PX1");
      if (object.properties?.label)
        object.properties.label = object.properties.label.replaceAll(
          "LS1",
          "PX1",
        );
    }
    added.push(wire("W-PX1-RETURN", ep("PX1", "3"), ep("JB1", "X1.3")));
  }
  added.push(
    device("START1", "core:limit-switch-2wire", {
      description:
        "Proposed NO start contact represented by the shipped generic limit-switch contact, a disclosed functional substitution; actuator/part selection requires review",
    }),
    wire("W-START-FEED", ep("PS1", "+"), ep("START1", "13")),
    wire("W-START-INPUT", ep("START1", "14"), ep("PLC1", "X1.1")),
  );
  return added;
}
function configureConveyorLocalButton(ctx, added) {
  const noButton = structuredClone(
    libraryTypes(ctx.project).find((t) => t.id === "core:limit-switch-2wire"),
  );
  delete noButton.library;
  noButton.id = "eval:start-button-no";
  noButton.symbol = "thermite:pushbutton";
  noButton.description =
    "Generic NO start pushbutton function using shipped generic contact terminal keys; selected-part physical pinout and actuator remain unverified.";
  added.find((o) => o.designation === "START1").type = noButton.id;
  added.find((o) => o.designation === "START1").description =
    noButton.description;
  write(join(ctx.project, "libraries/eval/library.json"), {
    name: "eval",
    version: "0.1.0",
    sources: ["types.json"],
  });
  write(join(ctx.project, "libraries/eval/types.json"), {
    types: [noButton],
  });
  const localManifest = read(join(ctx.project, "system.json"));
  localManifest.libraries.push({
    name: "eval",
    version: "0.1.0",
    path: "libraries/eval",
  });
  write(join(ctx.project, "system.json"), localManifest);
  ok(ctx, "lock", ".");
}
function configurePumpDevicesAndWires(added) {
  added.find((o) => o.designation === "START1").type = "core:pushbutton-no";
  added.find((o) => o.designation === "START1").description =
    "Generic NO start pushbutton; selected hardware and ratings remain unverified.";
  const level = added.find((o) => o.designation === "LS1");
  level.type = "core:level-switch-no";
  level.description =
    "Generic NO level contact; actuation level, process meaning and selected hardware remain unspecified.";
  const cable = added.find((o) => o.designation === "CBL1");
  cable.description =
    "Pressure transmitter interface cable; both second-pair cores are explicit terminated spares.";
  for (const core of cable.conductors)
    core.usage = core.id.startsWith("2") ? "spare" : "in-use";
  // Preserve two separate passive signal nets, following core's unpowered RM3
  // interface example. Do not invent AI mode, current shunts or loop power.
  const feed = added.find((o) => o.designation === "W-FLD-001");
  feed.endpoints = [ep("TB1", "3"), ep("PLC1", "AI0-")];
  feed.properties.label = "PRESSURE-AI0-";
  const positive = added.find((o) => o.designation === "W-FLD-002");
  positive.endpoints = [ep("JB1", "X1.1"), ep("PT1", "+")];
  positive.properties.label = "PRESSURE-LOOP+";
  const negative = added.find((o) => o.designation === "W-FLD-003");
  negative.endpoints = [ep("PT1", "-"), ep("JB1", "X1.2")];
  negative.properties.label = "PRESSURE-LOOP-";
  const remove = new Set(["JP1", "W-CTL-003", "W-CTL-004"]);
  for (let i = added.length - 1; i >= 0; i--)
    if (remove.has(added[i].designation)) added.splice(i, 1);
  for (const object of added)
    for (const endpoint of object.endpoints ?? [])
      if (endpoint?.device === "PLC1")
        endpoint.terminal =
          { "X1.0": "DI0", "X1.1": "DI1", "X2.0": "DO0" }[endpoint.terminal] ??
          endpoint.terminal;
  added.push(
    device("PT1", "core:transmitter-2wire-4-20ma", {
      description:
        "Brief's pressure measurement role, using the generic two-wire 4-20 mA interface; range, supply and compatibility not selected.",
      connectionReview: {
        terminals: {
          "+": {
            status: "deferred",
            reason:
              "Unpowered generic loop interface: select loop power, PLC AI mode and hardware compatibility before service; no electrical performance is asserted.",
          },
        },
      },
    }),
    wire("W-FLD-AI+", ep("TB1", "2"), ep("PLC1", "AI0+")),
    wire("W-LEVEL-FEED", ep("PS1", "+"), ep("LS1", "13")),
    wire("W-LEVEL-INPUT", ep("LS1", "14"), ep("PLC1", "DI0")),
  );
}
function applyDogfoodModelSources(ctx, added, pump, exportDrawings) {
  const stop = added.find((o) => o.designation === "PB1");
  if (!pump)
    stop.connectionReview = {
      terminals: {
        11: {
          status: "deferred",
          reason:
            "Stop remains in the coil chain. Separate PLC monitoring is unfinished: the installed compact PLC has only two DI, occupied by the discharge sensor and start contact. Select/review a larger PLC before adding the third input.",
        },
      },
    };
  addSource(ctx, "reference-machine.json", added);
  if (pump) {
    replaceObject(ctx, "PLC1", "type", "core:plc-8di-8do-2ai");
    addSource(ctx, "hmi-network.json", [
      device("HMI1", "core:hmi"),
      wire("W-HMI-SUPPLY", ep("PS1", "+"), ep("HMI1", "L+")),
      wire("W-HMI-RETURN", ep("PS1", "-"), ep("HMI1", "M")),
      {
        uid: "5abc7db2-853a-46e8-9ae8-9eab691b16ab",
        kind: "relation",
        designation: "ETH1",
        relation: "associated_with",
        from: { device: "PLC1" },
        to: { device: "HMI1" },
        connection: {
          fromPort: "ETH",
          toPort: "ETH",
          medium: "ethernet",
          protocol: "Ethernet",
          status: "planned",
        },
      },
    ]);
  }
  if (exportDrawings) ok(ctx, "validate", ".");
}
function buildPumpDistributionView() {
  return {
    format: "circuit-view-request/0.1",
    title: "PS1 DC distribution",
    groups: [
      ["PLC1", ["W-CTL-001", "W-CTL-002"]],
      ["HMI1", ["W-HMI-SUPPLY", "W-HMI-RETURN"]],
    ].map(([designation, conductors]) => ({
      id: designation.toLowerCase(),
      label: `Generic supply to ${designation}; verify selected hardware ratings`,
      functions: [
        { device: { by: "designation", value: "PS1" }, key: "dc_output" },
        { device: { by: "designation", value: designation }, key: "supply" },
      ],
      conductors,
    })),
  };
}
function writeDogfoodPacketRequest(ctx, pump) {
  const fields = objects(ctx.project)
    .filter(
      (o) =>
        ["wire", "jumper"].includes(o.kind) &&
        /W-FLD|JP1|W-PX1/.test(o.designation),
    )
    .map((o) => o.designation);
  const views = [
    view("M1", "power"),
    view("K1", "control"),
    pump ? buildPumpDistributionView() : view("PS1", "loads"),
    view("CBL1", "conductors"),
    {
      format: "wiring-view-request/0.1",
      title: "Field hookup and terminal points",
      conductors: fields,
    },
    {
      format: "wiring-view-request/0.1",
      title: "Proposed start contact to PLC input",
      conductors: ["W-START-FEED", "W-START-INPUT"],
    },
    ...(pump
      ? [
          {
            format: "wiring-view-request/0.1",
            title: "Level contact to PLC input",
            conductors: ["W-LEVEL-FEED", "W-LEVEL-INPUT"],
          },
          {
            format: "signal-loop-view-request/0.1",
            from: { device: "PT1", function: "signal" },
            to: { device: "PLC1", function: "ai0" },
            notes: [
              "Unpowered generic interface; select loop power, AI mode and compatible hardware before service.",
            ],
          },
          { format: "communication-view-request/0.1", medium: "ethernet" },
        ]
      : []),
    ...ctx.task.deliverables.reports.map(docView),
  ];
  write(join(ctx.project, "packet.request.json"), {
    format: "schematic-packet-request/0.1",
    index: true,
    views,
  });
}
function emitDogfoodOutputs(ctx, pump) {
  ok(ctx, "view", "M1", "--power", "-o", "drawings/motor-power.pdf");
  ok(
    ctx,
    "view",
    "K1",
    "--actuation",
    "-o",
    "drawings/contactor-actuation.pdf",
  );
  if (!pump) ok(ctx, "view", "PS1", "--loads", "-o", "drawings/ps1-loads.pdf");
  writeDogfoodPacketRequest(ctx, pump);
  for (const ext of ["json", "html", "pdf"])
    ok(
      ctx,
      "packet",
      "--input",
      "packet.request.json",
      "-o",
      `drawings/packet.${ext}`,
    );
  for (const kind of ctx.task.deliverables.reports)
    ok(ctx, "report", kind, "-o", `drawings/${kind}.csv`);
  write(
    join(ctx.project, "drawings/diagnostics.json"),
    query(ctx, "diagnostics", "--json"),
  );
  write(
    join(ctx.project, "drawings/cable.json"),
    query(ctx, "cable", "CBL1", "--json"),
  );
}
function applyGuardedDogfoodEdits(ctx, pump, exportDrawings) {
  const emitReview = () =>
    write(
      join(ctx.project, "drawings/review.json"),
      query(ctx, "review", "--before", "drawings/before.json", "--json"),
    );
  // Exercise the brief's order: produce, guarded change, then regenerate.
  if (exportDrawings) emitDogfoodOutputs(ctx, pump);
  ok(ctx, "snapshot", "-o", "drawings/before.json");
  replaceObject(
    ctx,
    "M1",
    "description",
    pump
      ? "5 HP pump motor requirement; generic 480 VAC model, selected-part protection and nameplate review unfinished"
      : "2 HP 480 V conveyor motor requirement; generic model, selected-part protection and nameplate review unfinished",
  );
  if (exportDrawings) emitReview();
  replaceObject(ctx, "W-START-INPUT", "properties", {
    ...locate(ctx.project, "W-START-INPUT").object.properties,
    label: "START-INPUT-REVIEWED",
  });
  if (exportDrawings) {
    emitReview();
    emitDogfoodOutputs(ctx, pump);
  } else writeDogfoodPacketRequest(ctx, pump);
}
function formatSatisfiedSummary(key, names, pump) {
  if (pump && key === "ANALOG")
    return "PT1 is wired through the field cable and terminal strip to PLC1.AI0+/AI0-. The same PLC provides the digital control and HMI link. Loop power, input mode, ratings and hardware compatibility remain unselected.";
  if (pump && key === "START")
    return "START1 uses the shipped generic NO pushbutton; no selected-part certification is asserted.";
  if (key === "START")
    return "The local generic NO pushbutton uses the required catalog profile and the shipped generic contact shape. Manufacturer selection and physical pinout remain unverified; no selected-part certification is asserted.";
  if (["FRICTION", "VISUAL", "GUIDE"].includes(key))
    return "See friction.md for observed output-generation results and the explicit pending visual inspection. This is not a visual-quality pass.";
  return `Validated source and regenerated packet show ${names.join(", ") || "the requested deliverables"}. See drawings/ and the guarded snapshot/review requests; no manufacturer certification is asserted.`;
}
function writeRequirementMatrix(ctx, pump) {
  const mapping = {
    SUPPLY: ["SRC1"],
    BREAKER: ["CB1"],
    STARTER: ["K1", "OL1"],
    MOTOR: ["M1"],
    PSU: ["PS1"],
    PLC: ["PLC1"],
    TERMINALS: ["TB1"],
    CABLE: ["CBL1"],
    START: ["START1"],
    STOP: ["PB1"],
    COIL: pump ? ["PLC1", "K1"] : ["PLC1", "K1", "OL1"],
    LEVEL: ["LS1"],
    TRANSMITTER: ["PT1"],
    ANALOG: ["PLC1"],
    NETWORK: ["PLC1", "HMI1"],
    SENSOR: ["PX1"],
    JUNCTION: ["JB1"],
    SPARE: ["CBL1"],
    CHANGE: ["M1"],
  };
  const matrix = ctx.task.deliverables.requirements.map((requirement) => {
    const key = requirement.id.slice(2),
      names = mapping[key] ?? [];
    if (key === "PSU")
      return {
        id: requirement.id,
        status: "deferred",
        designations: ["PS1"],
        evidence: {
          summary:
            "PS1 DC loads are drawn; its AC input feed is not designed. Input rating and branch protection require reviewed engineering facts, so no 480 V feed is wired.",
          diagnostic: { code: "W905", designation: "PS1" },
        },
      };
    if (!pump && key === "STOP")
      return {
        id: requirement.id,
        status: "deferred",
        designations: names,
        evidence: {
          summary:
            "The NC stop is drawn in the coil chain. Monitoring it as a third PLC input is unfinished because the two shipped DI are occupied. Choose a reviewed larger PLC; W905 preserves this unfinished work.",
          diagnostic: { code: "W905", designation: "PB1" },
        },
      };
    if (key === "INDICATOR")
      return {
        id: requirement.id,
        status: "deferred",
        designations: [],
        evidence: {
          summary:
            "The brief makes the indicator conditional. It is omitted from this reference; no selected lamp or stack-light hardware and ratings are asserted.",
        },
      };
    return {
      id: requirement.id,
      status: "satisfied",
      designations: names,
      evidence: { summary: formatSatisfiedSummary(key, names, pump) },
    };
  });
  write(join(ctx.project, "requirement-matrix.json"), matrix);
}
function writeDogfoodNotes(ctx, pump) {
  write(
    join(ctx.project, "friction.md"),
    `Reference uses shipped generic models, not manufacturer-verified equipment. Wire gauge/color claims from the synthetic base were removed. ${pump ? "Core 0.2.0 supplies the transmitter, analog-input PLC, level switch, NO start button and HMI. PT1 is drawn through JB1, CBL1 and TB1 into PLC1.AI0+/AI0-. PLC1 also drives the contactor and links to the HMI; there is no separate analog controller or invented backplane. The two-wire interface is unpowered, following the shipped RM3 interface example: loop power, AI mode, compatibility, range and physical hardware still require engineering selection. PLC1 and HMI1 DC supply magnitudes and interface ratings remain unspecified by their generic types; no compatibility certification is asserted. Level reference condition and actuation meaning are unspecified." : "PNP wiring follows the shipped generic 1/3/4 model through JB1, CBL1 and TB1; physical selected-part review remains. The third PLC input for stop monitoring is deferred with W905. Conditional indicator is omitted, rather than claimed unavailable in core."} ${pump ? "The pump uses shipped core types without authoring local types." : "The generic NO pushbutton local type copies the shipped contact shape and declares the required profile; physical part selection is unverified."} All generated outputs succeeded without recovery calls. Tool-call and failure counts are in the run score. PS1 input is intentionally unwired: the starter feed is not designed, its input rating and branch protection are unverified (W905). Visual inspection of at least two outputs and PDF V1/V5 remain pending independent judgement.\n`,
  );
  if (pump) {
    const bytes = readFileSync(join(ctx.project, "AGENTS.md")).length;
    write(join(ctx.project, "guide-observation.json"), {
      bytes,
      needed:
        "Scripted reference: no model context; guide policy is implemented by the reference helpers, not claimed as an agent read.",
    });
  }
}
export function runPrepareDogfoodProject(ctx, { exportDrawings = false } = {}) {
  const pump = ctx.task.id === "D-pump";
  const added = buildBaseAddedObjects(ctx, pump);
  if (!pump) configureConveyorLocalButton(ctx, added);
  else configurePumpDevicesAndWires(added);
  applyDogfoodModelSources(ctx, added, pump, exportDrawings);
  applyGuardedDogfoodEdits(ctx, pump, exportDrawings);
  writeRequirementMatrix(ctx, pump);
  if (!exportDrawings) return;
  writeDogfoodNotes(ctx, pump);
}
