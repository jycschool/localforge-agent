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
      skillIds: ["review", "review"],
    });

    expect(await store.listRuns(projectPath, id)).toMatchObject([
      { id, status: "running", skillIds: ["review"] },
    ]);
    expect(await store.listRuns(projectPath)).toMatchObject([
      { id, status: "interrupted", summary: "应用关闭前任务未正常结束。" },
    ]);
    expect(await store.listRuns(secondProjectPath)).toEqual([]);
  });

  it("persists a bounded task result without model reasoning content", async () => {
    const id = await store.startRun(projectPath, { task: "运行测试" });
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
    });

    const detail = await store.getRun(projectPath, id);
    expect(detail).toMatchObject({
      status: "completed",
      summary: "测试通过。",
      steps: 2,
      eventCount: 2,
      changedFiles: ["src/main.ts"],
    });
    expect(detail.messages[1]).toEqual({ role: "assistant", content: "测试通过。" });
  });

  it("rejects invalid or cross-project history identifiers", async () => {
    const id = await store.startRun(projectPath, { task: "检查项目" });

    await expect(store.getRun(projectPath, "../index")).rejects.toThrow("ID 无效");
    await expect(store.getRun(secondProjectPath, id)).rejects.toThrow("找不到");
  });
});
