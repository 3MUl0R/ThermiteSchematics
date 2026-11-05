import { infrastructureSignal } from "./event-errors.mjs";
// Normalize both CLI streams. Truncated/noisy runs retain lower-bound usage.
export function normalizeTranscript(input) {
  const parseWarnings = [];
  const rows =
    typeof input === "string"
      ? input.split(/\r?\n/).flatMap((line, index) => {
          if (!line.trim()) return [];
          try {
            return [JSON.parse(line)];
          } catch {
            parseWarnings.push({ line: index + 1, kind: "non-json-event" });
            return [];
          }
        })
      : (input ?? []);
  const events = [],
    tools = new Set(),
    messages = new Map();
  let finalMessage = "",
    resultUsage = null,
    modelUsage = null,
    reportedCostUSD = null,
    hasCompletion = false,
    terminalError = false,
    agentError = false,
    infrastructureError = null;
  const codexUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const issues = [];
  let position = 0,
    lastSuccess = -1,
    successfulCompletion = false,
    infrastructureKind = null;
  const classifyError = (error) => {
    const signal = infrastructureSignal(error);
    if (signal) {
      infrastructureError = signal.code;
      infrastructureKind = signal.kind;
    } else agentError = true;
    issues.push({
      position,
      type: "retry",
      kind: signal?.kind ?? "unstructured",
      code: signal?.code ?? null,
    });
  };
  for (const row of rows) {
    position++;
    if (row.type === "turn.started") {
      hasCompletion = false;
      successfulCompletion = false;
      terminalError = false;
    }
    if (
      ["rate_limit", "rate_limit_event"].includes(row.type) &&
      !["allowed", "allowed_warning"].includes(
        row.rate_limit_info?.status ?? row.rateLimitInfo?.status,
      )
    )
      classifyError({ type: "rate_limit" });
    if (row.type === "assistant") {
      if (row.error)
        classifyError(
          typeof row.error === "string" ? { type: row.error } : row.error,
        );
      const id = row.message?.id ?? row.uuid ?? `message-${messages.size}`,
        u = row.message?.usage;
      if (u) {
        const old = messages.get(id) ?? {};
        messages.set(
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
        if (block.type === "tool_use" && !tools.has(block.id)) {
          tools.add(block.id);
          events.push({
            type: "tool",
            id: block.id,
            name: block.name,
            input: block.input,
            time: row.timestamp ?? null,
          });
        }
        if (block.type === "text") {
          text.push(block.text);
          events.push({ type: "message", text: block.text });
        }
      }
      if (text.length) finalMessage = text.join("\n");
    }
    if (row.type === "user")
      for (const block of row.message?.content ?? [])
        if (block.type === "tool_result")
          events.push({
            type: "tool-result",
            id: block.tool_use_id,
            output: block.content,
          });
    if (row.type === "result") {
      hasCompletion = true;
      finalMessage = row.result ?? finalMessage;
      resultUsage = row.usage ?? null;
      modelUsage = row.modelUsage ?? null;
      reportedCostUSD = row.total_cost_usd ?? null;
      if (row.is_error || (row.subtype && row.subtype !== "success")) {
        terminalError = true;
        successfulCompletion = false;
        classifyError(
          row.errors?.length ? row.errors : (row.error ?? row.subtype),
        );
      } else {
        terminalError = false;
        successfulCompletion = true;
        lastSuccess = position;
      }
    }
    if (["error", "turn.failed"].includes(row.type)) {
      if (row.type === "turn.failed") {
        terminalError = true;
        successfulCompletion = false;
        hasCompletion = false;
      }
      classifyError(row.error ?? row.message);
    }
    if (["item.started", "item.completed"].includes(row.type)) {
      const item = row.item;
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
        !tools.has(item.id)
      ) {
        tools.add(item.id);
        events.push({
          type: "tool",
          id: item.id,
          name:
            item.type === "mcp_tool_call"
              ? `${item.server}.${item.tool}`
              : item.type,
          input: item.command ?? item.arguments ?? item.changes ?? item.query,
          time: row.timestamp ?? null,
        });
      }
      if (row.type === "item.completed") {
        if (item?.type === "command_execution")
          events.push({
            type: "tool-result",
            id: item.id,
            output: item.aggregated_output,
            exit: item.exit_code,
          });
        if (item?.type === "mcp_tool_call")
          events.push({
            type: "tool-result",
            id: item.id,
            output: item.result?.content ?? item.result ?? item.error,
          });
        if (item?.type === "agent_message") {
          finalMessage = item.text;
          events.push({ type: "message", text: item.text });
        }
      }
    }
    if (row.type === "turn.completed") {
      hasCompletion = true;
      terminalError = false;
      successfulCompletion = true;
      lastSuccess = position;
      const u = row.usage ?? {};
      codexUsage.inputTokens += u.input_tokens ?? 0;
      codexUsage.outputTokens += u.output_tokens ?? 0;
      codexUsage.cachedInputTokens += u.cached_input_tokens ?? 0;
    }
  }
  const fromClaude = (u) => ({
    inputTokens:
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: u.cache_read_input_tokens ?? 0,
  });
  let usage = { ...codexUsage };
  for (const u of messages.values()) {
    const n = fromClaude(u);
    for (const k of Object.keys(usage)) usage[k] += n[k];
  }
  if (resultUsage) usage = fromClaude(resultUsage);
  if (modelUsage && Object.keys(modelUsage).length) {
    usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    for (const u of Object.values(modelUsage)) {
      usage.inputTokens +=
        (u.inputTokens ?? 0) +
        (u.cacheCreationInputTokens ?? 0) +
        (u.cacheReadInputTokens ?? 0);
      usage.outputTokens += u.outputTokens ?? 0;
      usage.cachedInputTokens += u.cacheReadInputTokens ?? 0;
    }
  }
  usage.partial = !hasCompletion || parseWarnings.length > 0;
  return {
    events,
    usage,
    modelUsage,
    reportedCostUSD,
    parseWarnings,
    finalMessage,
    totalToolCalls: events.filter((e) => e.type === "tool").length,
    successfulCompletion,
    terminalError,
    retryCount: issues.filter((e) => e.position < lastSuccess).length,
    retryEvents: issues
      .filter((e) => e.position < lastSuccess)
      .map(({ position, ...event }) => event),
    agentError: successfulCompletion ? false : agentError,
    infrastructureError: successfulCompletion ? null : infrastructureError,
    infrastructureKind: successfulCompletion ? null : infrastructureKind,
  };
}
