import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentLoop, type AgentRunResult } from "./agent/agentLoop";
import { ChangeTracker } from "./agent/changeTracker";
import { collectTrackedChanges, restoreTrackedChanges } from "./agent/changeRestore";
import { toolsForPermission } from "./agent/permissions";
import { PlanController } from "./agent/planController";
import { buildSystemPrompt } from "./agent/systemPrompt";
import { buildContextualTask, messagesForRunHistory } from "./agent/taskContext";
import { ToolRegistry } from "./agent/toolRegistry";
import type {
  AgentEvent,
  CommandApprovalRequest,
  PlanApprovalDecision,
  PlanApprovalRequest,
} from "./core/protocol";
import { ConfigStore } from "./desktop/configStore";
import {
  IPC_CHANNELS,
  MAX_ATTACHMENT_FILES,
  MAX_TASK_CHARS,
  type ChangedFileSnapshot,
  type FileSnapshot,
  type ManualFileCreateRequest,
  type ManualFileSaveRequest,
  type ModelProfileInput,
  type ProjectSkillInput,
  type RestoreChangedFilesRequest,
  type RunRequest,
  type SettingsInput,
} from "./desktop/contracts";
import {
  createProjectFile,
  isPathInside,
  readProjectFile,
  saveProjectFile,
  scanProject,
} from "./desktop/projectService";
import { ProjectContextStore } from "./desktop/projectContextStore";
import { buildRunContextPreview } from "./desktop/runContextPreview";
import { RunHistoryStore } from "./desktop/runHistoryStore";
import { summarizeRunOutcome } from "./desktop/runOutcome";
import { formatRunReport } from "./desktop/runReport";
import { WorkspaceStateStore } from "./desktop/workspaceStateStore";
import { OpenAICompatibleClient } from "./model/openAICompatibleClient";
import { diagnoseModel } from "./model/modelDiagnostics";
import { createWorkspaceTools } from "./tools/workspaceTools";

let mainWindow: BrowserWindow | null = null;
let projectRoot: string | null = null;
let activeController: AbortController | null = null;
let activeRunId: string | null = null;
const changeTracker = new ChangeTracker();
const approvalResolvers = new Map<string, (approved: boolean) => void>();
const planApprovalResolvers = new Map<
  string,
  (decision: PlanApprovalDecision) => void
>();
const MODELSCOPE_TOKEN_URL = "https://modelscope.cn/my/myaccesstoken";

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: "#0b0d10",
    title: "RepoForge · 代码锻造智能体",
    icon: path.join(__dirname, "app-icon.png"),
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
    resolveAllPlanApprovals();
    mainWindow = null;
  });
}

export function registerIpc(
  configStore: ConfigStore,
  contextStore: ProjectContextStore,
  historyStore: RunHistoryStore,
  workspaceStateStore: WorkspaceStateStore,
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
    const snapshot = await scanProject(selected);
    projectRoot = snapshot.rootPath;
    changeTracker.clear();
    await workspaceStateStore.saveLastProjectPath(snapshot.rootPath);
    return snapshot;
  });

  ipcMain.handle(IPC_CHANNELS.restoreProject, async () => {
    if (activeController) {
      return null;
    }
    const storedPath = await workspaceStateStore.lastProjectPath();
    if (!storedPath) {
      return null;
    }
    try {
      const snapshot = await scanProject(storedPath);
      projectRoot = snapshot.rootPath;
      changeTracker.clear();
      return snapshot;
    } catch (error) {
      console.warn("Failed to restore the last project", error);
      projectRoot = null;
      await workspaceStateStore.clearLastProjectPath();
      return null;
    }
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

  ipcMain.handle(IPC_CHANNELS.saveFile, async (_event, input: unknown) => {
    requireIdle("手动保存文件");
    const request = parseManualFileSaveRequest(input);
    const file = await saveProjectFile(
      requireProject(),
      request.relativePath,
      request.content,
      request.expectedHash,
    );
    changeTracker.remove(file.relativePath);
    const changes = await collectChangesSafely(requireProject());
    mainWindow?.webContents.send(IPC_CHANNELS.changesUpdated, changes);
    return { file, changes };
  });

  ipcMain.handle(IPC_CHANNELS.createFile, async (_event, input: unknown) => {
    requireIdle("手动新建文件");
    const request = parseManualFileCreateRequest(input);
    const file = await createProjectFile(
      requireProject(),
      request.relativePath,
      request.content,
    );
    const changes = await collectChangesSafely(requireProject());
    return { file, changes };
  });

  ipcMain.handle(IPC_CHANNELS.selectAttachments, async () => {
    if (activeController) {
      throw new Error("Agent 运行期间不能修改附件。");
    }
    const rootPath = await realpath(requireProject());
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "选择当前项目内的文本附件",
      defaultPath: rootPath,
      properties: ["openFile", "multiSelections"],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selection.canceled) {
      return [];
    }
    if (selection.filePaths.length > MAX_ATTACHMENT_FILES) {
      throw new Error(`一次最多添加 ${MAX_ATTACHMENT_FILES} 个附件。`);
    }
    return Promise.all(
      selection.filePaths.map(async (absolutePath) => {
        if (!isPathInside(rootPath, absolutePath)) {
          throw new Error("附件必须位于当前项目目录内。");
        }
        const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
        const snapshot = await readProjectFile(rootPath, relativePath);
        if (snapshot.content.includes("\0")) {
          throw new Error(`附件 ${snapshot.relativePath} 不是可读取的文本文件。`);
        }
        return { relativePath: snapshot.relativePath };
      }),
    );
  });

  ipcMain.handle(IPC_CHANNELS.getProjectContext, () =>
    contextStore.getContext(requireProject()),
  );
  ipcMain.handle(IPC_CHANNELS.getProjectSkill, (_event, id: unknown) => {
    if (typeof id !== "string") {
      throw new Error("Skill ID 无效。");
    }
    return contextStore.getSkill(requireProject(), id);
  });
  ipcMain.handle(IPC_CHANNELS.saveProjectSkill, (_event, input: unknown) => {
    requireIdle("修改 Skill");
    return contextStore.saveSkill(requireProject(), parseProjectSkillInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.deleteProjectSkill, (_event, id: unknown) => {
    requireIdle("删除 Skill");
    if (typeof id !== "string") {
      throw new Error("Skill ID 无效。");
    }
    return contextStore.deleteSkill(requireProject(), id);
  });
  ipcMain.handle(IPC_CHANNELS.saveProjectMemory, (_event, memory: unknown) => {
    requireIdle("修改 Memory");
    if (typeof memory !== "string") {
      throw new Error("项目记忆内容无效。");
    }
    return contextStore.saveMemory(requireProject(), memory);
  });
  ipcMain.handle(IPC_CHANNELS.deleteProjectMemory, () => {
    requireIdle("删除 Memory");
    return contextStore.deleteMemory(requireProject());
  });
  ipcMain.handle(IPC_CHANNELS.importProjectMemory, async () => {
    requireIdle("导入 Memory");
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "导入项目 Memory",
          properties: ["openFile"],
          filters: [{ name: "文本", extensions: ["md", "txt"] }],
        })
      : await dialog.showOpenDialog({
          title: "导入项目 Memory",
          properties: ["openFile"],
          filters: [{ name: "文本", extensions: ["md", "txt"] }],
        });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) {
      return null;
    }
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 100_000) {
      throw new Error("Memory 导入文件必须是小于 100 KB 的普通文本文件。");
    }
    const memory = await readFile(filePath, "utf8");
    if (memory.includes("\0")) {
      throw new Error("Memory 导入文件不是有效的文本文件。");
    }
    return contextStore.saveMemory(requireProject(), memory);
  });
  ipcMain.handle(IPC_CHANNELS.exportProjectMemory, async () => {
    requireIdle("导出 Memory");
    const rootPath = requireProject();
    const memory = await contextStore.getMemory(rootPath);
    if (!memory.trim()) {
      throw new Error("当前项目还没有可导出的 Memory。");
    }
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: "导出项目 Memory",
          defaultPath: path.join(rootPath, "repoforge-memory.md"),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        })
      : await dialog.showSaveDialog({
          title: "导出项目 Memory",
          defaultPath: path.join(rootPath, "repoforge-memory.md"),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
    if (selection.canceled || !selection.filePath) {
      return { saved: false };
    }
    await writeFile(selection.filePath, memory, "utf8");
    return { saved: true, filePath: selection.filePath };
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, () => configStore.publicSettings());
  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, input: unknown) => {
    requireIdle("修改模型设置");
    return configStore.save(parseSettingsInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.getModelProfiles, () => configStore.modelProfiles());
  ipcMain.handle(IPC_CHANNELS.saveModelProfile, (_event, input: unknown) => {
    requireIdle("保存模型配置");
    return configStore.saveModelProfile(parseModelProfileInput(input));
  });
  ipcMain.handle(IPC_CHANNELS.activateModelProfile, (_event, id: unknown) => {
    requireIdle("切换模型");
    if (typeof id !== "string") {
      throw new Error("模型配置 ID 无效。");
    }
    return configStore.activateModelProfile(id);
  });
  ipcMain.handle(IPC_CHANNELS.deleteModelProfile, (_event, id: unknown) => {
    requireIdle("删除模型配置");
    if (typeof id !== "string") {
      throw new Error("模型配置 ID 无效。");
    }
    return configStore.deleteModelProfile(id);
  });
  ipcMain.handle(IPC_CHANNELS.testModelConnection, async () => {
    requireIdle("测试模型连接");
    const [settings, apiKey] = await Promise.all([
      configStore.publicSettings(),
      configStore.apiKey(),
    ]);
    if (!apiKey) {
      throw new Error("请先保存 API Key，再测试连接。");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await diagnoseModel(
        new OpenAICompatibleClient({
          apiBaseUrl: settings.apiBaseUrl,
          apiKey,
          model: settings.model,
          maxTokens: 256,
          maxRetries: 0,
        }),
        settings.model,
        controller.signal,
      );
      await configStore.recordActiveDiagnostic(result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  });
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
  ipcMain.handle(IPC_CHANNELS.deleteRunConversation, async (_event, id: unknown) => {
    requireIdle("删除会话");
    if (typeof id !== "string") {
      throw new Error("任务历史 ID 无效。");
    }
    const deletedCount = await historyStore.deleteConversation(requireProject(), id);
    return { deletedCount };
  });
  ipcMain.handle(IPC_CHANNELS.exportRunReport, async (_event, id: unknown) => {
    if (typeof id !== "string") {
      throw new Error("任务历史 ID 无效。");
    }
    const rootPath = requireProject();
    const detail = await historyStore.getRun(rootPath, id, activeRunId);
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: "导出任务证据报告",
          defaultPath: path.join(rootPath, `repoforge-report-${id.slice(0, 8)}.md`),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        })
      : await dialog.showSaveDialog({
          title: "导出任务证据报告",
          defaultPath: path.join(rootPath, `repoforge-report-${id.slice(0, 8)}.md`),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
    if (selection.canceled || !selection.filePath) {
      return { saved: false };
    }
    await writeFile(selection.filePath, formatRunReport(path.basename(rootPath), detail), "utf8");
    return { saved: true, filePath: selection.filePath };
  });

  ipcMain.handle(IPC_CHANNELS.previewRunContext, async (_event, input: unknown) => {
    requireIdle("预览上下文");
    const rootPath = requireProject();
    const request = parseRunRequest(input);
    if (!request.task.trim()) {
      throw new Error("请先输入任务说明，再预览上下文。");
    }
    const settings = await configStore.publicSettings();
    const [memory, skills, previousMessages, attachments] = await Promise.all([
      request.useMemory
        ? contextStore.getMemoryRecord(rootPath)
        : Promise.resolve({ memory: "", updatedAt: null }),
      contextStore.getSelectedSkills(rootPath, request.skillIds),
      request.continueFromRunId
        ? historyStore.getContinuationMessages(rootPath, request.continueFromRunId, activeRunId)
        : Promise.resolve([]),
      loadAttachments(rootPath, request.attachmentPaths),
    ]);
    const workspaceTools = await createWorkspaceTools({
      rootPath,
      changeTracker: new ChangeTracker(),
      commandTimeoutMs: settings.commandTimeoutMs,
      maxOutputChars: settings.maxOutputChars,
    });
    const permittedTools = toolsForPermission(workspaceTools, settings.permissionMode);
    const previewPlan = request.executionMode === "plan" ? new PlanController(() => undefined) : null;
    const previewTools = previewPlan
      ? [...permittedTools, ...previewPlan.tools()].filter((tool) =>
          previewPlan.isToolEnabled(tool.schema.function.name),
        )
      : permittedTools;
    return buildRunContextPreview({
      request,
      settings,
      memory,
      skills,
      attachments,
      previousMessages,
      tools: previewTools,
    });
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
    const [memory, skills, previousMessages, attachments] = await Promise.all([
      request.useMemory ? contextStore.getMemory(rootPath) : Promise.resolve(""),
      contextStore.getSelectedSkills(rootPath, request.skillIds),
      request.continueFromRunId
        ? historyStore.getContinuationMessages(rootPath, request.continueFromRunId, activeRunId)
        : Promise.resolve([]),
      loadAttachments(rootPath, request.attachmentPaths),
    ]);

    changeTracker.clear();
    const workspaceTools = await createWorkspaceTools({
      rootPath,
      changeTracker,
      commandTimeoutMs: settings.commandTimeoutMs,
      maxOutputChars: settings.maxOutputChars,
    });
    const tools = toolsForPermission(workspaceTools, settings.permissionMode);
    const controller = new AbortController();
    const runId = await historyStore.startRun(rootPath, {
      task,
      selectedFile: request.selectedFile,
      attachmentPaths: attachments.map((attachment) => attachment.relativePath),
      skillIds: request.skillIds,
      memoryUsed: request.useMemory === true && Boolean(memory.trim()),
      model: settings.model,
      modelProfileName: settings.profileName,
      permissionMode: settings.permissionMode,
      responseProfile: settings.responseProfile,
      executionMode: request.executionMode ?? "direct",
      continuedFromRunId: request.continueFromRunId,
    });
    activeController = controller;
    activeRunId = runId;
    const runEvents: AgentEvent[] = [];
    const recordAndSendEvent = (event: AgentEvent): void => {
      // Streaming deltas are transient UI events. The complete assistant message is
      // persisted later, so retaining every token would only inflate run history.
      if (event.type !== "assistant_delta") {
        runEvents.push(event);
      }
      sendAgentEvent(event);
    };
    const planController =
      request.executionMode === "plan" ? new PlanController(recordAndSendEvent) : null;
    const runTools = planController ? [...tools, ...planController.tools()] : tools;
    const loop = new AgentLoop(
      new OpenAICompatibleClient({
        apiBaseUrl: settings.apiBaseUrl,
        apiKey,
        model: settings.model,
        maxTokens: responseMaxTokens(settings.responseProfile),
      }),
      new ToolRegistry(runTools, {
        isToolEnabled: planController
          ? (name) => planController.isToolEnabled(name)
          : undefined,
      }),
    );
    const contextualTask = buildContextualTask(task, request.selectedFile, attachments);
    void (async () => {
      let result: AgentRunResult | null = null;
      try {
        result = await loop.run({
          task: contextualTask,
          displayTask: task,
          previousMessages,
          systemPrompt: buildSystemPrompt({
            memory,
            skills,
            permissionMode: settings.permissionMode,
            responseProfile: settings.responseProfile,
            executionMode: request.executionMode ?? "direct",
          }),
          maxSteps: settings.maxSteps,
          signal: controller.signal,
          onEvent: recordAndSendEvent,
          requestCommandApproval: requestApproval,
          requestPlanApproval,
          validateCompletion: planController
            ? () => planController.completionIssue()
            : undefined,
        });
        const changes = await collectChangesSafely(rootPath);
        await historyStore.finishRun(rootPath, runId, {
          status: result.status,
          summary: result.summary,
          steps: result.steps,
          events: runEvents,
          messages: messagesForRunHistory(result.messages, previousMessages.length, task),
          changedFiles: changes.map((change) => change.relativePath),
          outcome: summarizeRunOutcome(runEvents, changes),
          plan: planController?.snapshot(),
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
              outcome: summarizeRunOutcome(runEvents, changes),
              plan: planController?.snapshot(),
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
        resolveAllPlanApprovals();
      }
    })();
    return { started: true, runId };
  });

  ipcMain.handle(IPC_CHANNELS.stopRun, () => {
    if (!activeController) {
      return false;
    }
    activeController.abort();
    resolveAllApprovals(false);
    resolveAllPlanApprovals();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.getChanges, () =>
    projectRoot ? collectTrackedChanges(projectRoot, changeTracker) : [],
  );
  ipcMain.handle(IPC_CHANNELS.restoreChanges, async (_event, input: unknown) => {
    requireIdle("恢复文件");
    if (!input || typeof input !== "object") {
      throw new Error("恢复请求无效。");
    }
    const result = await restoreTrackedChanges(
      requireProject(),
      changeTracker,
      input as RestoreChangedFilesRequest,
    );
    mainWindow?.webContents.send(IPC_CHANNELS.changesUpdated, result.changes);
    return result;
  });

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
  ipcMain.handle(
    IPC_CHANNELS.answerPlanApproval,
    (_event, id: unknown, input: unknown) => {
      if (typeof id !== "string") return false;
      const decision = parsePlanApprovalDecision(input);
      const resolve = planApprovalResolvers.get(id);
      if (!resolve) return false;
      planApprovalResolvers.delete(id);
      resolve(decision);
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
  if (value.task.length > MAX_TASK_CHARS) {
    throw new Error(`任务说明不能超过 ${MAX_TASK_CHARS.toLocaleString()} 个字符。`);
  }
  if (
    value.executionMode !== undefined &&
    value.executionMode !== "direct" &&
    value.executionMode !== "plan"
  ) {
    throw new Error("执行模式无效。请选择直接执行或先规划。");
  }
  if (value.selectedFile !== undefined && typeof value.selectedFile !== "string") {
    throw new Error("当前文件路径无效。");
  }
  if (
    value.attachmentPaths !== undefined &&
    (!Array.isArray(value.attachmentPaths) ||
      value.attachmentPaths.length > MAX_ATTACHMENT_FILES ||
      value.attachmentPaths.some((filePath) => typeof filePath !== "string"))
  ) {
    throw new Error(`附件选择无效；一次最多添加 ${MAX_ATTACHMENT_FILES} 个项目文件。`);
  }
  if (
    value.skillIds !== undefined &&
    (!Array.isArray(value.skillIds) || value.skillIds.some((id) => typeof id !== "string"))
  ) {
    throw new Error("Skill 选择无效。");
  }
  if (value.useMemory !== undefined && typeof value.useMemory !== "boolean") {
    throw new Error("Memory 选择无效。");
  }
  if (
    value.continueFromRunId !== undefined &&
    typeof value.continueFromRunId !== "string"
  ) {
    throw new Error("历史对话选择无效。");
  }
  return {
    task: value.task,
    executionMode: (value.executionMode as "direct" | "plan" | undefined) ?? "direct",
    selectedFile: value.selectedFile as string | undefined,
    attachmentPaths: value.attachmentPaths as string[] | undefined,
    skillIds: value.skillIds as string[] | undefined,
    useMemory: value.useMemory as boolean | undefined,
    continueFromRunId: value.continueFromRunId as string | undefined,
  };
}

function parseManualFileSaveRequest(input: unknown): ManualFileSaveRequest {
  if (!input || typeof input !== "object") {
    throw new Error("文件保存请求无效。");
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.relativePath !== "string" ||
    typeof value.content !== "string" ||
    typeof value.expectedHash !== "string"
  ) {
    throw new Error("文件保存请求无效。");
  }
  return {
    relativePath: value.relativePath,
    content: value.content,
    expectedHash: value.expectedHash,
  };
}

function parseManualFileCreateRequest(input: unknown): ManualFileCreateRequest {
  if (!input || typeof input !== "object") {
    throw new Error("新建文件请求无效。");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.relativePath !== "string" || typeof value.content !== "string") {
    throw new Error("新建文件请求无效。");
  }
  return { relativePath: value.relativePath, content: value.content };
}

function parseProjectSkillInput(input: unknown): ProjectSkillInput {
  if (!input || typeof input !== "object") {
    throw new Error("Skill 内容无效。");
  }
  const value = input as Record<string, unknown>;
  if (value.id !== undefined && typeof value.id !== "string") {
    throw new Error("Skill ID 无效。");
  }
  if (typeof value.fileName !== "string" || typeof value.content !== "string") {
    throw new Error("Skill 文件名和内容必须是文本。");
  }
  return {
    id: value.id as string | undefined,
    fileName: value.fileName,
    content: value.content,
  };
}

function parseModelProfileInput(input: unknown): ModelProfileInput {
  if (!input || typeof input !== "object") {
    throw new Error("模型配置内容无效。");
  }
  const value = input as Record<string, unknown>;
  if (value.id !== undefined && typeof value.id !== "string") {
    throw new Error("模型配置 ID 无效。");
  }
  if (
    typeof value.name !== "string" ||
    typeof value.apiBaseUrl !== "string" ||
    typeof value.model !== "string" ||
    (value.apiKey !== undefined && typeof value.apiKey !== "string") ||
    typeof value.maxSteps !== "number" ||
    typeof value.commandTimeoutMs !== "number" ||
    typeof value.maxOutputChars !== "number" ||
    typeof value.permissionMode !== "string" ||
    typeof value.responseProfile !== "string"
  ) {
    throw new Error("模型配置字段无效。");
  }
  return value as unknown as ModelProfileInput;
}

function parseSettingsInput(input: unknown): SettingsInput {
  if (!input || typeof input !== "object") {
    throw new Error("模型设置内容无效。");
  }
  const parsed = parseModelProfileInput({
    ...(input as Record<string, unknown>),
    name: "active-profile",
  });
  const { id: _id, name: _name, ...settings } = parsed;
  return settings;
}

async function loadAttachments(
  rootPath: string,
  requestedPaths: readonly string[] | undefined,
): Promise<FileSnapshot[]> {
  const paths = Array.from(new Set(requestedPaths ?? [])).slice(0, MAX_ATTACHMENT_FILES);
  const attachments: FileSnapshot[] = [];
  for (const relativePath of paths) {
    const snapshot = await readProjectFile(rootPath, relativePath);
    if (snapshot.content.includes("\0")) {
      throw new Error(`附件 ${snapshot.relativePath} 不是可读取的文本文件。`);
    }
    attachments.push(snapshot);
  }
  return attachments;
}

function requireProject(): string {
  if (!projectRoot) {
    throw new Error("请先打开一个项目目录。");
  }
  return projectRoot;
}

function requireIdle(action: string): void {
  if (activeController) {
    throw new Error(`Agent 运行期间不能${action}。`);
  }
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

function requestPlanApproval(request: PlanApprovalRequest): Promise<PlanApprovalDecision> {
  return new Promise<PlanApprovalDecision>((resolve) => {
    planApprovalResolvers.set(request.id, resolve);
    mainWindow?.webContents.send(IPC_CHANNELS.planApprovalRequested, request);
  });
}

function resolveAllApprovals(approved: boolean): void {
  for (const resolve of approvalResolvers.values()) {
    resolve(approved);
  }
  approvalResolvers.clear();
}

function resolveAllPlanApprovals(): void {
  for (const resolve of planApprovalResolvers.values()) {
    resolve({ approved: false, items: [] });
  }
  planApprovalResolvers.clear();
}

function parsePlanApprovalDecision(input: unknown): PlanApprovalDecision {
  if (!input || typeof input !== "object") throw new Error("计划确认内容无效。");
  const value = input as Record<string, unknown>;
  if (typeof value.approved !== "boolean" || !Array.isArray(value.items)) {
    throw new Error("计划确认内容无效。");
  }
  if (value.items.length > 12) throw new Error("计划步骤不能超过 12 项。");
  const items = value.items.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`计划第 ${index + 1} 项无效。`);
    const entry = item as Record<string, unknown>;
    if (typeof entry.title !== "string" || !entry.title.trim() || entry.title.trim().length > 160) {
      throw new Error(`计划第 ${index + 1} 项标题无效。`);
    }
    if (entry.id !== undefined && typeof entry.id !== "string") {
      throw new Error(`计划第 ${index + 1} 项标识无效。`);
    }
    return { id: typeof entry.id === "string" ? entry.id : undefined, title: entry.title.trim() };
  });
  if (value.approved && items.length === 0) throw new Error("批准的计划至少需要一个步骤。");
  return { approved: value.approved, items };
}

function responseMaxTokens(profile: "fast" | "balanced" | "thorough"): number {
  return profile === "fast" ? 4_096 : profile === "thorough" ? 16_384 : 8_192;
}

async function collectChangesSafely(rootPath: string): Promise<ChangedFileSnapshot[]> {
  try {
    return await collectTrackedChanges(rootPath, changeTracker);
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
    new WorkspaceStateStore(userDataPath),
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
