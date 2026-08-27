import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "./agent/agentLoop";
import { ChangeTracker } from "./agent/changeTracker";
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
import { OpenAICompatibleClient } from "./model/openAICompatibleClient";
import { createWorkspaceTools } from "./tools/workspaceTools";

let mainWindow: BrowserWindow | null = null;
let projectRoot: string | null = null;
let activeController: AbortController | null = null;
const changeTracker = new ChangeTracker();
const approvalResolvers = new Map<string, (approved: boolean) => void>();

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

function registerIpc(configStore: ConfigStore): void {
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

  ipcMain.handle(IPC_CHANNELS.getSettings, () => configStore.publicSettings());
  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, input: SettingsInput) =>
    configStore.save(input),
  );

  ipcMain.handle(IPC_CHANNELS.startRun, async (_event, request: RunRequest) => {
    const rootPath = requireProject();
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

    changeTracker.clear();
    const tools = await createWorkspaceTools({
      rootPath,
      changeTracker,
      commandTimeoutMs: settings.commandTimeoutMs,
      maxOutputChars: settings.maxOutputChars,
    });
    const controller = new AbortController();
    activeController = controller;
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

    void loop
      .run({
        task: contextualTask,
        systemPrompt: buildSystemPrompt(),
        maxSteps: settings.maxSteps,
        signal: controller.signal,
        onEvent: sendAgentEvent,
        requestCommandApproval: requestApproval,
      })
      .finally(async () => {
        activeController = null;
        resolveAllApprovals(false);
        const changes = await collectChanges(rootPath);
        mainWindow?.webContents.send(IPC_CHANNELS.changesUpdated, changes);
      })
      .catch((error: unknown) => {
        sendAgentEvent({
          type: "run_failed",
          message: error instanceof Error ? error.message : String(error),
          steps: 0,
        });
      });
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

function buildSystemPrompt(): string {
  return [
    "You are LocalForge, a transparent coding agent working only inside the opened project.",
    "Inspect relevant files before editing and keep changes narrowly scoped to the user's task.",
    "Use workspace tools for every file operation. Never invent file contents.",
    "Before running a command, provide a clear reason; the desktop app will ask the user for approval.",
    "After making changes, run the smallest relevant verification when possible and summarize the result.",
  ].join(" ");
}

app.whenReady().then(() => {
  registerIpc(new ConfigStore());
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
