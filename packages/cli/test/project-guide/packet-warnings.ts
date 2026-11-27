import { expect } from "vitest";
import { ctx, packet } from "./harness.js";

interface PacketDiagnostic {
  readonly code: string;
  readonly message?: string;
  readonly devices?: readonly {
    readonly designation: string;
    readonly appearance: string;
  }[];
}

const W906_REQUEST = {
  format: "schematic-packet-request/0.1",
  views: [
    {
      format: "circuit-view-request/0.1",
      title: "Supply only",
      groups: [
        {
          id: "supply",
          conductors: [],
          functions: [
            { device: { by: "designation", value: "PS1" }, key: "dc_output" },
          ],
        },
      ],
    },
    { format: "documentation-view-request/0.1", kind: "bom" },
  ],
};

const W908_REQUEST = {
  format: "schematic-packet-request/0.1",
  views: [
    {
      format: "circuit-view-request/0.1",
      title: "Supply key label",
      groups: [
        {
          id: "supply",
          label: "dc_output",
          conductors: [],
          functions: [
            { device: { by: "designation", value: "PS1" }, key: "dc_output" },
            { device: { by: "designation", value: "PLC1" }, key: "do0" },
          ],
        },
      ],
    },
  ],
};

function diagnosticList(value: unknown): PacketDiagnostic[] {
  return Array.isArray(value) ? value : [];
}

async function checkW906(project: string) {
  for (const strict of [false, true]) {
    const reports = await packet(
      ctx.pristine.cabinets,
      {
        format: "schematic-packet-request/0.1",
        views: [{ format: "documentation-view-request/0.1", kind: "bom" }],
      },
      ["--json", ...(strict ? ["--strict"] : [])],
    );
    expect(reports.code).toBe(0);
    expect(JSON.parse(reports.stdout).coverage.diagnostics ?? []).toEqual([]);
  }
  for (const strict of [false, true]) {
    const run = await packet(project, W906_REQUEST, [
      "--json",
      ...(strict ? ["--strict"] : []),
    ]);
    expect(run.code).toBe(strict ? 1 : 0);
    const warning = diagnosticList(JSON.parse(run.stderr).diagnostics).find(
      (d) => d.code === "W906",
    );
    expect(warning?.devices?.map((d) => d.designation)).toEqual(["PLC1"]);
    expect(
      warning?.devices?.every((d) => d.appearance === "reports-only"),
    ).toBe(true);
  }
}

async function checkW908(project: string) {
  for (const strict of [false, true]) {
    const run = await packet(project, W908_REQUEST, [
      "--json",
      ...(strict ? ["--strict"] : []),
    ]);
    expect(run.code).toBe(strict ? 1 : 0);
    const warning = diagnosticList(JSON.parse(run.stderr).diagnostics).find(
      (d) => d.code === "W908",
    );
    expect(warning?.message).toContain('"dc_output"');
    if (!strict) {
      const coverage = diagnosticList(
        JSON.parse(run.stdout).coverage.diagnostics,
      );
      expect(coverage.map((d) => d.code)).toEqual(["W908"]);
    }
  }
}

export async function checkPacketWarnings() {
  const project = ctx.pristine.starter;
  await checkW906(project);
  await checkW908(project);
}
