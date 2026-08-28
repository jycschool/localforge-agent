import type {
  AgentEvent,
  ChatMessage,
  CommandApprovalRequest,
  ModelClient,
  TokenUsage,
  ToolResult,
} from "../core/protocol";
import { ToolRegistry } from "./toolRegistry";

export interface AgentRunOptions {
  task: string;
  displayTask?: string;
  previousMessages?: readonly ChatMessage[];
  systemPrompt: string;
  maxSteps: number;
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean>;
}

export interface AgentRunResult {
  status: "completed" | "cancelled" | "failed";
  summary: string;
  steps: number;
  messages: ChatMessage[];
}

export class AgentLoop {
  public constructor(
    private readonly model: ModelClient,
    private readonly registry: ToolRegistry,
  ) {}

  public async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: options.systemPrompt },
      ...(options.previousMessages ?? []),
      { role: "user", content: options.task },
    ];
    let steps = 0;
    let repeatedFailure: ToolFailureState | undefined;
    const cumulativeUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
    };
    options.onEvent({ type: "run_started", task: options.displayTask ?? options.task });

    try {
      for (steps = 1; steps <= options.maxSteps; steps += 1) {
        throwIfAborted(options.signal);
        options.onEvent({ type: "model_started", step: steps });
        const assistant = await this.model.complete(
          messages,
          this.registry.schemas(),
          options.signal,
          (text) => {
            if (text) {
              options.onEvent({ type: "assistant_delta", step: steps, text });
            }
          },
          (usage) => {
            cumulativeUsage.promptTokens += usage.promptTokens;
            cumulativeUsage.completionTokens += usage.completionTokens;
            cumulativeUsage.totalTokens += usage.totalTokens;
            cumulativeUsage.estimated ||= usage.estimated;
            options.onEvent({ type: "model_usage", step: steps, ...cumulativeUsage });
          },
        );
        messages.push(assistant);

        if (assistant.content?.trim()) {
          options.onEvent({ type: "assistant_message", text: assistant.content.trim() });
        }

        const calls = assistant.tool_calls ?? [];
        if (calls.length === 0) {
          const summary = assistant.content?.trim();
          if (!summary) {
            throw new Error("Model returned neither text nor tool calls.");
          }
          options.onEvent({ type: "run_completed", summary, steps });
          return { status: "completed", summary, steps, messages };
        }

        for (const call of calls) {
          throwIfAborted(options.signal);
          const startedAt = Date.now();
          let argumentsValue: Record<string, unknown>;
          let result: ToolResult | undefined;
          try {
            argumentsValue = parseArguments(call.function.arguments);
          } catch (error) {
            argumentsValue = {};
            result = {
              content: JSON.stringify({ error: errorMessage(error) }),
              isError: true,
            };
            options.onEvent({
              type: "tool_started",
              id: call.id,
              name: call.function.name,
              arguments: {},
            });
          }

          if (!result) {
            options.onEvent({
              type: "tool_started",
              id: call.id,
              name: call.function.name,
              arguments: argumentsValue,
            });
            result = await this.registry.execute(call.function.name, argumentsValue, {
              signal: options.signal,
              requestCommandApproval: options.requestCommandApproval,
            });
          }

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result.content,
          });
          options.onEvent({
            type: "tool_finished",
            id: call.id,
            name: call.function.name,
            result,
            durationMs: Date.now() - startedAt,
          });

          if (result.isError) {
            const signature = toolFailureSignature(
              call.function.name,
              call.function.arguments,
              result.content,
            );
            repeatedFailure =
              repeatedFailure?.signature === signature
                ? { ...repeatedFailure, count: repeatedFailure.count + 1 }
                : {
                    signature,
                    count: 1,
                    toolName: call.function.name,
                    message: toolErrorMessage(result.content),
                  };

            if (repeatedFailure.count >= MAX_IDENTICAL_TOOL_FAILURES) {
              const summary =
                `模型连续 ${repeatedFailure.count} 次提交了相同且失败的工具调用：` +
                `${repeatedFailure.toolName}（${repeatedFailure.message}）。` +
                "已停止任务，避免继续重复消耗步骤。";
              options.onEvent({ type: "run_failed", message: summary, steps });
              return { status: "failed", summary, steps, messages };
            }
          } else {
            repeatedFailure = undefined;
          }
        }
      }

      const summary =
        `已达到 ${options.maxSteps} 步运行上限，任务可能尚未完成。` +
        "你可以在当前会话中继续，已有对话和工具结果会作为上下文保留。";
      options.onEvent({
        type: "run_failed",
        message: summary,
        steps: options.maxSteps,
        reason: "max_steps",
      });
      return {
        status: "failed",
        summary,
        steps: options.maxSteps,
        messages,
      };
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) {
        options.onEvent({ type: "run_cancelled", steps });
        return { status: "cancelled", summary: "Run cancelled by the user.", steps, messages };
      }

      const summary = errorMessage(error);
      options.onEvent({ type: "run_failed", message: summary, steps });
      return { status: "failed", summary, steps, messages };
    }
  }
}

const MAX_IDENTICAL_TOOL_FAILURES = 3;

interface ToolFailureState {
  signature: string;
  count: number;
  toolName: string;
  message: string;
}

function parseArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Tool arguments are not valid JSON: ${raw.slice(0, 300)}`);
  }
  if (!isRecord(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolFailureSignature(name: string, rawArguments: string, content: string): string {
  let normalizedArguments = rawArguments.trim();
  try {
    normalizedArguments = stableJson(JSON.parse(rawArguments));
  } catch {
    // Invalid JSON is part of the failure signature in its original form.
  }
  return JSON.stringify([name, normalizedArguments, content]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolErrorMessage(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (isRecord(value) && typeof value.error === "string" && value.error.trim()) {
      return value.error.trim();
    }
  } catch {
    // Fall back to the original tool result below.
  }
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.slice(0, 240) || "工具返回了错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
