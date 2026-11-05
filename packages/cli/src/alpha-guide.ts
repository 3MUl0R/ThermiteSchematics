import { readFile } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import { DIAGNOSTIC_CATALOG, SYMBOL_PROFILES } from "@thermite/schema";
import type { Command } from "commander";

import type { GuideTopic } from "./guide-markdown.js";
export type { GuideTopic } from "./guide-markdown.js";

export const guideDirectory = fileURLToPath(
  new URL("../assets/guide", import.meta.url),
);
export async function guideTopics(): Promise<GuideTopic[]> {
  return JSON.parse(
    await readFile(
      new URL("../assets/guide/topics.json", import.meta.url),
      "utf8",
    ),
  );
}
/** Runtime provenance wins over build metadata; guide never shells out or fetches. */
export async function guideCommit(): Promise<string> {
  const modulePath = fileURLToPath(import.meta.url).replaceAll("\\", "/");
  if (modulePath.endsWith("/node_modules/@thermite/cli/dist/alpha-guide.js")) {
    const manifest = JSON.parse(
      await readFile(
        new URL("../../../../runtime-manifest.json", import.meta.url),
        "utf8",
      ),
    );
    if (
      manifest.format !== "thermite-runtime-release/0.1" ||
      !/^[a-f0-9]{40}$/.test(manifest.commit)
    )
      throw new Error("Invalid runtime guide provenance.");
    return manifest.commit;
  }
  const source = JSON.parse(
    await readFile(
      new URL("../assets/guide/source.json", import.meta.url),
      "utf8",
    ),
  );
  if (!/^[a-f0-9]{40}$/.test(source.commit))
    throw new Error("Invalid guide build provenance.");
  return source.commit;
}
async function topicMarkdown(
  topic: GuideTopic,
  topics: GuideTopic[],
  commit: string,
) {
  const sources = JSON.parse(
    await readFile(
      new URL("../assets/guide-source.json", import.meta.url),
      "utf8",
    ),
  );
  const { rewriteGuideLinks } = await import("./guide-markdown.js");
  return rewriteGuideLinks(sources[topic.id], topic, topics, commit);
}
const symbolText = () =>
  [
    "Profile | Aliases | Families / roles",
    "--- | --- | ---",
    ...SYMBOL_PROFILES.map(
      (p) =>
        `${p.id} | ${[...p.aliases, ...p.coreAliases.map((a) => a.symbol)].join(", ") || "—"} | ${p.support.map((s) => `${s.family}:${s.role}`).join(", ")}`,
    ),
    "Use --json for function shapes, constraints, notes and full support details.",
  ].join("\n") + "\n";
const diagnosticText = (code?: string) =>
  Object.entries(DIAGNOSTIC_CATALOG)
    .filter(([key]) => !code || code === key)
    .map(
      ([key, entry]) =>
        `${key} (${entry.severity}; ${entry.producer}) — ${entry.meaning}\n`,
    )
    .join("");
/** Routing only; these codes are intentionally outside the E/W/I catalog. */
export const diagnosticTopics: Readonly<Record<string, string>> = {
  R: "views",
  Q: "agent-requests",
  A: "agent-requests",
  T: "views",
};
const tokenEstimate = (text: string) =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 4);

const printJson = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
export function registerGuideCommand(command: Command): void {
  const guide = command
    .command("guide [topic]")
    .description(
      "read offline reference topics; lists read-before triggers and approximate tokens",
    )
    .option("--json", "print the index or catalog as JSON")
    .option(
      "--path",
      "print the directory of resolved, shipped Markdown topics",
    )
    .action(
      async (
        id: string | undefined,
        flags: { json?: boolean; path?: boolean },
      ) => {
        if (flags.path) {
          if (id || flags.json)
            throw new Error("Use guide --path without a topic or --json.");
          process.stdout.write(`${guideDirectory}\n`);
          return;
        }
        const topics = await guideTopics();
        if (id) {
          const topic = topics.find((t) => t.id === id);
          if (!topic)
            throw new Error(
              `Unknown guide topic ${JSON.stringify(id)}. Valid ids: ${topics.map((t) => t.id).join(", ")}. Also: symbols, diagnostics.`,
            );
          if (flags.json)
            throw new Error(
              "Topic output is Markdown; --json is for the index and catalogs.",
            );
          process.stdout.write(
            await topicMarkdown(topic, topics, await guideCommit()),
          );
          return;
        }
        const commit = await guideCommit();
        const index = await Promise.all(
          topics.map(async (topic) => ({
            id: topic.id,
            title: topic.title,
            readBefore: topic.readBefore,
            approximateTokens: tokenEstimate(
              await topicMarkdown(topic, topics, commit),
            ),
          })),
        );
        index.push({
          id: "symbols",
          title:
            "Symbol profiles, aliases and family support (--json for shapes)",
          readBefore: ["before selecting a symbol profile"],
          approximateTokens: tokenEstimate(symbolText()),
        });
        index.push({
          id: "diagnostics",
          title: "Compiler and validation diagnostics (E/W/I codes)",
          readBefore: ["before interpreting an E/W/I diagnostic"],
          approximateTokens: tokenEstimate(diagnosticText()),
        });
        if (flags.json)
          printJson(
            index.map((entry) => ({
              ...entry,
              tokenEstimateMethod: "default-text-utf8-bytes/4-ceil",
            })),
          );
        else {
          process.stdout.write(
            "Token estimates: served UTF-8 bytes / 4, rounded up; catalogs use text output.\n",
          );
          for (const t of index)
            process.stdout.write(
              `${t.id} — ${t.title} (~${t.approximateTokens} tokens)\n  ${t.readBefore.join("; ")}\n`,
            );
        }
      },
    );
  guide
    .command("symbols")
    .description(
      "list SYMBOL_PROFILES: aliases, function shapes and per-family support",
    )
    .option("--json", "print the catalog as JSON")
    .action((_flags, cmd: Command) => {
      if (cmd.optsWithGlobals().json) printJson(SYMBOL_PROFILES);
      else process.stdout.write(symbolText());
    });
  guide
    .command("diagnostics [code]")
    .description(
      "list compiler and validation diagnostics (E/W/I codes), or explain one",
    )
    .option("--json", "print the catalog or entry as JSON")
    .action((code: string | undefined, _flags, cmd: Command) => {
      code = code?.toUpperCase();
      if (code !== undefined && !Object.hasOwn(DIAGNOSTIC_CATALOG, code)) {
        const topic = diagnosticTopics[code[0] ?? ""];
        if (topic && /^[RAQT]\d{3}$/.test(code))
          throw new Error(
            `The diagnostic catalog covers E/W/I codes only. ${code} is outside that catalog; read thermite guide ${topic}.`,
          );
        throw new Error(
          `Unknown E/W/I diagnostic code ${JSON.stringify(code)}. Valid E/W/I codes: ${Object.keys(DIAGNOSTIC_CATALOG).join(", ")}. For R/T codes read thermite guide views; for A/Q codes read thermite guide agent-requests.`,
        );
      }
      const entries = Object.entries(DIAGNOSTIC_CATALOG).filter(
        ([key]) => code === undefined || code === key,
      );
      if (cmd.optsWithGlobals().json) printJson(Object.fromEntries(entries));
      else process.stdout.write(diagnosticText(code));
    });
}
