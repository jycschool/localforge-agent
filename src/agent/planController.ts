import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentTool,
  PlanApprovalDecisionItem,
  PlanItem,
  PlanItemStatus,
  PlanSnapshot,
} from "../core/protocol";

const READ_ONLY_TOOLS = new Set(["list_files", "search_text", "read_file"]);
const MAX_PLAN_ITEMS = 12;

export class PlanController {
  private plan: PlanSnapshot | undefined;

  public constructor(private readonly onEvent: (event: AgentEvent) => void) {}

  public tools(): AgentTool[] {
    return [this.proposePlanTool(), this.updatePlanTool(), this.finishTaskTool()];
  }

  public isToolEnabled(name: string): boolean {
    if (!this.plan || this.plan.state === "awaiting_approval" || this.plan.state === "rejected") {
      return READ_ONLY_TOOLS.has(name) || name === "propose_plan";
    }
    if (this.plan.state === "completed") {
      return false;
    }
    return name !== "propose_plan" || this.plan.state === "active" || this.plan.state === "ready_to_finish";
  }

  public snapshot(): PlanSnapshot | undefined {
    return this.plan ? clonePlan(this.plan) : undefined;
  }

  public completionIssue(): string | undefined {
    if (!this.plan) {
      return "规划模式尚未提交计划，请先调用 propose_plan。";
    }
    if (this.plan.state === "awaiting_approval") {
      return "计划仍在等待用户确认。";
    }
    if (this.plan.state === "rejected") {
      return "用户没有批准计划，请根据反馈重新规划或说明无法继续。";
    }
    if (this.plan.state !== "completed") {
      return "计划尚未完成并通过 finish_task 核验。";
    }
    return undefined;
  }

  private proposePlanTool(): AgentTool {
    return {
      schema: {
        type: "function",
        function: {
          name: "propose_plan",
          description:
            "提交或修订一份短而可执行的任务计划，并等待用户在界面中编辑、排序和确认。任何写入或命令执行之前必须先获批；执行中如范围发生实质变化也必须重新调用。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["explanation", "steps"],
            properties: {
              explanation: {
                type: "string",
                minLength: 1,
                description: "用一两句话说明目标、边界和为什么需要这些步骤。",
              },
              steps: {
                type: "array",
                minItems: 1,
                maxItems: MAX_PLAN_ITEMS,
                description: "按执行顺序排列的步骤标题字符串；每项应可验证，避免‘完成任务’之类空泛表述。",
                items: { type: "string", minLength: 1, maxLength: 160 },
              },
            },
          },
        },
      },
      execute: async (argumentsValue, context) => {
        const explanation = requiredText(argumentsValue.explanation, "explanation", 600);
        const proposedItems = parseProposedItems(argumentsValue.steps);
        const previousPlan = this.plan ? clonePlan(this.plan) : undefined;
        const revision = (this.plan?.revision ?? 0) + 1;
        this.plan = {
          revision,
          state: "awaiting_approval",
          explanation,
          items: proposedItems.map((item) => ({ ...item, status: "pending" })),
          verification: [],
          remaining: [],
        };
        this.emit();

        if (!context.requestPlanApproval) {
          throw new Error("Plan approval is unavailable.");
        }
        const decision = await context.requestPlanApproval({
          id: randomUUID(),
          revision,
          reason: previousPlan ? "revision" : "initial",
          explanation,
          items: this.plan.items.map((item) => ({ ...item })),
        });
        if (context.signal.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (!decision.approved) {
          this.plan = previousPlan ?? { ...this.plan, state: "rejected" };
          this.emit();
          return {
            content: JSON.stringify({ approved: false, message: "用户未批准该计划。" }),
            isError: true,
          };
        }

        const approvedItems = normalizeApprovedItems(decision.items, proposedItems);
        this.plan = {
          revision,
          state: "active",
          explanation,
          items: approvedItems.map((item) => ({ ...item, status: "pending" })),
          verification: [],
          remaining: [],
        };
        this.emit();
        return { content: JSON.stringify({ approved: true, plan: this.plan }) };
      },
    };
  }

  private updatePlanTool(): AgentTool {
    return {
      schema: {
        type: "function",
        function: {
          name: "update_plan",
          description:
            "同步已批准计划的执行状态。开始步骤前标记 in_progress，完成核验后标记 completed；不再需要的步骤标记 skipped。每次必须提交全部步骤的最新状态。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
              items: {
                type: "array",
                minItems: 1,
                maxItems: MAX_PLAN_ITEMS,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "status"],
                  properties: {
                    id: { type: "string", minLength: 1 },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed", "skipped"],
                    },
                  },
                },
              },
            },
          },
        },
      },
      execute: async (argumentsValue) => {
        const plan = this.requireActivePlan();
        const updates = parseStatusUpdates(argumentsValue.items, plan.items);
        if ([...updates.values()].filter((status) => status === "in_progress").length > 1) {
          throw new Error("At most one plan item may be in_progress.");
        }
        plan.items = plan.items.map((item) => ({ ...item, status: updates.get(item.id) ?? item.status }));
        plan.state = plan.items.every((item) => isTerminal(item.status))
          ? "ready_to_finish"
          : "active";
        this.plan = plan;
        this.emit();
        return { content: JSON.stringify({ plan }) };
      },
    };
  }

  private finishTaskTool(): AgentTool {
    return {
      schema: {
        type: "function",
        function: {
          name: "finish_task",
          description:
            "完成门禁：仅当计划所有步骤均为 completed 或 skipped 后调用。记录实际验证证据和仍未完成的事项；成功后才可输出最终答复。",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["verification", "remaining"],
            properties: {
              verification: {
                type: "array",
                minItems: 1,
                maxItems: 12,
                items: { type: "string", minLength: 1, maxLength: 300 },
                description: "实际执行过的检查、测试或人工验收证据，不得填写计划中的未来动作。",
              },
              remaining: {
                type: "array",
                maxItems: 12,
                items: { type: "string", minLength: 1, maxLength: 300 },
                description: "明确列出未完成、未验证或需要用户处理的事项；没有则传空数组。",
              },
            },
          },
        },
      },
      execute: async (argumentsValue) => {
        const plan = this.requireActivePlan();
        if (!plan.items.every((item) => isTerminal(item.status))) {
          throw new Error("All plan items must be completed or skipped before finish_task.");
        }
        plan.verification = textArray(argumentsValue.verification, "verification", 1);
        plan.remaining = textArray(argumentsValue.remaining, "remaining", 0);
        plan.state = "completed";
        this.plan = plan;
        this.emit();
        return { content: JSON.stringify({ accepted: true, plan }) };
      },
    };
  }

  private requireActivePlan(): PlanSnapshot {
    if (!this.plan || !["active", "ready_to_finish"].includes(this.plan.state)) {
      throw new Error("No approved active plan is available.");
    }
    return clonePlan(this.plan);
  }

  private emit(): void {
    if (this.plan) {
      this.onEvent({ type: "plan_updated", plan: clonePlan(this.plan) });
    }
  }
}

function parseProposedItems(value: unknown): Array<Omit<PlanItem, "status">> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLAN_ITEMS) {
    throw new Error(`steps must contain 1-${MAX_PLAN_ITEMS} items.`);
  }
  const used = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw === "string") {
      return { id: `step-${index + 1}`, title: requiredText(raw, `steps[${index}]`, 160) };
    }
    if (!isRecord(raw)) throw new Error(`steps[${index}] must be a string or object.`);
    const title = requiredText(raw.title, `steps[${index}].title`, 160);
    const requestedId = typeof raw.id === "string" ? raw.id.trim() : "";
    let id = requestedId || `step-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return { id, title };
  });
}

function normalizeApprovedItems(
  value: readonly PlanApprovalDecisionItem[],
  fallback: Array<Omit<PlanItem, "status">>,
): Array<Omit<PlanItem, "status">> {
  const input = value.length ? value : fallback;
  if (input.length < 1 || input.length > MAX_PLAN_ITEMS) {
    throw new Error(`Approved plan must contain 1-${MAX_PLAN_ITEMS} items.`);
  }
  const used = new Set<string>();
  return input.map((item, index) => {
    const title = requiredText(item.title, `items[${index}].title`, 160);
    let id = item.id?.trim() || fallback[index]?.id || `step-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return { id, title };
  });
}

function parseStatusUpdates(value: unknown, items: readonly PlanItem[]): Map<string, PlanItemStatus> {
  if (!Array.isArray(value) || value.length !== items.length) {
    throw new Error("items must include every approved plan item exactly once.");
  }
  const validIds = new Set(items.map((item) => item.id));
  const updates = new Map<string, PlanItemStatus>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") {
      throw new Error(`items[${index}] must include id and status.`);
    }
    if (!validIds.has(raw.id) || updates.has(raw.id)) throw new Error(`Unknown or duplicate plan id: ${raw.id}`);
    if (!isPlanStatus(raw.status)) throw new Error(`Invalid plan status: ${raw.status}`);
    updates.set(raw.id, raw.status);
  }
  return updates;
}

function textArray(value: unknown, field: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 12) {
    throw new Error(`${field} must contain ${minimum}-12 items.`);
  }
  return value.map((item, index) => requiredText(item, `${field}[${index}]`, 300));
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  if (value.trim().length > maxLength) throw new Error(`${field} must not exceed ${maxLength} characters.`);
  return value.trim();
}

function isPlanStatus(value: string): value is PlanItemStatus {
  return ["pending", "in_progress", "completed", "skipped"].includes(value);
}

function isTerminal(status: PlanItemStatus): boolean {
  return status === "completed" || status === "skipped";
}

function clonePlan(plan: PlanSnapshot): PlanSnapshot {
  return {
    ...plan,
    items: plan.items.map((item) => ({ ...item })),
    verification: [...plan.verification],
    remaining: [...plan.remaining],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
