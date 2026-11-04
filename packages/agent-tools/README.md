# `@thermite/agent-tools`

This private package is the narrow typed agent boundary over the compiler, query
engine, and renderer. `createAgentTools({ cwd })` creates one stateless toolbox;
every call loads and compiles the requested project fresh. The request's non-empty
`project` is resolved relative to that fixed cwd with compiler semantics.

The package accepts no cached IR, loaded-project object, query engine, renderer
callback, or filesystem callback. Import only from `@thermite/agent-tools`;
implementation subpaths are not public.

## Six typed tools

Every request is a closed object extending
`{ format: "agent-tool-request/0.1", project: string }`.

| Method             | Request-specific field                                         | Success value                      | Expected failure type                                       |
| ------------------ | -------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `resolve`          | `target`: exact `uid`/`designation`, or search `type`/`text`   | `ResolveObjectsValue`              | `QueryError \| AgentToolError`                              |
| `inspect`          | `selector`: exact UID or designation                           | query-owned `InspectResult`        | `QueryError \| AgentToolError`                              |
| `query`            | `query`: `neighbors`, `trace`, `net`, or `cable` plus selector | `GraphQueryValue`                  | `QueryError \| AgentToolError`                              |
| `validate`         | no additional field                                            | `{ valid: true }`                  | `AgentToolError` or compiler diagnostics with `error: null` |
| `createView`       | `spec`: public renderer `SchematicViewRequest`                 | renderer-owned `RenderedSchematic` | `QueryError \| RenderError \| AgentToolError`               |
| `applySourcePatch` | `patchFormat`, `dryRun`, and `files`                           | `ApplySourcePatchValue`            | `AgentToolError` or compiler diagnostics with `error: null` |

Each promise returns `AgentToolOutcome<Value, Failure>`. Success contains `ok`,
compiler `diagnostics`, and `value`. Failure contains `ok`, `diagnostics`,
`error`, and in-process-only `failureClass`. Values are recursively detached and
frozen.

```ts
import { createAgentTools } from "@thermite/agent-tools";

const tools = createAgentTools({ cwd: process.cwd() });
const base = {
  format: "agent-tool-request/0.1" as const,
  project: "examples/motor-starter",
};

const resolved = await tools.resolve({
  ...base,
  target: { by: "text", value: "limit" },
});
const inspected = await tools.inspect({
  ...base,
  selector: { by: "designation", value: "LS1" },
});
const queried = await tools.query({
  ...base,
  query: {
    operation: "net",
    selector: {
      by: "parts",
      deviceDesignation: "PLC1",
      terminalKey: "X1.0",
    },
  },
});
const validated = await tools.validate(base);
const viewed = await tools.createView({
  ...base,
  spec: {
    format: "schematic-view-request/0.2",
    root: { by: "designation", value: "PS1" },
    intent: { kind: "loads" },
  },
});
```

Compiler warnings remain warnings in every successful outcome. Callers consume
diagnostics rather than reproduce or reinterpret engineering checks.

## Resolution, queries, validation, and views

Exact UID/designation resolution delegates to the query engine. Type search covers
device and cable instances. Text search is case-sensitive JavaScript code-unit
matching over designation, potential name, UID, aliases, type ID, and description,
with deterministic rank and tie-breaking. There is no fuzzy match, confidence score,
pagination, locale folding, or implicit terminal/function indexing.

Inspection is the existing one-hop query projection. The graph-query subset is only
`neighbors`, `trace`, `net`, and `cable` with the public query selectors and
DTOs unchanged. It adds no predicate language, arbitrary traversal, direction,
filter, projection, sort, or limit.

Validation is exactly one fresh `compileProject` call. A clean compile returns
`{ valid: true }`; warnings accompany success. Compiler errors produce a failed
outcome with diagnostics and `error: null`, never `valid: false`.

`createView` accepts the renderer's `schematic-view-request/0.1` and
`schematic-view-request/0.2` union verbatim. It passes the successful compiler's
detached `project-presentation/0.1` context to the renderer, so the SVG receives the
authored/default canvas and title identity. Agent tools add no view syntax, intent
inference, selection rule, geometry, or renderer error.

## Integrity-guarded source patches

`applySourcePatch` accepts only `patchFormat: "json-patch/0.1"`, a required
`dryRun` boolean, and a non-empty file list. Each file supplies a current
`sha256-<base64>` integrity and an ordered non-empty list of `test`, `add`,
`remove`, or `replace` operations. Root mutation, `move`, `copy`, and arbitrary
filesystem edits are not supported.

```json
{
  "format": "agent-tool-request/0.1",
  "project": "examples/motor-starter",
  "patchFormat": "json-patch/0.1",
  "dryRun": true,
  "files": [
    {
      "path": "presentation.json",
      "expectedIntegrity": "sha256-<current-base64-digest>",
      "operations": [
        { "op": "test", "path": "/revision", "value": "A" },
        { "op": "replace", "path": "/revision", "value": "B" }
      ]
    }
  ]
}
```

The only eligible document kinds are existing manifest-matched
`project_source` and the one referenced `project_presentation`. The target map uses
each loader-owned exact `document.file`. The manifest, lock, `AGENTS.md`, local and
shipped library bytes, absent presentation, new paths, deleted paths, and renamed
paths remain ineligible.

Dry-run never writes project source or acquires a writer reservation. Apply writes
only changed proposals in stable file order.
Successful multi-file requests provide per-file atomic replacement, not a crash-atomic
project transaction. A process or machine crash between replacements may leave a
partial batch.

After staging, apply exclusively creates `.thermite-schematics-write.lock` with
`wx` in the canonical project root. Directory and manifest paths share the
reservation. It remains held through the fresh load, snapshot comparison,
replacements, and rollback. Contention returns **A005/exit 1**, with `lockPath`,
`owner` (`pid`, `hostname`, `createdAt`, `thermiteVersion`), `ageMs`, and
`ownerState` (`alive`, `not-running`, `other-host`, or `unknown`). The version is
that of the installed engine package. A004 remains reserved for integrity drift.
After a competing edit, re-inspect the project and rebuild the patch, including
its operations and guards; copying a new integrity alone is insufficient.

There is no automatic reclamation. A same-host PID that is no longer running
indicates an apparently abandoned reservation. Confirm all project writers have
stopped, then remove the exact `lockPath` reported by A005. A live/reused PID,
another hostname, missing metadata, or permission-denied liveness check does not
establish abandonment; inspect the owning host/process first. Age alone never
authorizes removal. Empty or malformed reservations also fail closed.

The reservation is runtime state, excluded from source glob expansion (including
explicit dotfile patterns), tree scans, staging copies, and source snapshots.
Regular atomic writer temporary files are excluded from tree scans and copies;
directories and symlinks with those names remain subject to path checks.
Validation works while a reservation is held. Never commit the reservation; add
`.thermite-schematics-write.lock` to the project's `.gitignore`. Alpha `init`
creates this minimal ignore file; existing projects must add the entry themselves.

Normal outcomes close and remove owned reservations, closing first on Windows.
On POSIX, cleanup handlers are installed only for SIGINT/SIGTERM/SIGHUP that
have no existing listener. They synchronously revoke and release held reservations.
The signal is re-raised only if no host listener is present. Existing embedding
host handlers retain control; a host listener added after acquisition receives the
signal once and revoked reservations fail closed at commit and restore guards. SIGKILL, machine failure, and Windows forced process
termination cannot run cleanup and may leave metadata for explicit recovery.
If release fails after commit, success and `applied` are preserved (exit 0), with
**W801** naming the exact reservation path and confirming the changes were
committed. Verify that state; do not replay the patch. Once this command has
exited and no other writer is running, it is safe to remove its leftover
reservation. If both apply and release fail, the failure diagnostic also names
the exact leftover path. A changed lock/root identity
is reported rather than deleting an unowned entry.

The guard snapshots the manifest, optional presentation, every source, lock state,
and local library manifests/sources. Shipped library files are deliberately excluded
from the project-controlled A004 snapshot based only on
`resolutionKind: "shipped"`; their lock is still verified on every compile under
the immutable installed-package premise. `AGENTS.md` is not a patch target or A004
content record, but a link/junction replacement is rejected by the ordinary-entry
scan.

Staging uses an exclusive ordinary sibling, validates the complete copied project,
rechecks the guarded project state, and commits guarded replacements. Paths, links,
junctions, reparse points, ancestor changes, duplicate targets, and integrity drift
produce the existing deterministic A-errors. Vanished, moved, or unresolvable
source chains (ENOENT/ENOTDIR/ELOOP) are A003; other guard I/O errors remain
tool failures with their original sanitized cause. Before every rollback restore, the
tool rechecks the original directory identities, source path chain, and expected
post-commit bytes. Replacing a target with identical bytes remains safe. The atomic writer repeats the guard
before creating its temporary file and before replacement. Changed chains or
content are not restored; an incomplete rollback lists the exact restored and
unrestored files plus each refusal reason (chain changed, content changed, or I/O)
in diagnostics and returns a tool failure (exit 2), retaining the primary error. Cleanup remains bounded and identity-guarded; no recursive
ownership of a pre-existing path is inferred. These are cooperating-writer and
checked-path guarantees: portable path-based filesystem calls do not provide a
transaction against an actor swapping ancestors between the final check and an
OS write/rename operation.

## Diagnostics and serialization

Malformed requests are A001. Invalid patch operations are A002, unsafe or ineligible
targets are A003, guarded integrity drift is A004, and write reservation contention
is A005. W801 warns of reservation release failure after a successful patch. Query failures remain
Q001-Q004. Renderer failures remain R001-R005, including `render/0.3` title-text
preflight. Authored compiler diagnostics retain normalized logical paths.

`failureClass: "expected"` identifies authored compiler, A-, Q-, or R-failures;
`"tool"` identifies I/O, compiler tool, staging, write/rollback, invariant, and
unexpected failures. It is absent from serialized envelopes.

`serializeAgentToolResult` emits `agent-tool-result/0.1`.
`serializeAgentToolReport` emits `agent-tool-report/0.1`. CLI success writes the
result on stdout and a report with `error: null` on stderr. Failure writes no partial
result and only the report. Serialization fixes field order, two-space indentation,
LF, one final newline, and no ANSI.

Ordinary outcomes retain canonical serialization and deterministic source behavior.
A005 intentionally includes runtime owner metadata, age, and the exact reservation
path; W801 includes that path when cleanup needs operator attention. Redact
hostnames and absolute paths before sharing these diagnostics. Cwd, staging
names, locale, timezone, and enumeration order do not otherwise enter output.

There is no MCP server, natural-language transport, HTTP service, daemon, plugin
protocol, cache, or long-lived project session.

Source-patch serialization rejects nesting deeper than 4,096 levels before
allocating formatted output or staging files. This resource limit makes the
sanitized serialization failure deterministic across JavaScript runtimes.
