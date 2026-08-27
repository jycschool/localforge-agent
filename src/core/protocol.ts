export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: FunctionToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface FunctionToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelClient {
  complete(
    messages: readonly ChatMessage[],
    tools: readonly FunctionToolSchema[],
    signal: AbortSignal,
  ): Promise<Extract<ChatMessage, { role: "assistant" }>>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface CommandApprovalRequest {
  id: string;
  command: string;
  reason: string;
  cwd: string;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean>;
}

export interface AgentTool {
  schema: FunctionToolSchema;
  execute(
    argumentsValue: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export type AgentEvent =
  | { type: "run_started"; task: string }
  | { type: "model_started"; step: number }
  | { type: "assistant_message"; text: string }
  | { type: "tool_started"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_finished"; id: string; name: string; result: ToolResult; durationMs: number }
  | { type: "run_completed"; summary: string; steps: number }
  | { type: "run_cancelled"; steps: number }
  | { type: "run_failed"; message: string; steps: number };

