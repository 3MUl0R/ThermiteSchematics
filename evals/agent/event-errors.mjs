// Interpret protocol fields and embedded JSON envelopes, never prose keywords.
const canonical = (code) =>
  String(code ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
const groups = {
  billing: [
    "billing_error",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "billing_not_active",
  ],
  "rate-limit": [
    "rate_limit",
    "rate_limit_error",
    "rate_limit_exceeded",
    "usage_limit_exceeded",
    "session_budget_exceeded",
  ],
  authentication: [
    "authentication_error",
    "authentication_failed",
    "unauthorized",
    "invalid_api_key",
    "permission_error",
  ],
  configuration: ["model_not_found", "invalid_request_error", "bad_request"],
  network: [
    "http_connection_failed",
    "http_connection_dropped",
    "http_request_timeout",
    "response_stream_disconnected",
    "response_stream_connection_failed",
    "response_too_many_failed_attempts",
    "stream_disconnected",
    "transport_error",
    "network_error",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
  ],
  provider: [
    "server_overloaded",
    "overloaded_error",
    "api_error",
    "server_error",
    "internal_server_error",
    "flex_unavailable",
  ],
};
export function infrastructureSignal(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    try {
      return infrastructureSignal(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value))
    return (
      value.map((v) => infrastructureSignal(v, depth + 1)).find(Boolean) ?? null
    );
  if (typeof value !== "object") return null;
  const nested = infrastructureSignal(value.error, depth + 1);
  const info = value.codex_error_info ?? value.codexErrorInfo;
  const signals = [];
  if (nested) signals.push(nested);
  if (typeof info === "string")
    signals.push(infrastructureSignal({ code: info }, depth + 1));
  else if (info && typeof info === "object")
    for (const [code, data] of Object.entries(info))
      signals.push(
        infrastructureSignal(
          { code, ...(typeof data === "object" ? data : {}) },
          depth + 1,
        ),
      );
  for (const code of [value.code, value.type])
    if (code) {
      const key = canonical(code);
      for (const [kind, codes] of Object.entries(groups))
        if (codes.includes(key)) signals.push({ kind, code: String(code) });
    }
  // Billing/quota identity overrides a generic HTTP 429 or wrapper type.
  const identified = signals.filter(Boolean);
  const status =
    value.status ??
    value.status_code ??
    value.http_status_code ??
    value.httpStatusCode;
  const billing = identified.find((s) => s.kind === "billing");
  if (billing) return billing;
  const rate = identified.find((s) => s.kind === "rate-limit");
  if (rate || status === 429)
    return rate ?? { kind: "rate-limit", code: "429" };
  if ([401, 403].includes(status))
    return (
      identified.find((s) => s.kind === "authentication") ?? {
        kind: "authentication",
        code: String(status),
      }
    );
  if (identified.length) return identified[0];
  if ([408, 500, 502, 503, 504].includes(status))
    return { kind: "network", code: String(status) };
  // Codex exec may wrap a provider's JSON object in error.message.
  return infrastructureSignal(value.message, depth + 1);
}
