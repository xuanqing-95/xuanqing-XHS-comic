// Official OpenAI transport policy is separate from the existing ZenMux defaults.
// Credentials remain environment references; this module never persists them.
function resolveRelayToken(route, env) {
  if (!route.relayTokenEnv) return "";
  const token = env[route.relayTokenEnv];
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`Missing relay token in environment variable: ${route.relayTokenEnv}`);
  }
  return token.trim();
}

export function relayHeaders(route, env = process.env) {
  if (route.provider === "openai") {
    const base = String(route.baseURL || "").replace(/\/+$/, "");
    if (base === "https://api.openai.com/v1") return {};
    if (base !== "https://www.pipeline.xin/api/internal/openai" || route.relayTokenEnv !== "OPENAI_RELAY_TOKEN") {
      throw new Error("Official OpenAI route requires its explicit trusted endpoint and relay credential");
    }
    return { "X-Redflow-OpenAI-Relay-Token": resolveRelayToken(route, env) };
  }
  const token = resolveRelayToken(route, env);
  return token ? { "X-Redflow-Relay-Token": token } : {};
}

export function officialChatOptions(provider) {
  return provider === "openai"
    ? { max_completion_tokens: 8192, reasoning_effort: "low", store: false, service_tier: "default" }
    : {};
}
