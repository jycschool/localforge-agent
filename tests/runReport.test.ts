import { describe, expect, it } from "vitest";
import { formatRunReport } from "../src/desktop/runReport";

describe("run evidence report", () => {
  it("exports task metadata and observable evidence without hidden reasoning", () => {
    const report = formatRunReport("demo", {
      id: "8d1de53e-4e1b-4b14-8db1-c102a2c71234",
      task: "修复登录校验",
      status: "completed",
      summary: "已修复并通过测试。",
      steps: 2,
      selectedFile: "src/login.ts",
      attachmentPaths: ["README.md"],
      skillIds: [".localforge/skills/test.md"],
      memoryUsed: true,
      model: "qwen-test",
      modelProfileName: "课程演示",
      permissionMode: "workspace",
      responseProfile: "balanced",
      executionMode: "plan",
      eventCount: 2,
      changedFiles: ["src/login.ts"],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
      events: [
        { type: "model_usage", step: 1, promptTokens: 20, completionTokens: 5, totalTokens: 25, estimated: false },
        { type: "completion_blocked", step: 1, message: "尚未核验" },
        { type: "run_completed", summary: "已完成", steps: 2 },
      ],
      plan: {
        revision: 1,
        state: "completed",
        explanation: "修复并验证",
        items: [{ id: "step-1", title: "修复登录校验", status: "completed" }],
        verification: ["登录测试通过"],
        remaining: [],
      },
      messages: [{ role: "assistant", content: "done", reasoning_content: "private" }],
    });

    expect(report).toContain("# RepoForge 代码锻造智能体任务证据报告");
    expect(report).toContain("qwen-test");
    expect(report).toContain("25 Token");
    expect(report).toContain("src/login.ts");
    expect(report).toContain("执行模式：先规划");
    expect(report).toContain("修复登录校验");
    expect(report).toContain("登录测试通过");
    expect(report).toContain("完成门禁");
    expect(report).not.toContain("private");
    expect(report).toContain("不包含模型隐藏思考过程");
  });
});
