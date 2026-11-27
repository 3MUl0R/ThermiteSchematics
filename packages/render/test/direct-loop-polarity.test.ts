import {
  withoutRouteOwnershipMetadata,
  withoutTerminalCaptionOwnership,
} from "./helpers/route-ownership.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  compileProject,
  lockProject,
  type ElectricalIr,
} from "@thermite/compiler";
import { renderSchematicPacket } from "../src/sheets.js";

const flows = ["left-to-right", "top-to-bottom"] as const;
let root: string;
const fixtures = new Map<boolean, ElectricalIr>();

/** Remove only the new composition wrapper; preserve all reviewed native bytes. */
function withoutViewWrapper(svg: string): string {
  const start = svg.indexOf('<g data-navigation-view="');
  if (start < 0) throw Error("Missing packet view wrapper");
  const content = svg.indexOf(">", start) + 1;
  let depth = 0;
  for (const match of svg.slice(start).matchAll(/<\/?g\b[^>]*>/gu)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      const end = start + match.index;
      return (
        svg.slice(0, start) +
        svg.slice(content, end) +
        svg.slice(end + match[0].length)
      );
    }
  }
  throw Error("Unclosed packet view wrapper");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "thermite-direct-polarity-85-"));
  await writeFile(
    join(root, "system.json"),
    JSON.stringify({
      format: "electrical-system/0.1",
      project: { name: "Issue 85 core 0.2.0 reproduction" },
      sources: ["source.json"],
      libraries: [{ name: "core", version: "0.2.0" }],
    }),
  );
  const uid = (n: number) =>
    `85000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  for (const reversed of [false, true]) {
    await writeFile(
      join(root, "source.json"),
      JSON.stringify({
        objects: [
          {
            kind: "device",
            uid: uid(1),
            designation: "TX1",
            type: "core:transmitter-2wire-4-20ma",
          },
          {
            kind: "device",
            uid: uid(2),
            designation: "PLC1",
            type: "core:plc-8di-8do-2ai",
          },
          ...["+", "-"].map((terminal, i) => ({
            kind: "wire",
            uid: uid(3 + i),
            designation: `W${i + 1}`,
            endpoints: [
              { device: "TX1", terminal },
              {
                device: "PLC1",
                terminal: `AI0${reversed ? (i === 0 ? "-" : "+") : terminal}`,
              },
            ],
          })),
        ],
      }),
    );
    const locked = await lockProject(root);
    expect(locked.ok, JSON.stringify(locked.diagnostics)).toBe(true);
    const compiled = await compileProject(root);
    if (!compiled.ok) throw Error(JSON.stringify(compiled.diagnostics));
    expect(
      compiled.diagnostics
        .filter((d) => d.severity === "warning")
        .map((d) => d.code),
    ).toEqual(["W903"]);
    fixtures.set(reversed, compiled.ir);
  }
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function packet(flow: (typeof flows)[number]) {
  return {
    format: "schematic-packet-request/0.1" as const,
    page: {
      size: "tabloid" as const,
      orientation:
        flow === "top-to-bottom"
          ? ("portrait" as const)
          : ("landscape" as const),
    },
    views: [
      {
        format: "signal-loop-view-request/0.1" as const,
        from: { device: "TX1", function: "signal" },
        to: { device: "PLC1", function: "ai0" },
        flow,
      },
    ],
  };
}

it.each(flows)(
  "keeps the correctly wired core direct loop printable in %s",
  async (flow) => {
    const ir = fixtures.get(false)!;
    const before = JSON.stringify(ir);
    const result = await renderSchematicPacket(ir, packet(flow));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      const svg = result.value.sheets[0]!.svg;
      expect(svg).toContain('data-layout-source-port="');
      expect(svg).toContain('data-layout-port="');
      expect(svg).toContain('data-terminal-body="n0"');
      expect(svg).toContain('data-terminal-body="n1"');
      // Pin the literal-floor drawing while allowing additive route and caption ownership.
      const reviewedSvg = withoutTerminalCaptionOwnership(
        withoutRouteOwnershipMetadata(withoutViewWrapper(svg)),
      );
      expect(result.value.sheets[0]!.svg).toContain("Two separate signal nets");
      expect(result.value.sheets[0]!.svg).not.toContain(
        "polarity not verified",
      );
      // Pin the reviewed direct-loop output, including its semantic channel caption,
      // additive data-terminal-body tokens (#599, #626), and RL1 data-text-role (#642;
      // byte-identical after stripping data-text-role).
      expect(createHash("sha256").update(reviewedSvg).digest("hex")).toBe(
        flow === "left-to-right"
          ? "ef7ee5c6d92800b3610c5ba4026398afc42e0430385953b8c6cd3aa842dd37cf"
          : "343ffcfbb2505773941d53306f3dda912e66f69ac913fc25978decad2e6a3e56",
      );
      // Pin the complete measured-tag drawing independently of tag ownership metadata
      // (refreshed for #599, #626, and additive RL1 data-text-role from #642).
      expect(
        createHash("sha256")
          .update(reviewedSvg.replace(/ data-tag-[a-z-]+="[^"]*"/gu, ""))
          .digest("hex"),
      ).toBe(
        flow === "left-to-right"
          ? "de680ab80a6f725ee7c4a295d9bb8dd63e91d7a0309e788b84bfa932540c6d81"
          : "258e61cc7b80ad76fb8c4fca9b3821dcd2344389a0efc9018451c0403108d0d4",
      );
    }
    expect(JSON.stringify(ir)).toBe(before);
  },
);

// The issue's actual core 0.2.0 wiring must fail before emitting a sheet.
it.each(flows)(
  "refuses issue 85's reversed core direct loop in %s",
  async (flow) => {
    const ir = fixtures.get(true)!;
    const before = JSON.stringify(ir);
    const result = await renderSchematicPacket(ir, packet(flow));
    expect(JSON.stringify(ir)).toBe(before);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "R006",
        reason: "unprintable-layout",
        message:
          'Packet view[0] "TX1 - signal loop": Signal loop polarity: TX1.+ (loop_positive) reaches PLC1.AI0- (analog_input_0_negative); correct the wiring or the authored roles.',
      },
    });
    expect(result).not.toHaveProperty("value");
  },
);
