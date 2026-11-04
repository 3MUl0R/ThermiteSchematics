/** Render capabilities only. These records never grant electrical continuity.
 * Keep JSON-serializable so runtime guides can print the catalog directly.
 * Support is per function/role, not a promise that a whole view can be laid out.
 */
export type SymbolRendererFamily =
  "power" | "control" | "loads" | "circuit" | "signal-loop";

export interface SymbolFunctionShape {
  readonly kind:
    "contact" | "coil" | "load" | "source" | "bus" | "channel" | "other";
  readonly minTerminals: number;
  readonly maxTerminals: number;
  /** Constraints on terminals in authored function order. */
  readonly terminalRoles?: readonly string[];
  readonly firstTerminalVoltageType?: "DC";
  readonly notes?: string;
}

export interface SymbolFamilySupport {
  readonly family: SymbolRendererFamily;
  readonly role:
    "function" | "boundary" | "from" | "to" | "intermediate" | "auxiliary";
  /** Alternative shapes. Explicit circuitSymbols are checked separately. */
  readonly functions: readonly SymbolFunctionShape[];
  /** Terminal-only roles do not require a declared function. */
  readonly terminalOnly?: { readonly minTerminals: number };
  readonly notes?: string;
}

export interface CoreSymbolBinding {
  readonly typeId: string;
  readonly symbol: string;
  readonly binding: "core-type-id";
  readonly equivalent?: string;
}

/** IEC names are compatibility metadata for these exact IDs, never reusable aliases.
 * Equivalents follow symbols/circuit.ts; prox has no reusable equivalent yet.
 */
export const CORE_SYMBOL_BINDINGS: readonly CoreSymbolBinding[] = [
  {
    typeId: "core:supply-480v-3ph",
    symbol: "iec:three-phase-supply",
    binding: "core-type-id",
    equivalent: "thermite:power-source",
  },
  {
    typeId: "core:breaker-3p",
    symbol: "iec:circuit-breaker",
    binding: "core-type-id",
    equivalent: "thermite:breaker",
  },
  {
    typeId: "core:contactor-3p-1no",
    symbol: "iec:contactor",
    binding: "core-type-id",
    equivalent: "thermite:contactor",
  },
  {
    typeId: "core:overload-3p-1nc",
    symbol: "iec:overload-relay",
    binding: "core-type-id",
    equivalent: "thermite:overload",
  },
  {
    typeId: "core:motor-3ph",
    symbol: "iec:three-phase-motor",
    binding: "core-type-id",
    equivalent: "thermite:motor-3ph",
  },
  {
    typeId: "core:pushbutton-nc",
    symbol: "iec:pushbutton-nc",
    binding: "core-type-id",
    equivalent: "thermite:pushbutton",
  },
  {
    typeId: "core:limit-switch-2wire",
    symbol: "iec:limit-switch-no",
    binding: "core-type-id",
    equivalent: "thermite:switch",
  },
  {
    typeId: "core:plc-compact",
    symbol: "iec:plc",
    binding: "core-type-id",
    equivalent: "thermite:io-module",
  },
  {
    typeId: "core:psu-24vdc",
    symbol: "iec:dc-power-supply",
    binding: "core-type-id",
    equivalent: "thermite:dc-supply",
  },
  {
    typeId: "core:terminal-block-8",
    symbol: "iec:terminal-block",
    binding: "core-type-id",
    equivalent: "thermite:terminal-strip",
  },
  {
    typeId: "core:junction-box-8",
    symbol: "iec:junction-box",
    binding: "core-type-id",
    equivalent: "thermite:terminal-strip",
  },
  {
    typeId: "core:prox-pnp-3wire",
    symbol: "iec:proximity-sensor",
    binding: "core-type-id",
  },
];

export interface SymbolProfile {
  readonly id: string;
  /** Reusable aliases only; core-only IEC aliases are in coreAliases. */
  readonly aliases: readonly string[];
  readonly coreAliases: readonly CoreSymbolBinding[];
  readonly support: readonly SymbolFamilySupport[];
  readonly notes?: string;
}

const BUS = { kind: "bus", minTerminals: 1, maxTerminals: 1 } as const;
const CONTACT = { kind: "contact", minTerminals: 2, maxTerminals: 2 } as const;
const COIL = { kind: "coil", minTerminals: 2, maxTerminals: 2 } as const;
const LOAD2 = { kind: "load", minTerminals: 2, maxTerminals: 2 } as const;
const LOAD23 = { kind: "load", minTerminals: 2, maxTerminals: 3 } as const;
const SOURCE = { kind: "source", minTerminals: 1, maxTerminals: 4 } as const;
const SOURCE2 = { kind: "source", minTerminals: 2, maxTerminals: 2 } as const;
const CHANNEL = { kind: "channel", minTerminals: 1, maxTerminals: 2 } as const;
const OTHER2 = { kind: "other", minTerminals: 2, maxTerminals: 2 } as const;
// Signal-loop endpoints accept schema-authorable two-terminal functions.
const LOOP_ENDPOINT_SHAPES: readonly SymbolFunctionShape[] = [
  CONTACT,
  COIL,
  LOAD2,
  SOURCE2,
  { ...BUS, minTerminals: 2, maxTerminals: 2 },
  { ...CHANNEL, minTerminals: 2 },
  OTHER2,
];
const DC_LOAD = { ...LOAD2, firstTerminalVoltageType: "DC" } as const;
const DC_SOURCE = {
  ...SOURCE2,
  terminalRoles: ["dc_positive_output", "dc_return_output"],
} as const;
const ROOTED_CONTROL_SHAPES = [BUS, DC_LOAD, DC_SOURCE];
const ROOTED_SUPPORT: readonly SymbolFamilySupport[] = [
  { family: "power", role: "function", functions: [BUS] },
  { family: "control", role: "function", functions: ROOTED_CONTROL_SHAPES },
  {
    family: "loads",
    role: "function",
    functions: ROOTED_CONTROL_SHAPES,
    notes:
      "Uses control-family bindings; view selection still requires a source/load path.",
  },
];
const LOOP_INTERMEDIATE: SymbolFamilySupport = {
  family: "signal-loop",
  role: "intermediate",
  functions: [],
  terminalOnly: { minTerminals: 2 },
  notes:
    "Both conductors must traverse the same authored device stages. Auxiliary pairs may be selected separately; no function kind is inferred.",
};

const LOOP_AUXILIARY: SymbolFamilySupport = {
  family: "signal-loop",
  role: "auxiliary",
  functions: [OTHER2],
  notes:
    "Declared other/2 auxiliary pairs may begin/end at an intermediate stage, on separate nets. This catalog deliberately limits auxiliary shape support; contact/2 and bus/2 need their own supported circuit binding.",
};

/** The supported reusable profiles. Circuit accepts a one-terminal bus on each.
 * Circuit/rooted mechanisms are metadata, not drawable functions. Support does not imply
 * full device coverage, connectivity, a valid root, or printable layout.
 */
export const SYMBOL_PROFILES: readonly SymbolProfile[] = [
  {
    id: "thermite:contactor",
    notes:
      "Two-terminal coils and contacts, with authored normal state. Internal relationships provide non-conductive coil/contact references.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:contactor",
    ),
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT, COIL] },
    ],
  },
  {
    id: "thermite:relay",
    notes:
      "Two-terminal coils and contacts; relay power can be a separate two- or three-terminal load.",
    aliases: [],
    coreAliases: [],
    support: [
      {
        family: "circuit",
        role: "function",
        functions: [BUS, CONTACT, COIL, LOAD23],
      },
    ],
  },
  {
    id: "thermite:breaker",
    notes:
      "Protection contacts; explicit circuitSymbols marks distinguish main protection poles from auxiliary contacts.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:breaker",
    ),
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT] },
    ],
  },
  {
    id: "thermite:overload",
    notes:
      "Protection contacts; explicit circuitSymbols marks distinguish main protection poles from auxiliary contacts.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:overload",
    ),
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT] },
    ],
  },
  {
    id: "thermite:fuse",
    notes:
      "Protection contacts or a two-terminal other function; explicit marks distinguish main and auxiliary functions.",
    aliases: [],
    coreAliases: [],
    support: [
      {
        family: "circuit",
        role: "function",
        functions: [BUS, CONTACT, OTHER2],
      },
    ],
  },
  {
    id: "thermite:motor-3ph",
    notes:
      "Three-terminal motor load; phase terminals stay electrically distinct.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:motor-3ph",
    ),
    support: [
      {
        family: "circuit",
        role: "function",
        functions: [BUS, { kind: "load", minTerminals: 3, maxTerminals: 3 }],
      },
    ],
  },
  {
    id: "thermite:motor",
    notes: "Two-terminal motor load.",
    aliases: [],
    coreAliases: [],
    support: [{ family: "circuit", role: "function", functions: [BUS, LOAD2] }],
  },
  {
    id: "thermite:heater",
    notes:
      "Two- or three-terminal resistive loads; no star/delta connection is inferred.",
    aliases: [],
    coreAliases: [],
    support: [
      { family: "circuit", role: "function", functions: [BUS, LOAD23] },
    ],
  },
  {
    id: "thermite:transformer",
    notes:
      "Two-terminal primary load and secondary source windings face opposite sides of a shared magnetic core. The core is a presentation association, not a conductive connection.",
    aliases: [],
    coreAliases: [],
    support: [
      { family: "circuit", role: "function", functions: [BUS, LOAD2, SOURCE2] },
    ],
  },
  {
    id: "thermite:power-source",
    notes: "Supply boundaries from authored source functions.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:power-source",
    ),
    support: [
      { family: "circuit", role: "function", functions: [BUS, SOURCE] },
    ],
  },
  {
    id: "thermite:dc-supply",
    notes:
      "Supply boundaries; AC input and DC output are separate authored functions, with no implicit conductive step through the supply.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:dc-supply",
    ),
    support: [
      ...ROOTED_SUPPORT,
      { family: "circuit", role: "function", functions: [BUS, LOAD23, SOURCE] },
    ],
  },
  {
    id: "thermite:io-module",
    notes:
      "One/two-terminal circuit channels, supply functions, contacts and generic interfaces. Rooted control/loads bind only one-terminal channels. Authored I/O address and signal meaning identify channels.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:io-module",
    ),
    support: [
      { family: "power", role: "function", functions: [BUS] },
      ...(["control", "loads"] as const).map((family) => ({
        family,
        role: "function" as const,
        functions: [
          ...ROOTED_CONTROL_SHAPES,
          { kind: "channel" as const, minTerminals: 1, maxTerminals: 1 },
        ],
      })),
      {
        family: "circuit",
        role: "function",
        functions: [
          BUS,
          CONTACT,
          LOAD23,
          SOURCE,
          CHANNEL,
          {
            kind: "other",
            minTerminals: 1,
            maxTerminals: 32,
            notes:
              "Mark binding accepts 1-32 terminals. Measured 2026-11-04 on base 7a7c1fb plus P1 (review probe-io32): left-to-right samples fit 24 terminals on tabloid and 12 on A4; larger sampled interfaces failed with R006. These are measured examples, not guaranteed paper limits. Larger interfaces may need top-to-bottom or larger paper; labels and selection affect printability.",
          },
        ],
      },
    ],
  },
  {
    id: "thermite:terminal-strip",
    notes:
      "One-terminal buses have pass-through display ports for the same physical terminal. Terminal-only boundaries do not invent bus functions or common adjacent terminals.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:terminal-strip",
    ),
    support: [
      ...ROOTED_SUPPORT,
      { family: "circuit", role: "function", functions: [BUS] },
      {
        family: "circuit",
        role: "boundary",
        functions: [],
        terminalOnly: { minTerminals: 1 },
        notes:
          "Unselected terminals can be conductor boundaries without bus functions, including distributed terminal layout.",
      },
      LOOP_INTERMEDIATE,
      LOOP_AUXILIARY,
    ],
  },
  {
    id: "thermite:solenoid",
    notes: "Two-terminal coil with a solenoid mark.",
    aliases: [],
    coreAliases: [],
    support: [{ family: "circuit", role: "function", functions: [BUS, COIL] }],
  },
  {
    id: "thermite:lamp",
    notes: "Two-terminal lamp load.",
    aliases: [],
    coreAliases: [],
    support: [{ family: "circuit", role: "function", functions: [BUS, LOAD2] }],
  },
  {
    id: "thermite:switch",
    notes: "Two-terminal contact; the mark uses the authored normal state.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:switch",
    ),
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT] },
    ],
  },
  {
    id: "thermite:pushbutton",
    notes:
      "Two-terminal contact with pushbutton actuation and authored normal state; a separate lamp needs its own supported explicit circuit mark.",
    aliases: [],
    coreAliases: CORE_SYMBOL_BINDINGS.filter(
      (b) => b.equivalent === "thermite:pushbutton",
    ),
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT] },
    ],
  },
  {
    id: "thermite:thermocouple",
    notes: "Two-terminal other function representing the sensor interface.",
    aliases: [],
    coreAliases: [],
    support: [
      { family: "circuit", role: "function", functions: [BUS, OTHER2] },
    ],
  },
  {
    id: "thermite:pressure-switch",
    notes:
      "Two-terminal contacts with pressure actuation and declared normal state.",
    aliases: [],
    coreAliases: [],
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT] },
    ],
  },
  {
    id: "thermite:level-switch",
    notes:
      "Two-terminal contacts with float actuation and declared normal state.",
    aliases: [],
    coreAliases: [],
    support: [
      { family: "circuit", role: "function", functions: [BUS, CONTACT] },
    ],
  },
  {
    id: "thermite:level-sensor",
    notes:
      "Two/three-terminal other interfaces or one/two-terminal channels with their authored address and signal meaning.",
    aliases: [],
    coreAliases: [],
    support: [
      {
        family: "circuit",
        role: "function",
        functions: [
          BUS,
          CHANNEL,
          { kind: "other", minTerminals: 2, maxTerminals: 3 },
        ],
      },
    ],
  },
  {
    id: "thermite:conductivity-probe",
    notes:
      "Two-eight-terminal other interfaces; no internal commoning is inferred.",
    aliases: [],
    coreAliases: [],
    support: [
      {
        family: "circuit",
        role: "function",
        functions: [BUS, { kind: "other", minTerminals: 2, maxTerminals: 8 }],
      },
    ],
  },
  {
    id: "thermite:receptacle",
    notes:
      "Two/three-terminal loads; protective earth may be a separate one-terminal bus.",
    aliases: [],
    coreAliases: [],
    support: [
      { family: "circuit", role: "function", functions: [BUS, LOAD23] },
    ],
  },
  {
    id: "thermite:pressure-transmitter",
    notes:
      "Signal-loop only; unsupported in circuit and rooted power/control/loads views. The two-wire-transmitter alias shares the loop endpoint gate.",
    aliases: ["thermite:two-wire-transmitter"],
    coreAliases: [],
    support: [
      {
        family: "signal-loop",
        role: "from",
        functions: LOOP_ENDPOINT_SHAPES,
        notes:
          "Selected two-terminal endpoint to an input channel; the loop renderer does not restrict the transmitter function kind.",
      },
    ],
  },
  {
    id: "thermite:analog-actuator",
    notes:
      "Signal-loop only; unsupported in circuit and rooted power/control/loads views.",
    aliases: [],
    coreAliases: [],
    support: [
      {
        family: "signal-loop",
        role: "to",
        functions: LOOP_ENDPOINT_SHAPES,
        notes:
          "Selected two-terminal endpoint from an output channel; auxiliary supply pairs are optional selections.",
      },
    ],
  },
  {
    id: "thermite:bulkhead-connector",
    notes:
      "Signal-loop intermediate/auxiliary role only; unsupported as a circuit or rooted symbol.",
    aliases: [],
    coreAliases: [],
    support: [LOOP_INTERMEDIATE, LOOP_AUXILIARY],
  },
];
