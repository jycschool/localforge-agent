export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
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
    onTextDelta?: (text: string) => void,
    onUsage?: (usage: TokenUsage) => void,
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

export type ExecutionMode = "direct" | "plan";

export type PlanItemStatus = "pending" | "in_progress" | "completed" | "skipped";

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
}

export type PlanState =
  | "awaiting_approval"
  | "active"
  | "ready_to_finish"
  | "completed"
  | "rejected";

export interface PlanSnapshot {
  revision: number;
  state: PlanState;
  explanation: string;
  items: PlanItem[];
  verification: string[];
  remaining: string[];
}

export interface PlanApprovalRequest {
  id: string;
  revision: number;
  reason: "initial" | "revision";
  explanation: string;
  items: PlanItem[];
}

export interface PlanApprovalDecisionItem {
  id?: string;
  title: string;
}

export interface PlanApprovalDecision {
  approved: boolean;
  items: PlanApprovalDecisionItem[];
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean>;
  requestPlanApproval?(request: PlanApprovalRequest): Promise<PlanApprovalDecision>;
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
  | { type: "assistant_delta"; step: number; text: string }
  | ({ type: "model_usage"; step: number } & TokenUsage)
  | { type: "assistant_message"; text: string }
  | { type: "tool_started"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_finished"; id: string; name: string; result: ToolResult; durationMs: number }
  | { type: "plan_updated"; plan: PlanSnapshot }
  | { type: "completion_blocked"; step: number; message: string }
  | { type: "run_completed"; summary: string; steps: number }
  | { type: "run_cancelled"; steps: number }
  | {
      type: "run_failed";
      message: string;
      steps: number;
      reason?: "max_steps";
    };
