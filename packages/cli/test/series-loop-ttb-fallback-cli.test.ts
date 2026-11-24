import { execFile as execFileCb } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { RenderedPacket } from "@thermite/render";
import { drawingDiagnostics } from "../src/alpha-export-artifact.js";
import {
  request,
  seriesFixture,
  type SeriesModel,
  uid,
  wire,
} from "../../render/test/series-loop-fixture.js";

const execFile = promisify(execFileCb);
const cli = resolve("thermite.mjs");
const NOTICE =
  "Rendered left-to-right to fit landscape sheet at readable size (top-to-bottom requested).";

function fiveStageHighSide(model: SeriesModel) {
  model.objects = model.objects.filter(
    (o) => ![uid(11), uid(12)].includes(o.uid) && o.designation !== "PLC1",
  );
  model.objects.push(
    { kind: "device", uid: uid(41), designation: "TB2", type: "series:strip" },
    wire(101, "AI1", "n", "TB1", "1"),
    wire(102, "TB1", "1", "TB2", "1"),
    wire(103, "TB2", "1", "TX1", "p"),
    wire(104, "TX1", "n", "TB2", "2"),
    wire(105, "TB2", "2", "TB1", "2"),
    wire(106, "TB1", "2", "PS1", "n"),
  );
}

async function runCli(args: string[]) {
  try {
    const result = await execFile(process.execPath, [cli, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const rec =
      typeof error === "object" && error !== null
        ? Object.fromEntries(Object.entries(error))
        : {};
    return {
      code: typeof rec.code === "number" ? rec.code : 1,
      stdout: typeof rec.stdout === "string" ? rec.stdout : "",
      stderr: typeof rec.stderr === "string" ? rec.stderr : "",
    };
  }
}

async function writeLoopPacketRequest(root: string, index: boolean) {
  const reqPath = join(root, "packet.request.json");
  await writeFile(
    reqPath,
    JSON.stringify({
      format: "schematic-packet-request/0.1",
      index,
      page: { size: "tabloid", orientation: "landscape" },
      views: [request({ flow: "top-to-bottom" })],
    }),
  );
  return reqPath;
}

describe("series loop LTR fallback CLI and export diagnostics", () => {
  it("reports I907 in packet JSON and CLI stderr and exits 0 under --strict", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const reqPath = await writeLoopPacketRequest(f.root, true);
      const jsonOut = join(f.root, "packet.json");
      const jsonRun = await runCli([
        "packet",
        "--project",
        f.root,
        "--input",
        reqPath,
        "--strict",
        "-o",
        jsonOut,
      ]);
      expect(jsonRun.code, jsonRun.stderr).toBe(0);
      const stderrReport: {
        diagnostics: Array<{ code: string; severity: string; message: string }>;
        error: unknown;
      } = JSON.parse(jsonRun.stderr);
      expect(stderrReport.error).toBeNull();
      expect(stderrReport.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "I907",
          severity: "info",
          message: `View 1 "TX1 - signal loop": ${NOTICE}`,
        }),
      );
      const packet: RenderedPacket = JSON.parse(
        await readFile(jsonOut, "utf8"),
      );
      expect(packet.coverage.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "I907",
          severity: "info",
          file: "system.json",
          message: `View 1 "TX1 - signal loop": ${NOTICE}`,
        }),
      );
    } finally {
      await f.dispose();
    }
  });

  it("emits I907 on stderr and prints the notice for HTML and PDF packet exports", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const reqPath = await writeLoopPacketRequest(f.root, true);
      const htmlOut = join(f.root, "packet.html");
      const htmlRun = await runCli([
        "packet",
        "--project",
        f.root,
        "--input",
        reqPath,
        "-o",
        htmlOut,
      ]);
      expect(htmlRun.code, htmlRun.stderr).toBe(0);
      expect(htmlRun.stderr).toContain("I907");
      expect(htmlRun.stderr).toContain(NOTICE);
      expect(await readFile(htmlOut, "utf8")).toContain(NOTICE);

      const pdfOut = join(f.root, "packet.pdf");
      const pdfRun = await runCli([
        "packet",
        "--project",
        f.root,
        "--input",
        reqPath,
        "-o",
        pdfOut,
      ]);
      expect(pdfRun.code, pdfRun.stderr).toBe(0);
      expect(pdfRun.stderr).toContain("I907");
      const pdfBytes = await readFile(pdfOut);
      expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    } finally {
      await f.dispose();
    }
  });

  it("retains I907 through drawingDiagnostics for both packet and view export kinds", async () => {
    const f = await seriesFixture(fiveStageHighSide, true);
    try {
      const reqPath = join(f.root, "packet.request.json");
      const jsonOut = join(f.root, "packet.json");
      await writeFile(
        reqPath,
        JSON.stringify({
          format: "schematic-packet-request/0.1",
          index: false,
          page: { size: "tabloid", orientation: "landscape" },
          views: [request({ flow: "top-to-bottom" })],
        }),
      );
      const run = await runCli([
        "packet",
        "--project",
        f.root,
        "--input",
        reqPath,
        "-o",
        jsonOut,
      ]);
      expect(run.code, run.stderr).toBe(0);
      const packet: RenderedPacket = JSON.parse(
        await readFile(jsonOut, "utf8"),
      );
      const mixed: RenderedPacket = {
        ...packet,
        coverage: {
          ...packet.coverage,
          diagnostics: [
            ...(packet.coverage.diagnostics ?? []),
            {
              code: "W906",
              severity: "warning",
              file: "system.json",
              line: 1,
              column: 1,
              jsonPointer: "/project",
              message: "synthetic coverage warning",
            },
          ],
        },
      };
      expect(drawingDiagnostics(mixed, "packet").map((d) => d.code)).toEqual([
        "I907",
        "W906",
      ]);
      expect(drawingDiagnostics(mixed, "view").map((d) => d.code)).toEqual([
        "I907",
      ]);
    } finally {
      await f.dispose();
    }
  });
});
