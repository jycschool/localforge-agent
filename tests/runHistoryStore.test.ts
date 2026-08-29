import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunHistoryStore } from "../src/desktop/runHistoryStore";

describe("run history store", () => {
  let temporaryRoot: string;
  let projectPath: string;
  let secondProjectPath: string;
  let store: RunHistoryStore;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "localforge-history-"));
    projectPath = path.join(temporaryRoot, "project");
    secondProjectPath = path.join(temporaryRoot, "second-project");
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(secondProjectPath, { recursive: true }),
    ]);
    store = new RunHistoryStore(path.join(temporaryRoot, "app-data"));
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("isolates projects and marks abandoned running tasks as interrupted", async () => {
    const id = await store.startRun(projectPath, {
      task: "整理前端结构",
      selectedFile: "src/renderer/app.ts",
      attachmentPaths: ["README.md", "README.md", "docs/design.md"],
      skillIds: ["review", "review"],
      memoryUsed: true,
      model: "qwen-test",
      permissionMode: "workspace",
      responseProfile: "balanced",
    });

    expect(await store.listRuns(projectPath, id)).toMatchObject([
      {
        id,
        status: "running",
        attachmentPaths: ["README.md", "docs/design.md"],
        skillIds: ["review"],
        memoryUsed: true,
        model: "qwen-test",
        permissionMode: "workspace",
        responseProfile: "balanced",
      },
    ]);
    expect(await store.listRuns(projectPath)).toMatchObject([
      { id, status: "interrupted", summary: "应用关闭前任务未正常结束。" },
    ]);
    expect(await store.listRuns(secondProjectPath)).toEqual([]);
  });

  it("persists a bounded task result without model reasoning content", async () => {
    const id = await store.startRun(projectPath, { task: "运行测试", executionMode: "plan" });
    await store.finishRun(projectPath, id, {
      status: "completed",
      summary: "测试通过。",
      steps: 2,
      events: [
        { type: "run_started", task: "运行测试" },
        { type: "run_completed", summary: "测试通过。", steps: 2 },
      ],
      messages: [
        { role: "user", content: "运行测试" },
        {
          role: "assistant",
          content: "测试通过。",
          reasoning_content: "private chain of thought",
        },
      ],
      changedFiles: ["src/main.ts", "src/main.ts"],
      outcome: {
        changedFileCount: 1,
        additions: 4,
        deletions: 1,
        lineStatsEstimated: false,
        toolCalls: 2,
        commandCalls: 1,
        successfulToolCalls: 2,
        failedToolCalls: 0,
        toolDurationMs: 120,
        testCount: 6,
        tokenUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, estimated: false },
      },
      plan: {
        revision: 1,
        state: "completed",
        explanation: "运行并核验测试",
        items: [{ id: "test", title: "运行测试", status: "completed" }],
        verification: ["测试通过"],
        remaining: [],
      },
    });

    const detail = await store.getRun(projectPath, id);
    expect(detail).toMatchObject({
      status: "completed",
      summary: "测试通过。",
      steps: 2,
      eventCount: 2,
      changedFiles: ["src/main.ts"],
      executionMode: "plan",
      outcome: { changedFileCount: 1, testCount: 6, toolCalls: 2 },
      plan: {
        state: "completed",
        verification: ["测试通过"],
      },
    });
    expect(detail.messages[1]).toEqual({ role: "assistant", content: "测试通过。" });
  });

  it("rejects invalid or cross-project history identifiers", async () => {
    const id = await store.startRun(projectPath, { task: "检查项目" });

    await expect(store.getRun(projectPath, "../index")).rejects.toThrow("ID 无效");
    await expect(store.getRun(secondProjectPath, id)).rejects.toThrow("找不到");
  });

  it("rebuilds a bounded conversational chain when a later task continues history", async () => {
    const parentId = await store.startRun(projectPath, { task: "检查登录流程" });
    await store.finishRun(projectPath, parentId, {
      status: "completed",
      summary: "发现用户名没有去除首尾空格。",
      steps: 1,
      events: [],
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "检查登录流程" },
        { role: "assistant", content: "发现用户名没有去除首尾空格。" },
      ],
      changedFiles: [],
    });
    const childId = await store.startRun(projectPath, {
      task: "那就修复它",
      continuedFromRunId: parentId,
    });
    await store.finishRun(projectPath, childId, {
      status: "completed",
      summary: "已经修复并补充测试。",
      steps: 2,
      events: [],
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "那就修复它" },
        { role: "assistant", content: "已经修复并补充测试。" },
      ],
      changedFiles: ["src/login.ts"],
    });

    await expect(store.getRun(projectPath, childId)).resolves.toMatchObject({
      continuedFromRunId: parentId,
    });
    await expect(store.getContinuationMessages(projectPath, childId)).resolves.toEqual([
      { role: "user", content: "检查登录流程" },
      { role: "assistant", content: "发现用户名没有去除首尾空格。" },
      { role: "user", content: "那就修复它" },
      { role: "assistant", content: "已经修复并补充测试。" },
    ]);
  });

  it("deletes a complete conversation chain without touching other conversations", async () => {
    const parentId = await store.startRun(projectPath, { task: "第一问" });
    const childId = await store.startRun(projectPath, {
      task: "继续追问",
      continuedFromRunId: parentId,
    });
    const unrelatedId = await store.startRun(projectPath, { task: "另一段会话" });

    await expect(store.deleteConversation(projectPath, childId)).resolves.toBe(2);

    expect((await store.listRuns(projectPath)).map((run) => run.id)).toEqual([unrelatedId]);
    await expect(store.getRun(projectPath, parentId)).rejects.toThrow("找不到");
    await expect(store.getRun(projectPath, childId)).rejects.toThrow("找不到");
    await expect(store.getRun(projectPath, unrelatedId)).resolves.toMatchObject({
      task: "另一段会话",
    });
  });
});
