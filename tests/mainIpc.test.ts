import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  MAX_ATTACHMENT_FILES,
  MAX_TASK_CHARS,
} from "../src/desktop/contracts";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const electronMocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  dialog: vi.fn(),
  handle: vi.fn(),
  openExternal: vi.fn(async () => undefined),
}));

const projectMocks = vi.hoisted(() => ({
  createProjectFile: vi.fn(),
  readProjectFile: vi.fn(),
  saveProjectFile: vi.fn(),
  scanProject: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "C:\\LocalForge-test"),
    on: electronMocks.appOn,
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
  dialog: { showOpenDialog: electronMocks.dialog },
  ipcMain: { handle: electronMocks.handle },
  shell: { openExternal: electronMocks.openExternal },
}));

vi.mock("../src/desktop/projectService.js", () => projectMocks);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  electronMocks.dialog.mockResolvedValue({
    canceled: false,
    filePaths: ["C:\\workspace\\demo"],
  });
  projectMocks.scanProject.mockResolvedValue({
    name: "demo",
    rootPath: "C:\\workspace\\demo",
    files: [],
  });
  projectMocks.readProjectFile.mockResolvedValue({
    relativePath: "README.md",
    content: "demo",
    size: 4,
    language: "Markdown",
    contentHash: "a".repeat(64),
  });
  projectMocks.saveProjectFile.mockResolvedValue({
    relativePath: "README.md",
    content: "saved",
    size: 5,
    language: "Markdown",
    contentHash: "b".repeat(64),
  });
  projectMocks.createProjectFile.mockResolvedValue({
    relativePath: "notes.md",
    content: "new",
    size: 3,
    language: "Markdown",
    contentHash: "c".repeat(64),
  });
});

describe("main-process IPC boundary", () => {
  it("registers every request channel once and never registers event channels", async () => {
    await registerWithStores();

    const registered = electronMocks.handle.mock.calls.map((call) => call[0]);
    expect(registered).toHaveLength(33);
    expect(new Set(registered).size).toBe(33);
    expect(registered).not.toContain(IPC_CHANNELS.agentEvent);
    expect(registered).not.toContain(IPC_CHANNELS.approvalRequested);
    expect(registered).not.toContain(IPC_CHANNELS.changesUpdated);
  });

  it("validates and routes Skill, Memory, and conversation management", async () => {
    const { contextStore, historyStore } = await registerWithStores();
    await invoke(IPC_CHANNELS.selectProject);

    await expect(invoke(IPC_CHANNELS.getProjectSkill, 7)).rejects.toThrow("Skill ID 无效");
    await expect(invoke(IPC_CHANNELS.saveProjectSkill, null)).rejects.toThrow(
      "Skill 内容无效",
    );
    await expect(
      invoke(IPC_CHANNELS.saveProjectSkill, { fileName: "test.md", content: 7 }),
    ).rejects.toThrow("必须是文本");
    await invoke(IPC_CHANNELS.saveProjectSkill, {
      fileName: "test.md",
      content: "# Test",
    });
    expect(contextStore.saveSkill).toHaveBeenCalledWith("C:\\workspace\\demo", {
      fileName: "test.md",
      content: "# Test",
    });

    await invoke(IPC_CHANNELS.deleteProjectSkill, ".localforge/skills/test.md");
    expect(contextStore.deleteSkill).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      ".localforge/skills/test.md",
    );
    await invoke(IPC_CHANNELS.deleteProjectMemory);
    expect(contextStore.deleteMemory).toHaveBeenCalledWith("C:\\workspace\\demo");

    await expect(invoke(IPC_CHANNELS.deleteRunConversation, {})).rejects.toThrow(
      "任务历史 ID 无效",
    );
    await expect(invoke(IPC_CHANNELS.deleteRunConversation, "run-1")).resolves.toEqual({
      deletedCount: 2,
    });
    expect(historyStore.deleteConversation).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      "run-1",
    );
  });

  it("selects a project and validates renderer-controlled file and memory inputs", async () => {
    const { contextStore, workspaceStateStore } = await registerWithStores();

    await expect(invoke(IPC_CHANNELS.selectProject)).resolves.toMatchObject({ name: "demo" });
    expect(projectMocks.scanProject).toHaveBeenCalledWith("C:\\workspace\\demo");
    expect(workspaceStateStore.saveLastProjectPath).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
    );

    await expect(invoke(IPC_CHANNELS.readFile, 42)).rejects.toThrow("文件路径无效");
    await expect(invoke(IPC_CHANNELS.readFile, "README.md")).resolves.toMatchObject({
      language: "Markdown",
    });
    expect(projectMocks.readProjectFile).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      "README.md",
    );

    await expect(invoke(IPC_CHANNELS.saveFile, null)).rejects.toThrow(
      "文件保存请求无效",
    );
    await expect(
      invoke(IPC_CHANNELS.saveFile, { relativePath: "README.md", content: 7 }),
    ).rejects.toThrow("文件保存请求无效");
    await expect(
      invoke(IPC_CHANNELS.saveFile, {
        relativePath: "README.md",
        content: "saved",
        expectedHash: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ file: { content: "saved" } });
    expect(projectMocks.saveProjectFile).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      "README.md",
      "saved",
      "a".repeat(64),
    );

    await expect(
      invoke(IPC_CHANNELS.createFile, { relativePath: 7, content: "" }),
    ).rejects.toThrow("新建文件请求无效");
    await expect(
      invoke(IPC_CHANNELS.createFile, { relativePath: "notes.md", content: "new" }),
    ).resolves.toMatchObject({ file: { relativePath: "notes.md" } });
    expect(projectMocks.createProjectFile).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      "notes.md",
      "new",
    );

    await expect(invoke(IPC_CHANNELS.saveProjectMemory, null)).rejects.toThrow(
      "项目记忆内容无效",
    );
    await invoke(IPC_CHANNELS.saveProjectMemory, "Use pnpm test");
    expect(contextStore.saveMemory).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      "Use pnpm test",
    );
  });

  it("restores only the persisted project and clears an inaccessible path", async () => {
    const { workspaceStateStore } = await registerWithStores();

    await expect(invoke(IPC_CHANNELS.restoreProject)).resolves.toMatchObject({ name: "demo" });
    expect(projectMocks.scanProject).toHaveBeenCalledWith("C:\\workspace\\demo");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      projectMocks.scanProject.mockRejectedValueOnce(new Error("missing"));
      await expect(invoke(IPC_CHANNELS.restoreProject)).resolves.toBeNull();
      expect(workspaceStateStore.clearLastProjectPath).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        "Failed to restore the last project",
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects malformed history and approval inputs before they reach stores", async () => {
    const { historyStore } = await registerWithStores();
    await invoke(IPC_CHANNELS.selectProject);

    await expect(invoke(IPC_CHANNELS.getRunHistory, {})).rejects.toThrow(
      "任务历史 ID 无效",
    );
    expect(historyStore.getRun).not.toHaveBeenCalled();

    await expect(invoke(IPC_CHANNELS.answerApproval, 7, true)).resolves.toBe(false);
    await expect(invoke(IPC_CHANNELS.answerApproval, "missing", "yes")).resolves.toBe(false);
    await expect(invoke(IPC_CHANNELS.answerApproval, "missing", true)).resolves.toBe(false);
  });

  it("returns safe start/stop states without entering the model loop", async () => {
    const { configStore } = await registerWithStores();
    await invoke(IPC_CHANNELS.selectProject);

    await expect(invoke(IPC_CHANNELS.startRun, { task: "   " })).resolves.toEqual({
      started: false,
      message: "请输入任务说明。",
    });
    expect(configStore.apiKey).not.toHaveBeenCalled();

    await expect(invoke(IPC_CHANNELS.startRun, { task: "Inspect" })).resolves.toEqual({
      started: false,
      message: "请先在设置中填写 API Key。",
    });
    expect(configStore.apiKey).toHaveBeenCalledOnce();
    await expect(invoke(IPC_CHANNELS.stopRun)).resolves.toBe(false);
  });

  it("rejects malformed run requests at the IPC boundary", async () => {
    const { configStore } = await registerWithStores();
    await invoke(IPC_CHANNELS.selectProject);

    await expect(invoke(IPC_CHANNELS.startRun, null)).rejects.toThrow("任务请求无效");
    await expect(invoke(IPC_CHANNELS.startRun, { task: 7 })).rejects.toThrow(
      "任务说明必须是文本",
    );
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "x".repeat(MAX_TASK_CHARS + 1) }),
    ).rejects.toThrow("任务说明不能超过 20,000 个字符");
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", selectedFile: 7 }),
    ).rejects.toThrow("当前文件路径无效");
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", attachmentPaths: "README.md" }),
    ).rejects.toThrow("附件选择无效");
    await expect(
      invoke(IPC_CHANNELS.startRun, {
        task: "Inspect",
        attachmentPaths: Array.from(
          { length: MAX_ATTACHMENT_FILES + 1 },
          (_, index) => `${index}.txt`,
        ),
      }),
    ).rejects.toThrow(`一次最多添加 ${MAX_ATTACHMENT_FILES} 个项目文件`);
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", attachmentPaths: ["README.md", 7] }),
    ).rejects.toThrow("附件选择无效");
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", skillIds: ["safe", 7] }),
    ).rejects.toThrow("Skill 选择无效");
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", useMemory: "yes" }),
    ).rejects.toThrow("Memory 选择无效");
    await expect(
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", continueFromRunId: 7 }),
    ).rejects.toThrow("历史对话选择无效");
    await expect(invoke(IPC_CHANNELS.previewRunContext, null)).rejects.toThrow(
      "任务请求无效",
    );
    await expect(invoke(IPC_CHANNELS.previewRunContext, { task: "   " })).rejects.toThrow(
      "请先输入任务说明",
    );
    await expect(invoke(IPC_CHANNELS.restoreChanges, null)).rejects.toThrow(
      "恢复请求无效",
    );
    await expect(invoke(IPC_CHANNELS.exportRunReport, 7)).rejects.toThrow(
      "任务历史 ID 无效",
    );
    expect(configStore.publicSettings).not.toHaveBeenCalled();
  });

  it("keeps settings and external navigation behind fixed handlers", async () => {
    const { configStore } = await registerWithStores();
    const input = {
      apiBaseUrl: "https://example.test/v1",
      model: "coder",
      maxSteps: 8,
      commandTimeoutMs: 10_000,
      maxOutputChars: 5_000,
      permissionMode: "workspace",
      responseProfile: "balanced",
    };

    await expect(invoke(IPC_CHANNELS.saveSettings, null)).rejects.toThrow(
      "模型设置内容无效",
    );
    await invoke(IPC_CHANNELS.saveSettings, input);
    expect(configStore.save).toHaveBeenCalledWith(input);
    await expect(invoke(IPC_CHANNELS.getModelProfiles)).resolves.toMatchObject({
      activeProfileId: "default",
    });
    await expect(invoke(IPC_CHANNELS.saveModelProfile, null)).rejects.toThrow(
      "模型配置内容无效",
    );
    await invoke(IPC_CHANNELS.saveModelProfile, { ...input, name: "课程演示" });
    expect(configStore.saveModelProfile).toHaveBeenCalledWith({
      ...input,
      name: "课程演示",
    });
    await expect(invoke(IPC_CHANNELS.activateModelProfile, 7)).rejects.toThrow(
      "模型配置 ID 无效",
    );
    await invoke(IPC_CHANNELS.activateModelProfile, "profile-2");
    expect(configStore.activateModelProfile).toHaveBeenCalledWith("profile-2");
    await invoke(IPC_CHANNELS.deleteModelProfile, "profile-2");
    expect(configStore.deleteModelProfile).toHaveBeenCalledWith("profile-2");
    await invoke(IPC_CHANNELS.openModelScopeTokenPage);
    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      "https://modelscope.cn/my/myaccesstoken",
    );
    await expect(invoke(IPC_CHANNELS.testModelConnection)).rejects.toThrow(
      "请先保存 API Key",
    );
  });
});

async function registerWithStores() {
  const { registerIpc } = await import("../src/main.js");
  const configStore = {
    apiKey: vi.fn(async () => null),
    publicSettings: vi.fn(async () => ({
      apiBaseUrl: "https://example.test/v1",
      model: "coder",
      maxSteps: 8,
      commandTimeoutMs: 10_000,
      maxOutputChars: 5_000,
      permissionMode: "workspace",
      responseProfile: "balanced",
      hasApiKey: false,
      apiKeySource: "missing",
    })),
    save: vi.fn(async () => undefined),
    modelProfiles: vi.fn(async () => ({
      activeProfileId: "default",
      profiles: [],
      maxProfiles: 12,
    })),
    saveModelProfile: vi.fn(async () => ({
      activeProfileId: "default",
      profiles: [],
      maxProfiles: 12,
    })),
    activateModelProfile: vi.fn(async () => undefined),
    deleteModelProfile: vi.fn(async () => ({
      activeProfileId: "default",
      profiles: [],
      maxProfiles: 12,
    })),
    recordActiveDiagnostic: vi.fn(async () => undefined),
  };
  const contextStore = {
    deleteMemory: vi.fn(async () => ({ skills: [], memory: "" })),
    deleteSkill: vi.fn(async () => ({ skills: [], memory: "" })),
    getContext: vi.fn(async () => ({ skills: [], memory: "" })),
    getMemory: vi.fn(async () => ""),
    getSkill: vi.fn(async () => ({ id: "test", content: "# Test" })),
    getSelectedSkills: vi.fn(async () => []),
    saveMemory: vi.fn(async () => ({ skills: [], memory: "Use pnpm test" })),
    saveSkill: vi.fn(async () => ({ skills: [], memory: "" })),
  };
  const historyStore = {
    deleteConversation: vi.fn(async () => 2),
    finishRun: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(async () => []),
    startRun: vi.fn(),
  };
  const workspaceStateStore = {
    clearLastProjectPath: vi.fn(async () => undefined),
    lastProjectPath: vi.fn(async () => "C:\\workspace\\demo"),
    saveLastProjectPath: vi.fn(async () => undefined),
  };
  registerIpc(
    configStore as never,
    contextStore as never,
    historyStore as never,
    workspaceStateStore as never,
  );
  return { configStore, contextStore, historyStore, workspaceStateStore };
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const call = electronMocks.handle.mock.calls.find((entry) => entry[0] === channel);
  expect(call, `missing IPC handler for ${channel}`).toBeDefined();
  return (call?.[1] as IpcHandler)({}, ...args);
}
