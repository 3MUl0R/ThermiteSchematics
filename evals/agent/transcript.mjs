import {
  infrastructureSignal,
  retryTimestamp,
  knownAgentError,
} from "./event-errors.mjs";
import { terminalProtocol } from "./cli-protocol.mjs";
function webLookup(events, item) {
  const event = events.find((e) => e.type === "tool" && e.id === item.id);
  if (!event) return;
  if (
    item.action?.type === "open_page" &&
    typeof item.action.url === "string"
  ) {
    event.input = item.action.url;
    event.lookupKind = "fetch";
  } else if (
    item.action?.type === "search" &&
    typeof item.action.query === "string"
  ) {
    event.input = item.action.query;
    delete event.lookupKind;
  } else if (!event.input) {
    event.input = item.query || item.action?.url || item.action?.query;
  }
}
function parseTranscriptRows(input, parseWarnings) {
  if (typeof input !== "string") return input ?? [];
  return input.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      parseWarnings.push({ line: index + 1, kind: "non-json-event" });
      return [];
    }
  });
}
function createTranscriptState(now, agent, cliVersion) {
  return {
    now,
    agent,
    cliVersion,
    events: [],
    tools: new Set(),
    messages: new Map(),
    finalMessage: "",
    resultUsage: null,
    modelUsage: null,
    reportedCostUSD: null,
    hasCompletion: false,
    terminalError: false,
    agentError: false,
    infrastructureError: null,
    codexUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    issues: [],
    position: 0,
    lastSuccess: -1,
    successfulCompletion: false,
    infrastructureKind: null,
    retryAt: null,
    recoveredThrough: -1,
    needsAdjudication: false,
    terminalTemplate: null,
  };
}
function clearCause(state) {
  state.infrastructureError = null;
  state.infrastructureKind = null;
  state.retryAt = null;
  state.agentError = false;
  state.needsAdjudication = false;
  state.terminalTemplate = null;
}
function recordProgress(state) {
  if (state.terminalError) {
    state.terminalError = false;
    state.hasCompletion = false;
  }
  state.recoveredThrough = state.position;
  clearCause(state);
}
function classifyTranscriptError(
  state,
  error,
  { replace = false, protocol = null } = {},
) {
  const signal =
    infrastructureSignal(error) ??
    (protocol && protocol.kind !== "agent" ? protocol : null);
  const isAgent =
    protocol?.kind === "agent" || (!signal && knownAgentError(error));
  if (replace || isAgent) clearCause(state);
  const nextReset = retryTimestamp(error, state.now);
  state.retryAt =
    state.retryAt && nextReset
      ? Math.max(state.retryAt, nextReset)
      : (state.retryAt ?? nextReset);
  const strength = (kind) =>
    ({ billing: 4, quota: 3, "rate-limit": 2 })[kind] ?? 1;
  if (signal) {
    const kind =
      signal.kind === "rate-limit" && state.retryAt - state.now > 15 * 60000
        ? "quota"
        : signal.kind;
    if (
      !state.infrastructureError ||
      strength(kind) >= strength(state.infrastructureKind)
    ) {
      state.infrastructureError = signal.code;
      state.infrastructureKind = kind;
    }
    state.agentError = false;
    state.needsAdjudication = false;
  } else if (!state.infrastructureError) {
    state.agentError = isAgent;
    state.needsAdjudication = !isAgent;
  }
  if (protocol)
    state.terminalTemplate = { id: protocol.id, version: protocol.version };
  state.issues.push({
    position: state.position,
    type: "retry",
    kind: signal?.kind ?? "unstructured",
    code: signal?.code ?? null,
  });
}
function handleRateLimitRow(state, row) {
  if (!["rate_limit", "rate_limit_event"].includes(row.type)) return;
  const limitInfo = row.rate_limit_info ?? row.rateLimitInfo ?? {};
  const usingOverage =
    limitInfo.isUsingOverage === true ||
    limitInfo.overageInUse === true ||
    (limitInfo.isUsingOverage == null &&
      limitInfo.overageInUse == null &&
      ["allowed", "allowed_warning"].includes(limitInfo.overageStatus));
  if (
    usingOverage &&
    ["quota", "rate-limit"].includes(state.infrastructureKind)
  )
    recordProgress(state);
  if (
    !["allowed", "allowed_warning"].includes(limitInfo.status) &&
    !usingOverage
  )
    classifyTranscriptError(state, {
      ...row,
      type:
        limitInfo.status === "rejected" ? "usage_limit_exceeded" : "rate_limit",
    });
}
function handleAssistantRow(state, row) {
  if (!row.error && row.message?.content?.length) recordProgress(state);
  if (row.error)
    classifyTranscriptError(state, {
      ...row,
      error: typeof row.error === "string" ? { type: row.error } : row.error,
    });
  const id = row.message?.id ?? row.uuid ?? `message-${state.messages.size}`,
    u = row.message?.usage;
  if (u) {
    const old = state.messages.get(id) ?? {};
    state.messages.set(
      id,
      Object.fromEntries(
        [
          "input_tokens",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "output_tokens",
        ].map((k) => [k, Math.max(old[k] ?? 0, u[k] ?? 0)]),
      ),
    );
  }
  const text = [];
  for (const block of row.message?.content ?? []) {
    if (block.type === "tool_use" && !state.tools.has(block.id)) {
      state.tools.add(block.id);
      state.events.push({
        type: "tool",
        id: block.id,
        name: block.name,
        input: block.input,
        time: row.timestamp ?? null,
      });
    }
    if (block.type === "text") {
      text.push(block.text);
      state.events.push({ type: "message", text: block.text });
    }
  }
  if (text.length) state.finalMessage = text.join("\n");
}
function handleUserRow(state, row) {
  if (row.message?.content?.some((b) => b.type === "tool_result"))
    recordProgress(state);
  for (const block of row.message?.content ?? [])
    if (block.type === "tool_result")
      state.events.push({
        type: "tool-result",
        id: block.tool_use_id,
        output: block.content,
        toolError: block.is_error === true,
      });
}
function hasTypedError(value) {
  if (typeof value === "string") {
    try {
      return hasTypedError(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(hasTypedError);
  return (
    !!value &&
    typeof value === "object" &&
    (value.code ||
      value.type ||
      value.codex_error_info ||
      value.codexErrorInfo ||
      hasTypedError(value.error))
  );
}
function handleResultRow(state, row) {
  const pending =
    (state.infrastructureError ||
      state.needsAdjudication ||
      state.agentError) &&
    ["success", "error_during_execution"].includes(row.subtype) &&
    !hasTypedError(row.error ?? row.errors)
      ? {
          infrastructureError: state.infrastructureError,
          infrastructureKind: state.infrastructureKind,
          retryAt: state.retryAt,
          needsAdjudication: state.needsAdjudication,
          agentError: state.agentError,
        }
      : null;
  const terminal = {
    ...row,
    error: row.errors?.length
      ? row.errors
      : (row.error ?? { type: row.subtype }),
  };
  // Another infra row stays in the same no-progress window. A specific
  // agent/unknown terminal identity still replaces the pending cause.
  if (!pending && !infrastructureSignal(terminal)) clearCause(state);
  state.hasCompletion = true;
  state.finalMessage = row.result ?? state.finalMessage;
  state.resultUsage = row.usage ?? null;
  state.modelUsage = row.modelUsage ?? null;
  state.reportedCostUSD = row.total_cost_usd ?? null;
  if (row.is_error || (row.subtype && row.subtype !== "success")) {
    state.terminalError = true;
    state.successfulCompletion = false;
    classifyTranscriptError(state, terminal);
    if (!state.infrastructureError && pending) {
      state.infrastructureError = pending.infrastructureError;
      state.infrastructureKind = pending.infrastructureKind;
      state.retryAt = pending.retryAt;
      state.needsAdjudication = pending.needsAdjudication;
      state.agentError = pending.agentError;
    }
  } else {
    state.terminalError = false;
    state.successfulCompletion = true;
    state.lastSuccess = state.position;
    recordProgress(state);
  }
}
function handleErrorOrFailureRow(state, row) {
  if (row.type === "turn.failed") {
    state.terminalError = true;
    state.successfulCompletion = false;
    state.hasCompletion = false;
  }
  const protocol = terminalProtocol(row, {
    agent: state.agent,
    cliVersion: state.cliVersion,
  });
  classifyTranscriptError(state, row, {
    // A novel terminal sentence needs its own adjudication; an earlier
    // structured retry notice cannot classify an unrecognized ending.
    replace:
      row.type === "turn.failed" && !protocol && !infrastructureSignal(row),
    protocol,
  });
}
function handleItemRow(state, row) {
  const item = row.item;
  if (item && item.type !== "error") recordProgress(state);
  if (
    [
      "command_execution",
      "mcp_tool_call",
      "web_search",
      "file_change",
      "image_view",
      "collab_tool_call",
      "todo_list",
    ].includes(item?.type) &&
    !state.tools.has(item.id)
  ) {
    state.tools.add(item.id);
    state.events.push({
      type: "tool",
      id: item.id,
      name:
        item.type === "mcp_tool_call"
          ? `${item.server}.${item.tool}`
          : item.type,
      input: item.command ?? item.arguments ?? item.changes ?? item.query,
      ...(item.type === "mcp_tool_call" ? { mcp: true } : {}),
      time: row.timestamp ?? null,
    });
    if (item.type === "web_search") webLookup(state.events, item);
  }
  if (row.type !== "item.completed") return;
  // Codex 0.164.0 emits an empty web-search start, then the actual request.
  if (item?.type === "web_search") webLookup(state.events, item);
  if (item?.type === "command_execution")
    state.events.push({
      type: "tool-result",
      id: item.id,
      output: item.aggregated_output,
      exit: item.exit_code,
      command: item.command,
    });
  if (item?.type === "mcp_tool_call")
    state.events.push({
      type: "tool-result",
      id: item.id,
      output: item.result?.content ?? item.result ?? item.error,
      mcp: {
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        result: item.result,
        error: item.error,
      },
    });
  if (item?.type === "agent_message") {
    state.finalMessage = item.text;
    state.events.push({ type: "message", text: item.text });
  }
}
function handleTurnCompletedRow(state, row) {
  recordProgress(state);
  state.hasCompletion = true;
  state.terminalError = false;
  state.successfulCompletion = true;
  state.lastSuccess = state.position;
  const u = row.usage ?? {};
  state.codexUsage.inputTokens += u.input_tokens ?? 0;
  state.codexUsage.outputTokens += u.output_tokens ?? 0;
  state.codexUsage.cachedInputTokens += u.cached_input_tokens ?? 0;
}
function finalizeTranscriptUsage(state, parseWarnings) {
  const fromClaude = (u) => ({
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
  });
  let usage = { ...state.codexUsage };
  for (const u of state.messages.values()) {
    const n = fromClaude(u);
    for (const k of Object.keys(usage)) usage[k] += n[k];
  }
  if (state.resultUsage) usage = fromClaude(state.resultUsage);
  if (state.modelUsage && Object.keys(state.modelUsage).length) {
    usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    for (const u of Object.values(state.modelUsage)) {
      usage.inputTokens +=
        (u.inputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0);
      usage.outputTokens += u.outputTokens ?? 0;
      usage.cachedInputTokens += u.cacheReadInputTokens ?? 0;
    }
  }
  usage.partial = !state.hasCompletion || parseWarnings.length > 0;
  return usage;
}
// Normalize both CLI streams. Truncated/noisy runs retain lower-bound usage.
export function normalizeTranscript(
  input,
  { now = Date.now(), agent, cliVersion } = {},
) {
  const parseWarnings = [];
  const rows = parseTranscriptRows(input, parseWarnings);
  const state = createTranscriptState(now, agent, cliVersion);
  for (const row of rows) {
    state.position++;
    if (row.type === "turn.started") {
      recordProgress(state);
      state.hasCompletion = false;
      state.successfulCompletion = false;
      state.terminalError = false;
    }
    handleRateLimitRow(state, row);
    if (row.type === "assistant") handleAssistantRow(state, row);
    if (row.type === "user") handleUserRow(state, row);
    if (row.type === "result") handleResultRow(state, row);
    if (["error", "turn.failed"].includes(row.type))
      handleErrorOrFailureRow(state, row);
    if (["item.started", "item.completed"].includes(row.type))
      handleItemRow(state, row);
    if (row.type === "turn.completed") handleTurnCompletedRow(state, row);
  }
  const usage = finalizeTranscriptUsage(state, parseWarnings);
  const recoveryMark = Math.max(state.lastSuccess, state.recoveredThrough);
  const recoveredIssues = state.issues.filter((e) => e.position < recoveryMark);
  return {
    events: state.events,
    usage,
    modelUsage: state.modelUsage,
    reportedCostUSD: state.reportedCostUSD,
    parseWarnings,
    finalMessage: state.finalMessage,
    totalToolCalls: state.events.filter((e) => e.type === "tool").length,
    successfulCompletion: state.successfulCompletion,
    terminalError: state.terminalError,
    retryCount: recoveredIssues.length,
    retryEvents: recoveredIssues.map(({ position, ...event }) => event),
    agentError: state.successfulCompletion ? false : state.agentError,
    infrastructureError: state.successfulCompletion
      ? null
      : state.infrastructureError,
    infrastructureKind: state.successfulCompletion
      ? null
      : state.infrastructureKind,
    retryAt: state.successfulCompletion ? null : state.retryAt,
    needsAdjudication:
      !state.successfulCompletion &&
      state.terminalError &&
      state.needsAdjudication,
    terminalTemplate: state.terminalTemplate,
  };
}
