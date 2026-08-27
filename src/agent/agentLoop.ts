import type {
  AgentEvent,
  ChatMessage,
  CommandApprovalRequest,
  ModelClient,
} from "../core/protocol";
import { ToolRegistry } from "./toolRegistry";

export interface AgentRunOptions {
  task: string;
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
      { role: "user", content: options.task },
    ];
    let steps = 0;
    options.onEvent({ type: "run_started", task: options.task });

    try {
      for (steps = 1; steps <= options.maxSteps; steps += 1) {
        throwIfAborted(options.signal);
        options.onEvent({ type: "model_started", step: steps });
        const assistant = await this.model.complete(
          messages,
          this.registry.schemas(),
          options.signal,
        );
        messages.push(assistant);

        if (assistant.content?.trim()) {
          options.onEvent({ type: "assistant_message", text: assistant.content.trim() });
        }

        const calls = assistant.tool_calls ?? [];
        if (calls.length === 0) {
          const summary = assistant.content?.trim() || "Task completed without a final summary.";
          options.onEvent({ type: "run_completed", summary, steps });
          return { status: "completed", summary, steps, messages };
        }

        for (const call of calls) {
          throwIfAborted(options.signal);
          const startedAt = Date.now();
          let argumentsValue: Record<string, unknown>;
          try {
            argumentsValue = parseArguments(call.function.arguments);
          } catch (error) {
            const result = {
              content: JSON.stringify({ error: errorMessage(error) }),
              isError: true,
            };
            options.onEvent({
              type: "tool_started",
              id: call.id,
              name: call.function.name,
              arguments: {},
            });
            messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
            options.onEvent({
              type: "tool_finished",
              id: call.id,
              name: call.function.name,
              result,
              durationMs: Date.now() - startedAt,
            });
            continue;
          }
          options.onEvent({
            type: "tool_started",
            id: call.id,
            name: call.function.name,
            arguments: argumentsValue,
          });

          const result = await this.registry.execute(call.function.name, argumentsValue, {
            signal: options.signal,
            requestCommandApproval: options.requestCommandApproval,
          });
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
        }
      }

      const summary = `Stopped after reaching the ${options.maxSteps}-step limit.`;
      options.onEvent({ type: "run_failed", message: summary, steps: options.maxSteps });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
