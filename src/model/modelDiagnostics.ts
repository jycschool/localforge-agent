import type {
  ChatMessage,
  FunctionToolSchema,
  ModelClient,
  TokenUsage,
} from "../core/protocol";
import type {
  ModelDiagnosticCheck,
  ModelDiagnosticResult,
} from "../desktop/contracts";

const HEALTH_TOOL: FunctionToolSchema = {
  type: "function",
  function: {
    name: "localforge_health_check",
    description: "Return a fixed probe value to verify model tool-calling support.",
    parameters: {
      type: "object",
      properties: { probe: { type: "string", enum: ["ping"] } },
      required: ["probe"],
      additionalProperties: false,
    },
  },
};

export async function diagnoseModel(
  client: ModelClient,
  model: string,
  signal: AbortSignal,
): Promise<ModelDiagnosticResult> {
  const startedAt = Date.now();
  const checks: ModelDiagnosticCheck[] = [];
  let streamedText = "";
  let usage: TokenUsage | undefined;

  try {
    const response = await client.complete(
      [
        { role: "system", content: "You are a model connectivity probe." },
        { role: "user", content: "Reply with exactly: RepoForge OK" },
      ],
      [],
      signal,
      (delta) => {
        streamedText += delta;
      },
      (reported) => {
        usage = reported;
      },
    );
    checks.push({ id: "connection", status: "passed", detail: "模型服务已响应。" });
    checks.push({
      id: "text",
      status: response.content?.trim() ? "passed" : "failed",
      detail: response.content?.trim()
        ? `收到文本：${response.content.trim().slice(0, 80)}`
        : "没有收到可显示的文本。",
    });
    checks.push({
      id: "streaming",
      status: streamedText ? "passed" : "skipped",
      detail: streamedText
        ? "已收到逐段输出。"
        : "服务返回了完整响应，客户端会自动兼容。",
    });
    checks.push({
      id: "usage",
      status: usage ? "passed" : "skipped",
      detail: usage
        ? `${usage.totalTokens.toLocaleString()} Token${usage.estimated ? "（本地估算）" : "（服务返回）"}`
        : "服务未返回用量信息。",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ id: "connection", status: "failed", detail });
    checks.push({ id: "text", status: "skipped", detail: "连接失败，未执行。" });
    checks.push({ id: "streaming", status: "skipped", detail: "连接失败，未执行。" });
    checks.push({ id: "usage", status: "skipped", detail: "连接失败，未执行。" });
  }

  if (checks.find((check) => check.id === "connection")?.status === "passed") {
    try {
      const response = await client.complete(
        [
          { role: "system", content: "You must call the supplied health-check tool." },
          {
            role: "user",
            content: "Call localforge_health_check now with {\"probe\":\"ping\"}. Do not answer in text.",
          },
        ],
        [HEALTH_TOOL],
        signal,
      );
      const call = response.tool_calls?.find(
        (item) => item.function.name === HEALTH_TOOL.function.name,
      );
      checks.push({
        id: "toolCalling",
        status: call ? "passed" : "failed",
        detail: call ? "工具调用协议正常。" : "模型返回了响应，但没有按要求发起工具调用。",
      });
    } catch (error) {
      checks.push({
        id: "toolCalling",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({ id: "toolCalling", status: "skipped", detail: "连接失败，未执行。" });
  }

  const passed = (id: ModelDiagnosticCheck["id"]): boolean =>
    checks.find((check) => check.id === id)?.status === "passed";
  return {
    ok: passed("connection") && passed("text") && passed("toolCalling"),
    model,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    checks,
  };
}
