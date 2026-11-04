# Agent request examples (source alpha)

These six stateless JSON agent tools retain their existing request/result
contracts in the Bun alpha. The examples below are executed by
[`agents-guide.test.ts`](../packages/cli/test/agents-guide.test.ts); their JSON
requests also remain identical to the frozen legacy examples.

Build the source checkout before trusting CLI output. From the checkout root:

```sh
bun install --frozen-lockfile
bun run build
bun thermite.mjs init ../electrical-project
```

Use a new destination directory. Init writes the alpha project guide and a
visible `libraries/core` library. Read that generated guide before editing.
Then enter the initialized project and set the absolute path to your built
checkout's entry point (substitute your actual path):

```sh
cd ../electrical-project
thermite_entry=/absolute/path/to/ThermiteSchematics/thermite.mjs
```

PowerShell: set `$thermite_entry = 'C:/path/to/ThermiteSchematics/thermite.mjs'`; replace the POSIX `< resolve.request.json` input redirection with `Get-Content -Raw resolve.request.json | bun $thermite_entry agent resolve --input -`.

JSON project source is authoritative; SVG is generated output. Resolve objects
and topology before editing. Use this loop for each change:

```text
validate → resolve/inspect/query → dry-run patch → apply patch → validate → create-view
```

Each call compiles fresh. Keep requests in JSON files or pass them on standard
input with `--input -`. Preserve compiler diagnostics; never invent electrical
validity, suppress diagnostics, infer an automatic engineering repair, or invent
schematic geometry.

## Six executable agent commands

The examples below start in the initialized project directory and use `project: "."`.

### Validate

Save as `validate.request.json`:

```json
{
  "format": "agent-tool-request/0.1",
  "project": "."
}
```

```sh
bun "$thermite_entry" agent validate --input validate.request.json
```

Expected response: exit `0`; one `agent-tool-result/0.1` JSON object on stdout with `tool: "validate"` and `value.valid: true`; an `agent-tool-report/0.1` JSON object on stderr with no error.

### Resolve

Save as `resolve.request.json`:

```json
{
  "format": "agent-tool-request/0.1",
  "project": ".",
  "target": { "by": "designation", "value": "PS1" }
}
```

```sh
bun "$thermite_entry" agent resolve --input - < resolve.request.json
```

Expected response: exit `0`; stdout contains an `agent-tool-result/0.1` result resolving `PS1`; stderr contains the success report.

### Inspect

Save as `inspect.request.json`:

```json
{
  "format": "agent-tool-request/0.1",
  "project": ".",
  "selector": { "by": "designation", "value": "PS1" }
}
```

```sh
bun "$thermite_entry" agent inspect --input inspect.request.json
```

Expected response: exit `0`; stdout contains the canonical inspection of `PS1`; stderr contains the success report.

### Query

Save as `query.request.json`:

```json
{
  "format": "agent-tool-request/0.1",
  "project": ".",
  "query": {
    "operation": "net",
    "selector": {
      "by": "parts",
      "deviceDesignation": "PS1",
      "terminalKey": "+"
    }
  }
}
```

```sh
bun "$thermite_entry" agent query --input query.request.json
```

Expected response: exit `0`; stdout contains the derived `PS1.+` net result; stderr contains the success report.

### Apply a guarded source patch

Save this dry-run request as `patch-dry-run.request.json`:

```json
{
  "format": "agent-tool-request/0.1",
  "project": ".",
  "patchFormat": "json-patch/0.1",
  "dryRun": true,
  "files": [
    {
      "path": "devices/equipment.json",
      "expectedIntegrity": "sha256-VxO18aXXz5q4BY3r4k0bRGP8Ob1IAkJi9Tx34qBIARk=",
      "operations": [
        {
          "op": "test",
          "path": "/objects/0/description",
          "value": "480 VAC line-to-line to 24 VDC control power supply"
        },
        {
          "op": "replace",
          "path": "/objects/0/description",
          "value": "24 VDC starter control power supply"
        }
      ]
    }
  ]
}
```

```sh
bun "$thermite_entry" agent apply-source-patch --input patch-dry-run.request.json
```

Expected response: exit `0`; stdout reports `dryRun: true`; stderr contains the success report; no source byte changes.

After reviewing that response, copy the request to `patch-apply.request.json`, change only `"dryRun": true` to `"dryRun": false`, and apply it:

```sh
bun "$thermite_entry" agent apply-source-patch --input patch-apply.request.json
bun "$thermite_entry" agent validate --input validate.request.json
```

Expected response: both calls exit `0`; the patch result reports `dryRun: false`, and the second validation reports `valid: true`.

### Create a view

Save as `create-view.request.json`:

```json
{
  "format": "agent-tool-request/0.1",
  "project": ".",
  "spec": {
    "format": "schematic-view-request/0.2",
    "root": { "by": "designation", "value": "PS1" },
    "intent": { "kind": "loads" },
    "flow": "left-to-right"
  }
}
```

```sh
bun "$thermite_entry" agent create-view --input create-view.request.json
```

Expected response: exit `0`; stdout contains a result whose value includes the deterministic PS1 loads SVG and normalized view; stderr contains the success report. Write the returned SVG string to an ordinary `.svg` file without changing it.

## Split streams

After a tool dispatches successfully, stderr always carries the `agent-tool-report/0.1` report. On success only, stdout carries the `agent-tool-result/0.1` result. A failure has empty stdout and its report on stderr. Do not merge the streams before parsing them.

## Exit classification

- Exit `0`: success, including a result accompanied by compiler warnings.
- Exit `1`: authored validation, `A`, `Q`, or `R` expected failure.
- Exit `2`: command usage or tool/infrastructure failure.

## Engineering responsibility

Consume and preserve compiler diagnostics. Do not invent electrical validity, suppress a diagnostic, infer an automatic engineering fix, or invent schematic geometry in the agent. Change authoritative JSON only after resolving the objects and topology involved.

## Guarded JSON Patch rules

Use `json-patch/0.1`, include the current `expectedIntegrity` for every target, and dry-run first. A successful multi-file request is committed with per-file atomicity under the tool's guarded project-snapshot contract. The patch tool cannot create, delete, or rename files and cannot mutate the manifest, lock, or local/shipped library files.

## Presentation changes

The one referenced project presentation document, `presentation.json`, is patch-eligible like a project source document. Use the same integrity guard and dry-run-first process. `AGENTS.md` is not patch-eligible.

## Local libraries

Name/version-only library references are reserved for libraries shipped with Thermite Schematics. Author a local library with an explicit relative `path` in `system.json`; put its manifest in `library.json`, put its declared type sources below that directory, and run `bun "$thermite_entry" lock` after changing its bytes. The patch tool does not create or modify library files.

This contract does not provide MCP, natural-language tool inputs, persistent sessions, automatic engineering repairs, or library-file creation through `apply-source-patch`.
