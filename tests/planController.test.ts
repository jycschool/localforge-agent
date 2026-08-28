import { describe, expect, it, vi } from "vitest";
import { PlanController } from "../src/agent/planController";
import { ToolRegistry } from "../src/agent/toolRegistry";
import type {
  AgentEvent,
  AgentTool,
  PlanApprovalRequest,
  ToolExecutionContext,
} from "../src/core/protocol";

describe("planning workflow", () => {
  it("locks mutation tools until the user edits and approves a plan", async () => {
    const events: AgentEvent[] = [];
    const controller = new PlanController((event) => events.push(event));
    const registry = registryFor(controller);
    const requestPlanApproval = vi.fn(async (_request: PlanApprovalRequest) => ({
      approved: true,
      items: [
        { id: "inspect", title: "检查相关文件" },
        { id: "verify", title: "运行最小测试" },
      ],
    }));
    const context = toolContext(requestPlanApproval);

    expect(toolNames(registry)).toEqual(["read_file", "propose_plan"]);
    await expect(registry.execute("write_file", {}, context)).resolves.toMatchObject({
      isError: true,
    });

    const proposal = await registry.execute("propose_plan", {
      explanation: "先确认范围再修改",
      steps: [{ id: "inspect", title: "查看代码" }, { id: "verify", title: "检查结果" }],
    }, context);

    expect(proposal.isError).not.toBe(true);
    expect(requestPlanApproval).toHaveBeenCalledOnce();
    expect(requestPlanApproval.mock.calls[0]?.[0]).toMatchObject({
      reason: "initial",
      revision: 1,
    });
    expect(controller.snapshot()?.items.map((item) => item.title)).toEqual([
      "检查相关文件",
      "运行最小测试",
    ]);
    expect(toolNames(registry)).toEqual([
      "read_file",
      "write_file",
      "propose_plan",
      "update_plan",
      "finish_task",
    ]);
    expect(events.filter((event) => event.type === "plan_updated")).toHaveLength(2);
  });

  it("requires terminal checklist state and verification evidence before completion", async () => {
    const controller = new PlanController(() => undefined);
    const registry = registryFor(controller);
    const context = toolContext(async (request) => ({
      approved: true,
      items: request.items.map((item) => ({ id: item.id, title: item.title })),
    }));
    await registry.execute("propose_plan", {
      explanation: "实施并验证",
      steps: [{ id: "change", title: "修改代码" }, { id: "test", title: "运行测试" }],
    }, context);

    expect(controller.completionIssue()).toContain("尚未完成");
    await expect(registry.execute("finish_task", {
      verification: ["测试通过"],
      remaining: [],
    }, context)).resolves.toMatchObject({ isError: true });
    await expect(registry.execute("update_plan", {
      items: [
        { id: "change", status: "in_progress" },
        { id: "test", status: "in_progress" },
      ],
    }, context)).resolves.toMatchObject({ isError: true });

    const update = await registry.execute("update_plan", {
      items: [
        { id: "change", status: "completed" },
        { id: "test", status: "completed" },
      ],
    }, context);
    expect(update.isError).not.toBe(true);
    expect(controller.snapshot()?.state).toBe("ready_to_finish");

    const finish = await registry.execute("finish_task", {
      verification: ["pnpm test：全部通过"],
      remaining: [],
    }, context);
    expect(finish.isError).not.toBe(true);
    expect(controller.snapshot()).toMatchObject({
      state: "completed",
      verification: ["pnpm test：全部通过"],
    });
    expect(controller.completionIssue()).toBeUndefined();
    expect(registry.schemas()).toEqual([]);
  });

  it("keeps the previously approved plan when a scope revision is rejected", async () => {
    const controller = new PlanController(() => undefined);
    const registry = registryFor(controller);
    const approve = toolContext(async (request) => ({
      approved: true,
      items: request.items.map((item) => ({ id: item.id, title: item.title })),
    }));
    await registry.execute("propose_plan", {
      explanation: "原计划",
      steps: [{ id: "one", title: "原步骤" }],
    }, approve);
    const original = controller.snapshot();

    const rejected = await registry.execute("propose_plan", {
      explanation: "扩大范围",
      steps: [{ id: "other", title: "额外重构" }],
    }, toolContext(async () => ({ approved: false, items: [] })));

    expect(rejected.isError).toBe(true);
    expect(controller.snapshot()).toEqual(original);
  });
});

function registryFor(controller: PlanController): ToolRegistry {
  return new ToolRegistry(
    [dummyTool("read_file"), dummyTool("write_file"), ...controller.tools()],
    { isToolEnabled: (name) => controller.isToolEnabled(name) },
  );
}

function dummyTool(name: string): AgentTool {
  return {
    schema: {
      type: "function",
      function: { name, description: name, parameters: { type: "object" } },
    },
    execute: async () => ({ content: "ok" }),
  };
}

function toolContext(
  requestPlanApproval: NonNullable<ToolExecutionContext["requestPlanApproval"]>,
): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    requestCommandApproval: async () => true,
    requestPlanApproval,
  };
}

function toolNames(registry: ToolRegistry): string[] {
  return registry.schemas().map((schema) => schema.function.name);
}
