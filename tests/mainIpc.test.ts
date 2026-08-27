import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, MAX_TASK_CHARS } from "../src/desktop/contracts";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const electronMocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  dialog: vi.fn(),
  handle: vi.fn(),
  openExternal: vi.fn(async () => undefined),
}));

const projectMocks = vi.hoisted(() => ({
  readProjectFile: vi.fn(),
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
    limited: false,
  });
  projectMocks.readProjectFile.mockResolvedValue({
    relativePath: "README.md",
    content: "demo",
    size: 4,
    language: "Markdown",
  });
});

describe("main-process IPC boundary", () => {
  it("registers every request channel once and never registers event channels", async () => {
    await registerWithStores();

    const registered = electronMocks.handle.mock.calls.map((call) => call[0]);
    expect(registered).toHaveLength(14);
    expect(new Set(registered).size).toBe(14);
    expect(registered).not.toContain(IPC_CHANNELS.agentEvent);
    expect(registered).not.toContain(IPC_CHANNELS.approvalRequested);
    expect(registered).not.toContain(IPC_CHANNELS.changesUpdated);
  });

  it("selects a project and validates renderer-controlled file and memory inputs", async () => {
    const { contextStore } = await registerWithStores();

    await expect(invoke(IPC_CHANNELS.selectProject)).resolves.toMatchObject({ name: "demo" });
    expect(projectMocks.scanProject).toHaveBeenCalledWith("C:\\workspace\\demo");

    await expect(invoke(IPC_CHANNELS.readFile, 42)).rejects.toThrow("文件路径无效");
    await expect(invoke(IPC_CHANNELS.readFile, "README.md")).resolves.toMatchObject({
      language: "Markdown",
    });
    expect(projectMocks.readProjectFile).toHaveBeenCalledWith(
      "C:\\workspace\\demo",
      "README.md",
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
      invoke(IPC_CHANNELS.startRun, { task: "Inspect", skillIds: ["safe", 7] }),
    ).rejects.toThrow("Skill 选择无效");
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
    };

    await invoke(IPC_CHANNELS.saveSettings, input);
    expect(configStore.save).toHaveBeenCalledWith(input);
    await invoke(IPC_CHANNELS.openModelScopeTokenPage);
    expect(electronMocks.openExternal).toHaveBeenCalledWith(
      "https://modelscope.cn/my/myaccesstoken",
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
      hasApiKey: false,
      apiKeySource: "missing",
    })),
    save: vi.fn(async () => undefined),
  };
  const contextStore = {
    getContext: vi.fn(async () => ({ skills: [], memory: "" })),
    getMemory: vi.fn(async () => ""),
    getSelectedSkills: vi.fn(async () => []),
    saveMemory: vi.fn(async () => ({ skills: [], memory: "Use pnpm test" })),
  };
  const historyStore = {
    finishRun: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(async () => []),
    startRun: vi.fn(),
  };
  registerIpc(configStore as never, contextStore as never, historyStore as never);
  return { configStore, contextStore, historyStore };
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const call = electronMocks.handle.mock.calls.find((entry) => entry[0] === channel);
  expect(call, `missing IPC handler for ${channel}`).toBeDefined();
  return (call?.[1] as IpcHandler)({}, ...args);
}
