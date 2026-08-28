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
      eventCount: 2,
      changedFiles: ["src/login.ts"],
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
      events: [
        { type: "model_usage", step: 1, promptTokens: 20, completionTokens: 5, totalTokens: 25, estimated: false },
        { type: "run_completed", summary: "已完成", steps: 2 },
      ],
      messages: [{ role: "assistant", content: "done", reasoning_content: "private" }],
    });

    expect(report).toContain("# LocalForge 任务证据报告");
    expect(report).toContain("qwen-test");
    expect(report).toContain("25 Token");
    expect(report).toContain("src/login.ts");
    expect(report).not.toContain("private");
    expect(report).toContain("不包含模型隐藏思考过程");
  });
});
