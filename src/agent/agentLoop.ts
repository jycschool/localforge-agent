import type {
  AgentEvent,
  ChatMessage,
  CommandApprovalRequest,
  ModelClient,
  PlanApprovalDecision,
  PlanApprovalRequest,
  TokenUsage,
  ToolResult,
} from "../core/protocol";
import { ToolRegistry } from "./toolRegistry";
import { toolErrorResult } from "./toolErrors";

export interface AgentRunOptions {
  task: string;
  displayTask?: string;
  previousMessages?: readonly ChatMessage[];
  systemPrompt: string;
  maxSteps: number;
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean>;
  requestPlanApproval?(request: PlanApprovalRequest): Promise<PlanApprovalDecision>;
  validateCompletion?(): string | undefined;
  completeWhenGatePassesAfterTools?: boolean;
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
    const progressGuard = new ToolProgressGuard();
    let budgetWarningSent = false;
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
        const remainingSteps = options.maxSteps - steps + 1;
        if (!budgetWarningSent && options.maxSteps > 3 && remainingSteps === 3) {
          budgetWarningSent = true;
          messages.push({
            role: "system",
            content:
              "Only three model steps remain in this run. Prioritize unresolved requirements, use the smallest decisive tool calls, perform the most relevant verification, and finish honestly. Do not start unrelated exploration.",
          });
        }
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

        const calls = assistant.tool_calls ?? [];
        if (calls.length === 0) {
          const summary = assistant.content?.trim();
          if (!summary) {
            throw new Error("Model returned neither text nor tool calls.");
          }
          const completionIssue = options.validateCompletion?.();
          if (completionIssue) {
            options.onEvent({ type: "assistant_message", text: summary });
            options.onEvent({ type: "completion_blocked", step: steps, message: completionIssue });
            messages.push({
              role: "system",
              content:
                `The task cannot finish yet: ${completionIssue} ` +
                "Continue using the available tools. Do not repeat the final answer until the completion gate passes.",
            });
            continue;
          }
          options.onEvent({ type: "assistant_message", text: summary });
          options.onEvent({ type: "run_completed", summary, steps });
          return { status: "completed", summary, steps, messages };
        }

        if (assistant.content?.trim()) {
          options.onEvent({ type: "assistant_message", text: assistant.content.trim() });
        }

        let progressDecisionForStep: ProgressDecision = "continue";
        for (const call of calls) {
          throwIfAborted(options.signal);
          const startedAt = Date.now();
          let argumentsValue: Record<string, unknown>;
          let result: ToolResult | undefined;
          try {
            argumentsValue = parseArguments(call.function.arguments);
          } catch (error) {
            argumentsValue = {};
            result = toolErrorResult(error, {
              code: "INVALID_TOOL_ARGUMENTS_JSON",
              retryable: true,
              suggestion: "Regenerate one JSON object that exactly follows the selected tool schema.",
            });
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
              requestPlanApproval: options.requestPlanApproval,
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

          const progressDecision = progressGuard.record(
            call.function.name,
            argumentsValue,
            result,
          );
          if (progressDecision === "warn") {
            if (progressDecisionForStep !== "stop") {
              progressDecisionForStep = "warn";
            }
          } else if (progressDecision === "stop") {
            progressDecisionForStep = "stop";
          }

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

        if (progressDecisionForStep === "stop") {
          const summary =
            "工具调用已经两次进入无进展循环。已停止任务，避免继续重复读取、搜索或失败编辑；请检查目标路径、工具参数或改用其他策略后继续。";
          options.onEvent({ type: "run_failed", message: summary, steps });
          return { status: "failed", summary, steps, messages };
        }
        if (progressDecisionForStep === "warn") {
          messages.push({
            role: "system",
            content:
              "Recent tool calls are repeating without observable progress. Reassess the target and the structured error details, then choose a materially different action. Do not repeat reads, searches, or failing edits that produced no new evidence.",
          });
        }

        if (options.completeWhenGatePassesAfterTools && options.validateCompletion) {
          const completionIssue = options.validateCompletion();
          if (!completionIssue) {
            const summary =
              assistant.content?.trim() || "计划已完成，所有完成门禁均已通过。";
            options.onEvent({ type: "run_completed", summary, steps });
            return { status: "completed", summary, steps, messages };
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

type ProgressDecision = "continue" | "warn" | "stop";

interface ToolActionObservation {
  fingerprint: string;
  errorFamily?: string;
}

class ToolProgressGuard {
  private observations: ToolActionObservation[] = [];
  private recoveryWarnings = 0;

  public record(
    name: string,
    argumentsValue: Record<string, unknown>,
    result: ToolResult,
  ): ProgressDecision {
    if (isProgressAction(name, result)) {
      this.observations = [];
      this.recoveryWarnings = 0;
      return "continue";
    }
    const observation = {
      fingerprint: JSON.stringify([
        name,
        stableJson(argumentsValue),
        result.isError ? "error" : contentFingerprint(result.content),
      ]),
      errorFamily: result.isError ? `${name}:${toolErrorCode(result.content)}` : undefined,
    };
    this.observations.push(observation);
    this.observations = this.observations.slice(-8);

    const exactRepeats = this.observations.filter(
      (item) => item.fingerprint === observation.fingerprint,
    ).length;
    const familyRepeats = observation.errorFamily
      ? this.observations.filter((item) => item.errorFamily === observation.errorFamily).length
      : 0;
    if (exactRepeats < 3 && familyRepeats < 3) {
      return "continue";
    }

    this.observations = [];
    this.recoveryWarnings += 1;
    return this.recoveryWarnings >= 2 ? "stop" : "warn";
  }
}

function isProgressAction(name: string, result: ToolResult): boolean {
  return !result.isError && [
    "replace_in_file",
    "edit_file_lines",
    "write_file",
    "run_command",
    "propose_plan",
    "update_plan",
    "finish_task",
  ].includes(name);
}

function toolErrorCode(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (isRecord(value) && typeof value.code === "string" && value.code.trim()) {
      return value.code.trim();
    }
    if (isRecord(value) && typeof value.error === "string" && value.error.trim()) {
      return value.error.trim().slice(0, 120);
    }
  } catch {
    // Use the compact raw content below.
  }
  return content.replace(/\s+/g, " ").trim().slice(0, 120) || "UNKNOWN_TOOL_ERROR";
}

function contentFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}
