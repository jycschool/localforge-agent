import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop, type AgentRunResult } from "./agent/agentLoop";
import { ChangeTracker } from "./agent/changeTracker";
import { buildSystemPrompt } from "./agent/systemPrompt";
import { ToolRegistry } from "./agent/toolRegistry";
import type { AgentEvent, CommandApprovalRequest } from "./core/protocol";
import { ConfigStore } from "./desktop/configStore";
import {
  IPC_CHANNELS,
  type ChangedFileSnapshot,
  type RunRequest,
  type SettingsInput,
} from "./desktop/contracts";
import { readProjectFile, scanProject } from "./desktop/projectService";
import { ProjectContextStore } from "./desktop/projectContextStore";
import { RunHistoryStore } from "./desktop/runHistoryStore";
import { OpenAICompatibleClient } from "./model/openAICompatibleClient";
import { createWorkspaceTools } from "./tools/workspaceTools";

let mainWindow: BrowserWindow | null = null;
let projectRoot: string | null = null;
let activeController: AbortController | null = null;
let activeRunId: string | null = null;
const changeTracker = new ChangeTracker();
const approvalResolvers = new Map<string, (approved: boolean) => void>();
const MODELSCOPE_TOKEN_URL = "https://modelscope.cn/my/myaccesstoken";

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#0b0d10",
    title: "LocalForge",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  void mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    activeController?.abort();
    resolveAllApprovals(false);
    mainWindow = null;
  });
}

export function registerIpc(
  configStore: ConfigStore,
  contextStore: ProjectContextStore,
  historyStore: RunHistoryStore,
): void {
  ipcMain.handle(IPC_CHANNELS.selectProject, async () => {
    if (activeController) {
      throw new Error("Agent 运行期间不能切换项目。");
    }
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "选择一个本地项目",
      properties: ["openDirectory"],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    const selected = selection.filePaths[0];
    if (selection.canceled || !selected) {
      return null;
    }
    projectRoot = selected;
    changeTracker.clear();
    return scanProject(selected);
  });

  ipcMain.handle(IPC_CHANNELS.refreshProject, async () =>
    projectRoot ? scanProject(projectRoot) : null,
  );

  ipcMain.handle(IPC_CHANNELS.readFile, async (_event, relativePath: unknown) => {
    const rootPath = requireProject();
    if (typeof relativePath !== "string") {
      throw new Error("文件路径无效。");
    }
    return readProjectFile(rootPath, relativePath);
  });

  ipcMain.handle(IPC_CHANNELS.getProjectContext, () =>
    contextStore.getContext(requireProject()),
  );
  ipcMain.handle(IPC_CHANNELS.saveProjectMemory, (_event, memory: unknown) => {
    if (typeof memory !== "string") {
      throw new Error("项目记忆内容无效。");
    }
    return contextStore.saveMemory(requireProject(), memory);
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, () => configStore.publicSettings());
  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, input: SettingsInput) =>
    configStore.save(input),
  );
  ipcMain.handle(IPC_CHANNELS.openModelScopeTokenPage, async () => {
    await shell.openExternal(MODELSCOPE_TOKEN_URL);
  });

  ipcMain.handle(IPC_CHANNELS.listRunHistory, () =>
    historyStore.listRuns(requireProject(), activeRunId),
  );
  ipcMain.handle(IPC_CHANNELS.getRunHistory, (_event, id: unknown) => {
    if (typeof id !== "string") {
      throw new Error("任务历史 ID 无效。");
    }
    return historyStore.getRun(requireProject(), id, activeRunId);
  });

  ipcMain.handle(IPC_CHANNELS.startRun, async (_event, input: unknown) => {
    const rootPath = requireProject();
    const request = parseRunRequest(input);
    if (activeController) {
      return { started: false, message: "已有任务正在运行。" };
    }
    const task = request.task?.trim();
    if (!task) {
      return { started: false, message: "请输入任务说明。" };
    }
    const settings = await configStore.publicSettings();
    const apiKey = await configStore.apiKey();
    if (!apiKey) {
      return { started: false, message: "请先在设置中填写 API Key。" };
    }
    const [memory, skills] = await Promise.all([
      contextStore.getMemory(rootPath),
      contextStore.getSelectedSkills(rootPath, request.skillIds),
    ]);

    changeTracker.clear();
    const tools = await createWorkspaceTools({
      rootPath,
      changeTracker,
      commandTimeoutMs: settings.commandTimeoutMs,
      maxOutputChars: settings.maxOutputChars,
    });
    const controller = new AbortController();
    const runId = await historyStore.startRun(rootPath, {
      task,
      selectedFile: request.selectedFile,
      skillIds: request.skillIds,
    });
    activeController = controller;
    activeRunId = runId;
    const runEvents: AgentEvent[] = [];
    const recordAndSendEvent = (event: AgentEvent): void => {
      runEvents.push(event);
      sendAgentEvent(event);
    };
    const loop = new AgentLoop(
      new OpenAICompatibleClient({
        apiBaseUrl: settings.apiBaseUrl,
        apiKey,
        model: settings.model,
      }),
      new ToolRegistry(tools),
    );
    const contextualTask = request.selectedFile
      ? `${task}\n\nThe user currently has ${request.selectedFile} selected in the read-only preview.`
      : task;
    void (async () => {
      let result: AgentRunResult | null = null;
      try {
        result = await loop.run({
        task: contextualTask,
        systemPrompt: buildSystemPrompt({ memory, skills }),
        maxSteps: settings.maxSteps,
        signal: controller.signal,
        onEvent: recordAndSendEvent,
        requestCommandApproval: requestApproval,
        });
        const changes = await collectChangesSafely(rootPath);
        await historyStore.finishRun(rootPath, runId, {
          status: result.status,
          summary: result.summary,
          steps: result.steps,
          events: runEvents,
          messages: result.messages,
          changedFiles: changes.map((change) => change.relativePath),
        });
        mainWindow?.webContents.send(IPC_CHANNELS.changesUpdated, changes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const changes = await collectChangesSafely(rootPath);
        if (result) {
          console.error("Failed to finalize run history", error);
        } else {
          const failure: AgentEvent = { type: "run_failed", message, steps: 0 };
          recordAndSendEvent(failure);
          try {
            await historyStore.finishRun(rootPath, runId, {
              status: "failed",
              summary: message,
              steps: 0,
              events: runEvents,
              messages: [],
              changedFiles: changes.map((change) => change.relativePath),
            });
          } catch (historyError) {
            console.error("Failed to finalize run history", historyError);
          }
        }
        mainWindow?.webContents.send(IPC_CHANNELS.changesUpdated, changes);
      } finally {
        activeController = null;
        activeRunId = null;
        resolveAllApprovals(false);
      }
    })();
    return { started: true };
  });

  ipcMain.handle(IPC_CHANNELS.stopRun, () => {
    if (!activeController) {
      return false;
    }
    activeController.abort();
    resolveAllApprovals(false);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.getChanges, () =>
    projectRoot ? collectChanges(projectRoot) : [],
  );

  ipcMain.handle(
    IPC_CHANNELS.answerApproval,
    (_event, id: unknown, approved: unknown) => {
      if (typeof id !== "string" || typeof approved !== "boolean") {
        return false;
      }
      const resolve = approvalResolvers.get(id);
      if (!resolve) {
        return false;
      }
      approvalResolvers.delete(id);
      resolve(approved);
      return true;
    },
  );
}

function parseRunRequest(input: unknown): RunRequest {
  if (!input || typeof input !== "object") {
    throw new Error("任务请求无效。");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.task !== "string") {
    throw new Error("任务说明必须是文本。");
  }
  if (value.selectedFile !== undefined && typeof value.selectedFile !== "string") {
    throw new Error("当前文件路径无效。");
  }
  if (
    value.skillIds !== undefined &&
    (!Array.isArray(value.skillIds) || value.skillIds.some((id) => typeof id !== "string"))
  ) {
    throw new Error("Skill 选择无效。");
  }
  return {
    task: value.task,
    selectedFile: value.selectedFile as string | undefined,
    skillIds: value.skillIds as string[] | undefined,
  };
}

function requireProject(): string {
  if (!projectRoot) {
    throw new Error("请先打开一个项目目录。");
  }
  return projectRoot;
}

function sendAgentEvent(event: AgentEvent): void {
  mainWindow?.webContents.send(IPC_CHANNELS.agentEvent, event);
}

function requestApproval(request: CommandApprovalRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    approvalResolvers.set(request.id, resolve);
    mainWindow?.webContents.send(IPC_CHANNELS.approvalRequested, request);
  });
}

function resolveAllApprovals(approved: boolean): void {
  for (const resolve of approvalResolvers.values()) {
    resolve(approved);
  }
  approvalResolvers.clear();
}

async function collectChanges(rootPath: string): Promise<ChangedFileSnapshot[]> {
  return Promise.all(
    changeTracker.list().map(async (change) => ({
      relativePath: change.relativePath,
      originalContent: change.originalContent,
      currentContent: await readFile(path.join(rootPath, change.relativePath), "utf8"),
    })),
  );
}

async function collectChangesSafely(rootPath: string): Promise<ChangedFileSnapshot[]> {
  try {
    return await collectChanges(rootPath);
  } catch (error) {
    console.error("Failed to collect changed files", error);
    return [];
  }
}

app.whenReady().then(() => {
  const userDataPath = app.getPath("userData");
  registerIpc(
    new ConfigStore(),
    new ProjectContextStore(userDataPath),
    new RunHistoryStore(userDataPath),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
