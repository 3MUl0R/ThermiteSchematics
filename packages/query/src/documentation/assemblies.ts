import { buildConnectorAssemblyInventory } from "../connector-assemblies.js";
import {
  printedPortEndpoint,
  relationPrintIdentity,
} from "../print-projection.js";
import type { DocumentationContext } from "./context.js";
export function appendAssembly<T>(
  relation: ReturnType<
    typeof buildConnectorAssemblyInventory
  >["assemblies"][number],
  context: DocumentationContext<T>,
) {
  const { ir, devices, options, rows, reportDescription } = context;
  const a = relation.assembly,
    from = devices.get(relation.fromDeviceUid)!,
    to = devices.get(relation.toDeviceUid)!;
  rows.push({
    key: relation.uid,
    deviceUids: [from.uid, to.uid],
    cells: [
      relationPrintIdentity(relation, devices, options?.output).text,
      [
        a.kind,
        a.cable?.specification,
        a.cable?.manufacturer,
        a.cable?.orderNumber,
        a.cable?.lengthM === undefined ? undefined : `${a.cable.lengthM} m`,
        a.cable?.route,
        reportDescription(relation.description),
      ]
        .filter(Boolean)
        .join("\n"),
      [
        options?.output === "csv"
          ? `${from.designation}.${a.fromPort}`
          : printedPortEndpoint(ir, from.uid, a.fromPort, "identity"),
        from.location,
      ]
        .filter(Boolean)
        .join("\n"),
      [
        options?.output === "csv"
          ? `${to.designation}.${a.toPort}`
          : printedPortEndpoint(ir, to.uid, a.toPort, "identity"),
        to.location,
      ]
        .filter(Boolean)
        .join("\n"),
      `${a.status ?? "Status not specified"}\nPin mapping: ${a.pinMapping.status}\n${a.pinMapping.reason}`,
    ],
  });
}
export function documentationAssemblies<T>(context: DocumentationContext<T>) {
  const { ir, incident, options, rows, devices, table } = context;
  const inventory = buildConnectorAssemblyInventory(ir);
  for (const relation of inventory.assemblies) {
    if (!incident([relation.fromDeviceUid, relation.toDeviceUid])) continue;
    appendAssembly(relation, context);
  }
  for (const p of inventory.ports.filter(
    (p) => p.assemblyUid === null && incident([p.deviceUid]),
  ))
    rows.push({
      key: JSON.stringify([p.deviceUid, p.key]),
      deviceUids: [p.deviceUid],
      cells: [
        "--",
        p.definition.connector,
        [
          options?.output === "csv"
            ? `${p.designation}.${p.key}`
            : printedPortEndpoint(ir, p.deviceUid, p.key, "identity"),
          devices.get(p.deviceUid)!.location,
        ]
          .filter(Boolean)
          .join("\n"),
        "Unoccupied",
        "No assembly declared",
      ],
    });
  return table(
    "Connector assemblies and unoccupied ports",
    [
      "Assembly / cable",
      "Specification / description",
      "End A / location",
      "End B / location",
      "Status / pin mapping",
    ],
    [13, 25, 19, 19, 24],
    [
      "Assembly links reserve connector ports only; they do not create physical conductors or join electrical nets.",
      "Library pin descriptions do not supply a cable's missing pin mapping. Connector compatibility and installation remain engineering review items.",
      ...(rows.some((r) => !r.cells[0]?.trim())
        ? ["Blank assembly references need review against the source."]
        : []),
    ],
  );
}
