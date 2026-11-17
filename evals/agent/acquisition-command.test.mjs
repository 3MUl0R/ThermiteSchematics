import { score } from "./score-log.mjs";
import { expect, it } from "vitest";
import { classifyToolCall } from "./github-call.mjs";
const allowedLibraryAcquisition = (input, allowedLibraryPaths) =>
  !!classifyToolCall(
    { name: "command_execution", input },
    { allowedLibraryPaths, engineRoots: ["/engine"] },
  ).libraryAcquisition;
const paths = ["libraries/field-interfaces", "libraries/industrial-pilot"];
const url =
  "https://raw.githubusercontent.com/BlackettApplied/ThermiteSchematics/fac3c43/libraries/field-interfaces/library.json";
it("recognizes library GETs followed by read-only local parts", () => {
  for (const command of [
    `curl --fail --silent --show-error '${url}' -o artifacts/library.json`,
    `curl '${url}' -o './artifacts/file with space.json'`,
    `gh api --method GET 'repos/BlackettApplied/ThermiteSchematics/contents/libraries/field-interfaces?ref=fac3c43' > artifacts/library.json`,
    `curl '${url}' -o artifacts/library.json; cat artifacts/library.json`,
    `curl '${url}' -o artifacts/library.json && cat artifacts/other.json`,
    `curl '${url}' -o artifacts/library.json && cat artifacts/library.json`,
    `curl '${url}' -o artifacts/library.json && jq '.' artifacts/library.json | sed -n '1,3p'`,
    `gh api 'repos/BlackettApplied/ThermiteSchematics/contents/libraries/field-interfaces' --jq '.[].name | select(.)'`,
  ])
    expect(allowedLibraryAcquisition(command, paths), command).toBe(true);
});
it("does not exempt extra reads, commands, writes, other paths or dynamic programs", () => {
  for (const command of [
    `curl '${url}' -o artifacts/library.json && cat /engine/packages/compiler/src/index.ts`,
    `curl '${url}' -o artifacts/library.json && cat artifacts/library.json && cat /engine/file`,
    `curl '${url}' | gh search code repo:BlackettApplied/ThermiteSchematics`,
    `curl -X POST '${url}'`,
    `gh api -f name=x '${url}'`,
    `curl --config /engine/config '${url}'`,
    `curl '${url}' -o artifacts/library.json && cat $(cat /engine/file)`,
    `python -c "fetch('${url}')"`,
    `curl '${url.replace("libraries/field-interfaces/library.json", "packages/compiler/src/index.ts")}'`,
  ])
    expect(allowedLibraryAcquisition(command, paths), command).toBe(false);
});

it("completed web-search requests remain visible after empty start events", () => {
  const item = { id: "web", type: "web_search" };
  const metric = (url) =>
    score({
      allowedLibraryPaths: paths,
      transcript: [
        {
          type: "item.started",
          item: { ...item, query: "", action: { type: "other" } },
        },
        {
          type: "item.completed",
          item: { ...item, query: url, action: { type: "open_page", url } },
        },
      ],
    });
  expect(metric(url).sourceReads).toBe(0);
  expect(
    metric(
      "https://github.com/BlackettApplied/ThermiteSchematics/blob/fac3c43/libraries/field-interfaces/README.md",
    ).sourceReads,
  ).toBe(0);
  expect(metric(url).libraryAcquisitions).toHaveLength(1);
  expect(
    metric(
      url.replace(
        "libraries/field-interfaces/library.json",
        "packages/compiler/src/index.ts",
      ),
    ).sourceReads,
  ).toBe(1);
});
