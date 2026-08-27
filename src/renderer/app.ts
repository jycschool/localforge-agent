import type { AgentEvent, CommandApprovalRequest } from "../core/protocol";
import type {
  ChangedFileSnapshot,
  DesktopApi,
  ProjectContextSnapshot,
  ProjectSnapshot,
  PublicSettings,
  RunHistoryDetail,
  RunHistoryStatus,
  RunHistorySummary,
} from "../desktop/contracts";
import { fileVisualFor } from "./fileIcons";

declare global {
  interface Window {
    localForge: DesktopApi;
  }
}

interface TreeNode {
  name: string;
  relativePath: string;
  directories: Map<string, TreeNode>;
  files: string[];
}

const api = window.localForge;
let project: ProjectSnapshot | null = null;
let selectedFile: string | null = null;
let changes: ChangedFileSnapshot[] = [];
let currentSettings: PublicSettings | null = null;
let activeApproval: CommandApprovalRequest | null = null;
let runHistory: RunHistorySummary[] = [];
let projectContext: ProjectContextSnapshot = {
  skills: [],
  memory: "",
  maxMemoryChars: 12_000,
  maxSelectedSkills: 8,
};
const selectedSkillIds = new Set<string>();
let approvalAnswered = false;
let toastTimer: number | undefined;
let treeInitialized = false;
const expandedDirectories = new Set<string>();

const openProjectButton = element<HTMLButtonElement>("open-project");
const welcomeOpenProjectButton = element<HTMLButtonElement>("welcome-open-project");
const refreshProjectButton = element<HTMLButtonElement>("refresh-project");
const projectName = element<HTMLElement>("project-name");
const projectPath = element<HTMLElement>("project-path");
const fileTree = element<HTMLElement>("file-tree");
const changeList = element<HTMLElement>("change-list");
const changeCount = element<HTMLElement>("change-count");
const previewTitle = element<HTMLElement>("preview-title");
const previewMeta = element<HTMLElement>("preview-meta");
const previewMode = element<HTMLElement>("preview-mode");
const previewContent = element<HTMLElement>("preview-content");
const outputLog = element<HTMLElement>("output-log");
const clearOutputButton = element<HTMLButtonElement>("clear-output");
const timeline = element<HTMLElement>("timeline");
const runStatus = element<HTMLElement>("run-status");
const historyButton = element<HTMLButtonElement>("history-button");
const historyCount = element<HTMLElement>("history-count");
const stopRunButton = element<HTMLButtonElement>("stop-run");
const taskForm = element<HTMLFormElement>("task-form");
const taskInput = element<HTMLTextAreaElement>("task-input");
const startRunButton = element<HTMLButtonElement>("start-run");
const selectedContext = element<HTMLElement>("selected-context");
const skillsButton = element<HTMLButtonElement>("skills-button");
const skillsBadge = element<HTMLElement>("skills-badge");
const memoryButton = element<HTMLButtonElement>("memory-button");
const memoryBadge = element<HTMLElement>("memory-badge");
const skillsDialog = element<HTMLDialogElement>("skills-dialog");
const skillList = element<HTMLElement>("skill-list");
const refreshSkillsButton = element<HTMLButtonElement>("refresh-skills");
const memoryDialog = element<HTMLDialogElement>("memory-dialog");
const memoryForm = element<HTMLFormElement>("memory-form");
const memoryInput = element<HTMLTextAreaElement>("memory-input");
const memoryCharacterCount = element<HTMLElement>("memory-character-count");
const memoryError = element<HTMLElement>("memory-error");
const closeMemoryButton = element<HTMLButtonElement>("close-memory");
const cancelMemoryButton = element<HTMLButtonElement>("cancel-memory");
const settingsButton = element<HTMLButtonElement>("settings-button");
const modelStatus = element<HTMLElement>("model-status");
const settingsDialog = element<HTMLDialogElement>("settings-dialog");
const settingsForm = element<HTMLFormElement>("settings-form");
const apiBaseUrlInput = element<HTMLInputElement>("api-base-url");
const modelNameInput = element<HTMLInputElement>("model-name");
const apiKeyInput = element<HTMLInputElement>("api-key");
const apiKeyHelp = element<HTMLElement>("api-key-help");
const useModelScopePresetButton = element<HTMLButtonElement>("use-modelscope-preset");
const openModelScopeTokenButton = element<HTMLButtonElement>("open-modelscope-token");
const maxStepsInput = element<HTMLInputElement>("max-steps");
const commandTimeoutInput = element<HTMLInputElement>("command-timeout");
const settingsError = element<HTMLElement>("settings-error");
const approvalDialog = element<HTMLDialogElement>("approval-dialog");
const approvalReason = element<HTMLElement>("approval-reason");
const approvalCommand = element<HTMLElement>("approval-command");
const approvalCwd = element<HTMLElement>("approval-cwd");
const approveCommandButton = element<HTMLButtonElement>("approve-command");
const rejectCommandButton = element<HTMLButtonElement>("reject-command");
const historyDialog = element<HTMLDialogElement>("history-dialog");
const historyList = element<HTMLElement>("history-list");
const historyDetail = element<HTMLElement>("history-detail");
const toast = element<HTMLElement>("toast");
const workbench = element<HTMLElement>("workbench");
const leftResizer = element<HTMLElement>("left-resizer");
const rightResizer = element<HTMLElement>("right-resizer");

openProjectButton.addEventListener("click", () => void selectProject());
welcomeOpenProjectButton.addEventListener("click", () => void selectProject());
refreshProjectButton.addEventListener("click", () => void refreshProject());
clearOutputButton.addEventListener("click", () => {
  outputLog.textContent = "等待 Agent 运行命令或工具…";
});
settingsButton.addEventListener("click", () => void openSettings());
historyButton.addEventListener("click", () => void openHistory());
stopRunButton.addEventListener("click", () => void stopRun());
taskForm.addEventListener("submit", (event) => void startRun(event));
skillsButton.addEventListener("click", openSkills);
memoryButton.addEventListener("click", openMemory);
refreshSkillsButton.addEventListener("click", () => void loadProjectContext(true));
memoryForm.addEventListener("submit", (event) => void saveMemory(event));
memoryInput.addEventListener("input", renderMemoryCharacterCount);
closeMemoryButton.addEventListener("click", () => memoryDialog.close());
cancelMemoryButton.addEventListener("click", () => memoryDialog.close());
settingsForm.addEventListener("submit", (event) => void saveSettings(event));
useModelScopePresetButton.addEventListener("click", useModelScopePreset);
openModelScopeTokenButton.addEventListener("click", () => void api.openModelScopeTokenPage());
approveCommandButton.addEventListener("click", (event) => void answerApproval(event, true));
rejectCommandButton.addEventListener("click", (event) => void answerApproval(event, false));
approvalDialog.addEventListener("close", () => {
  if (activeApproval && !approvalAnswered) {
    void api.answerApproval(activeApproval.id, false);
  }
  activeApproval = null;
  approvalAnswered = false;
});

setupColumnResizing();

api.onAgentEvent(handleAgentEvent);
api.onApprovalRequested(showApproval);
api.onChangesUpdated((nextChanges) => {
  changes = nextChanges;
  renderChanges();
  void refreshProject(false);
  void loadRunHistory();
});

void initialize();

async function initialize(): Promise<void> {
  try {
    currentSettings = await api.getSettings();
    renderModelStatus();
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function selectProject(): Promise<void> {
  try {
    const selected = await api.selectProject();
    if (!selected) {
      return;
    }
    project = selected;
    selectedFile = null;
    changes = [];
    selectedSkillIds.clear();
    runHistory = [];
    projectContext = { skills: [], memory: "", maxMemoryChars: 12_000, maxSelectedSkills: 8 };
    treeInitialized = false;
    expandedDirectories.clear();
    renderProject();
    renderChanges();
    showProjectWelcome();
    await Promise.all([loadProjectContext(), loadRunHistory()]);
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function refreshProject(showMessage = true): Promise<void> {
  try {
    const refreshed = await api.refreshProject();
    if (!refreshed) {
      if (showMessage) {
        notify("请先打开一个项目。");
      }
      return;
    }
    project = refreshed;
    renderProject();
    if (showMessage) {
      notify("项目结构已刷新。");
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}

function renderProject(): void {
  if (!project) {
    return;
  }
  projectName.textContent = project.name;
  projectPath.textContent = project.rootPath;
  const previousScrollTop = fileTree.scrollTop;
  fileTree.replaceChildren();
  const root: TreeNode = {
    name: project.name,
    relativePath: "",
    directories: new Map(),
    files: [],
  };
  for (const file of project.files) {
    insertFile(root, file.relativePath);
  }
  fileTree.append(renderTree(root, 0));
  if (project.limited) {
    const note = document.createElement("p");
    note.className = "empty-copy";
    note.textContent = "文件较多，仅显示前 2,000 个。";
    fileTree.append(note);
  }
  treeInitialized = true;
  fileTree.scrollTop = previousScrollTop;
}

function insertFile(root: TreeNode, relativePath: string): void {
  const parts = relativePath.split("/");
  const fileName = parts.pop();
  if (!fileName) {
    return;
  }
  let node = root;
  for (const directory of parts) {
    let child = node.directories.get(directory);
    if (!child) {
      child = {
        name: directory,
        relativePath: node.relativePath ? `${node.relativePath}/${directory}` : directory,
        directories: new Map(),
        files: [],
      };
      node.directories.set(directory, child);
    }
    node = child;
  }
  node.files.push(relativePath);
}

function renderTree(node: TreeNode, depth: number): HTMLUListElement {
  const list = document.createElement("ul");
  list.className = "tree-list";
  for (const directory of Array.from(node.directories.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.className = "tree-directory";
    details.dataset.path = directory.relativePath;
    details.open = expandedDirectories.has(directory.relativePath) || (!treeInitialized && depth === 0);
    if (details.open) {
      expandedDirectories.add(directory.relativePath);
    }
    details.addEventListener("toggle", () => {
      if (details.open) {
        expandedDirectories.add(directory.relativePath);
        populateDirectory(details, directory, depth + 1);
      } else {
        expandedDirectories.delete(directory.relativePath);
      }
    });
    const summary = document.createElement("summary");
    summary.title = directory.relativePath;
    const twistie = document.createElement("span");
    twistie.className = "tree-twistie";
    twistie.setAttribute("aria-hidden", "true");
    const folderIcon = document.createElement("span");
    folderIcon.className = "tree-folder-icon";
    folderIcon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = directory.name;
    summary.append(twistie, folderIcon, label);
    details.append(summary);
    if (details.open) {
      populateDirectory(details, directory, depth + 1);
    }
    item.append(details);
    list.append(item);
  }
  for (const relativePath of node.files.sort((a, b) => a.localeCompare(b))) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-file${selectedFile === relativePath ? " selected" : ""}`;
    button.title = relativePath;
    button.dataset.path = relativePath;
    const indent = document.createElement("span");
    indent.className = "tree-indent";
    indent.setAttribute("aria-hidden", "true");
    const visual = fileVisualFor(relativePath);
    const icon = document.createElement("span");
    icon.className = `file-icon ${visual.className}`;
    icon.textContent = visual.label;
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "file-label";
    label.textContent = relativePath.split("/").pop() ?? relativePath;
    button.append(indent, icon, label);
    button.addEventListener("click", () => void openFile(relativePath));
    item.append(button);
    list.append(item);
  }
  return list;
}

function populateDirectory(details: HTMLDetailsElement, directory: TreeNode, depth: number): void {
  if (details.dataset.loaded === "true") {
    return;
  }
  details.append(renderTree(directory, depth));
  details.dataset.loaded = "true";
}

function updateFileSelection(): void {
  fileTree.querySelectorAll<HTMLButtonElement>(".tree-file").forEach((button) => {
    button.classList.toggle("selected", button.dataset.path === selectedFile);
  });
}

async function openFile(relativePath: string): Promise<void> {
  try {
    const file = await api.readFile(relativePath);
    selectedFile = file.relativePath;
    previewTitle.textContent = file.relativePath;
    previewMeta.textContent = `${file.language} · ${formatBytes(file.size)} · 只读`;
    previewMode.textContent = "FILE";
    const pre = document.createElement("pre");
    pre.className = "code-view";
    pre.textContent = file.content;
    previewContent.replaceChildren(pre);
    selectedContext.textContent = `上下文：${file.relativePath}`;
    updateFileSelection();
    renderChanges();
  } catch (error) {
    notify(errorMessage(error));
  }
}

function renderChanges(): void {
  changeCount.textContent = String(changes.length);
  changeList.replaceChildren();
  if (changes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "Agent 修改的文件会集中显示。";
    changeList.append(empty);
    return;
  }
  for (const change of changes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "change-file";
    button.textContent = change.relativePath;
    button.addEventListener("click", () => showDiff(change));
    changeList.append(button);
  }
}

function showDiff(change: ChangedFileSnapshot): void {
  selectedFile = change.relativePath;
  previewTitle.textContent = change.relativePath;
  previewMeta.textContent = change.originalContent === null ? "新文件 · 只读差异" : "修改前 / 修改后";
  previewMode.textContent = "DIFF";
  const wrapper = document.createElement("div");
  wrapper.className = "diff-view";
  wrapper.append(
    diffColumn("修改前", change.originalContent ?? "（新文件）"),
    diffColumn("修改后", change.currentContent),
  );
  previewContent.replaceChildren(wrapper);
  selectedContext.textContent = `上下文：${change.relativePath}`;
  updateFileSelection();
}

function diffColumn(label: string, content: string): HTMLElement {
  const column = document.createElement("section");
  column.className = "diff-column";
  const header = document.createElement("header");
  header.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = content;
  column.append(header, pre);
  return column;
}

function showProjectWelcome(): void {
  previewTitle.textContent = project ? project.name : "代码预览";
  previewMeta.textContent = project ? `${project.files.length} 个文件` : "只读";
  previewMode.textContent = "PROJECT";
  const welcome = document.createElement("div");
  welcome.className = "welcome-state";
  const mark = document.createElement("div");
  mark.className = "welcome-mark";
  mark.textContent = "LF";
  const kicker = document.createElement("span");
  kicker.className = "welcome-kicker";
  kicker.textContent = "LOCAL WORKSPACE";
  const heading = document.createElement("h1");
  heading.textContent = project ? `${project.name} 已就绪` : "从项目结构开始";
  const copy = document.createElement("p");
  copy.textContent = "从左侧选择文件查看代码，或直接在右侧描述希望 Agent 完成的任务。";
  const hints = document.createElement("div");
  hints.className = "welcome-hints";
  hints.setAttribute("aria-label", "核心能力");
  for (const hint of ["只读预览", "命令审批", "Diff 审查"]) {
    const item = document.createElement("span");
    item.textContent = hint;
    hints.append(item);
  }
  welcome.append(mark, kicker, heading, copy, hints);
  previewContent.replaceChildren(welcome);
  selectedContext.textContent = "未选择文件";
}

async function openSettings(): Promise<void> {
  try {
    currentSettings = await api.getSettings();
    apiBaseUrlInput.value = currentSettings.apiBaseUrl;
    modelNameInput.value = currentSettings.model;
    apiKeyInput.value = "";
    maxStepsInput.value = String(currentSettings.maxSteps);
    commandTimeoutInput.value = String(Math.round(currentSettings.commandTimeoutMs / 1000));
    apiKeyHelp.textContent = currentSettings.hasApiKey
      ? `已有 Key（来源：${currentSettings.apiKeySource === "environment" ? "环境变量" : "系统加密存储"}）`
      : "尚未保存 Key。保存时会使用系统安全存储加密。";
    settingsError.textContent = "";
    settingsDialog.showModal();
  } catch (error) {
    notify(errorMessage(error));
  }
}

function useModelScopePreset(): void {
  apiBaseUrlInput.value = "https://api-inference.modelscope.cn/v1";
  modelNameInput.value = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
  apiKeyInput.value = "";
  apiKeyHelp.textContent =
    "请粘贴 ModelScope Token。切换服务不会把其他平台保存的 Key 发送给 ModelScope。";
  apiKeyInput.focus();
}

async function saveSettings(event: SubmitEvent): Promise<void> {
  const submitter = event.submitter as HTMLButtonElement | null;
  if (submitter?.value === "cancel") {
    return;
  }
  event.preventDefault();
  if (!settingsForm.reportValidity()) {
    return;
  }
  try {
    settingsError.textContent = "";
    currentSettings = await api.saveSettings({
      apiBaseUrl: apiBaseUrlInput.value,
      model: modelNameInput.value,
      apiKey: apiKeyInput.value || undefined,
      maxSteps: Number(maxStepsInput.value),
      commandTimeoutMs: Number(commandTimeoutInput.value) * 1000,
      maxOutputChars: currentSettings?.maxOutputChars ?? 20_000,
    });
    settingsDialog.close();
    renderModelStatus();
    notify("模型设置已保存。");
  } catch (error) {
    settingsError.textContent = errorMessage(error);
  }
}

function renderModelStatus(): void {
  if (!currentSettings) {
    return;
  }
  modelStatus.classList.toggle("ready", currentSettings.hasApiKey);
  modelStatus.lastChild!.textContent = currentSettings.hasApiKey
    ? ` ${currentSettings.model}`
    : " 未配置模型";
}

async function startRun(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  const task = taskInput.value.trim();
  if (!task) {
    notify("请输入任务说明。");
    taskInput.focus();
    return;
  }
  try {
    const result = await api.startRun({
      task,
      selectedFile: selectedFile ?? undefined,
      skillIds: Array.from(selectedSkillIds),
    });
    if (!result.started) {
      notify(result.message ?? "任务未能启动。");
      return;
    }
    setRunning(true);
    taskInput.value = "";
    clearTimeline();
    void loadRunHistory();
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function stopRun(): Promise<void> {
  try {
    if (await api.stopRun()) {
      stopRunButton.disabled = true;
      setRunStatus("正在停止", "idle");
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}

function handleAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "run_started":
      setRunning(true);
      appendTimeline("开始任务", event.task, "active");
      break;
    case "model_started":
      appendTimeline(`第 ${event.step} 步`, "模型正在决定下一项操作…", "active");
      break;
    case "assistant_message":
      appendTimeline("Agent", event.text, "success");
      break;
    case "tool_started":
      appendTimeline(
        toolLabel(event.name),
        summarizeArguments(event.name, event.arguments),
        "active",
      );
      break;
    case "tool_finished":
      handleToolOutput(event.name, event.result.content);
      appendTimeline(
        event.result.isError ? `${toolLabel(event.name)}失败` : `${toolLabel(event.name)}完成`,
        `${event.durationMs} ms`,
        event.result.isError ? "error" : "success",
      );
      break;
    case "run_completed":
      appendTimeline("任务完成", event.summary, "success");
      setRunning(false);
      break;
    case "run_cancelled":
      appendTimeline("任务已停止", `共执行 ${event.steps} 步`, "error");
      setRunning(false);
      break;
    case "run_failed":
      appendTimeline("任务失败", event.message, "error");
      setRunning(false, true);
      break;
  }
}

function handleToolOutput(toolName: string, raw: string): void {
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // Keep non-JSON tool output readable.
  }
  if (toolName === "run_command" && isRecord(value)) {
    const command = typeof value.command === "string" ? `$ ${value.command}\n` : "";
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const stderr = typeof value.stderr === "string" ? value.stderr : "";
    appendOutput(`${command}${stdout}${stderr}`.trim());
    return;
  }
  appendOutput(`${toolLabel(toolName)}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

function appendTimeline(
  title: string,
  detail: string,
  state: "active" | "success" | "error",
): void {
  document.getElementById("timeline-empty")?.remove();
  const item = document.createElement("article");
  item.className = `timeline-item ${state}`;
  const dot = document.createElement("span");
  dot.className = "timeline-dot";
  dot.textContent = state === "success" ? "✓" : state === "error" ? "!" : "·";
  const body = document.createElement("div");
  body.className = "timeline-body";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement(detail.includes("\n") ? "pre" : "p");
  copy.textContent = detail;
  body.append(heading, copy);
  item.append(dot, body);
  timeline.append(item);
  while (timeline.childElementCount > 160) {
    timeline.firstElementChild?.remove();
  }
  timeline.scrollTop = timeline.scrollHeight;
}

function clearTimeline(): void {
  timeline.replaceChildren();
}

function appendOutput(text: string): void {
  if (!text) {
    return;
  }
  if (outputLog.textContent === "等待 Agent 运行命令或工具…") {
    outputLog.textContent = "";
  }
  const combined = `${outputLog.textContent ?? ""}${outputLog.textContent ? "\n\n" : ""}${text}`;
  outputLog.textContent = combined.length > 100_000
    ? `…较早输出已省略…\n\n${combined.slice(-96_000)}`
    : combined;
  outputLog.scrollTop = outputLog.scrollHeight;
}

function setRunning(isRunning: boolean, failed = false): void {
  stopRunButton.disabled = !isRunning;
  startRunButton.disabled = isRunning;
  openProjectButton.disabled = isRunning;
  skillsButton.disabled = isRunning || !project;
  memoryButton.disabled = isRunning || !project;
  historyButton.disabled = !project;
  setRunStatus(isRunning ? "运行中" : failed ? "出错" : "待命", isRunning ? "running" : failed ? "error" : "idle");
}

function setRunStatus(label: string, state: "running" | "error" | "idle"): void {
  runStatus.className = `run-status ${state}`;
  const dot = document.createElement("span");
  runStatus.replaceChildren(dot, document.createTextNode(` ${label}`));
}

function showApproval(request: CommandApprovalRequest): void {
  activeApproval = request;
  approvalAnswered = false;
  approvalReason.textContent = request.reason;
  approvalCommand.textContent = request.command;
  approvalCwd.textContent = `运行目录：${request.cwd}`;
  appendTimeline("等待命令批准", request.command, "active");
  approvalDialog.showModal();
}

async function answerApproval(event: MouseEvent, approved: boolean): Promise<void> {
  event.preventDefault();
  if (!activeApproval) {
    approvalDialog.close();
    return;
  }
  approvalAnswered = true;
  const request = activeApproval;
  activeApproval = null;
  await api.answerApproval(request.id, approved);
  approvalDialog.close();
  appendTimeline(approved ? "命令已允许" : "命令已拒绝", request.command, approved ? "success" : "error");
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_files: "查看项目结构",
    search_text: "搜索代码",
    read_file: "读取文件",
    replace_in_file: "修改文件",
    write_file: "写入文件",
    run_command: "运行命令",
  };
  return labels[name] ?? name;
}

function summarizeArguments(name: string, args: Record<string, unknown>): string {
  if (typeof args.path === "string") {
    return args.path;
  }
  if (name === "search_text" && typeof args.query === "string") {
    return `“${args.query}”`;
  }
  if (name === "run_command" && typeof args.command === "string") {
    return args.command;
  }
  if (name === "list_files" && typeof args.glob === "string") {
    return args.glob;
  }
  return Object.keys(args).length ? JSON.stringify(args) : "准备执行";
}

function notify(message: string): void {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3_200);
}

async function loadRunHistory(showMessage = false): Promise<void> {
  if (!project) {
    runHistory = [];
    renderHistoryCount();
    return;
  }
  try {
    runHistory = await api.listRunHistory();
    renderHistoryCount();
    if (historyDialog.open) {
      renderHistoryList();
    }
    if (showMessage) {
      notify(`已读取 ${runHistory.length} 条任务历史。`);
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}

function renderHistoryCount(): void {
  historyCount.textContent = String(runHistory.length);
  historyButton.disabled = !project;
}

async function openHistory(): Promise<void> {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  await loadRunHistory();
  renderHistoryList();
  historyDialog.showModal();
  const first = runHistory[0];
  if (first) {
    await showHistoryDetail(first.id);
  } else {
    renderEmptyHistoryDetail();
  }
}

function renderHistoryList(selectedId?: string): void {
  historyList.replaceChildren();
  if (runHistory.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-list-empty";
    empty.textContent = "还没有任务记录";
    historyList.append(empty);
    return;
  }
  for (const run of runHistory) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.classList.toggle("selected", run.id === selectedId);
    const row = document.createElement("span");
    row.className = "history-item-row";
    const status = document.createElement("span");
    status.className = `history-status ${run.status}`;
    status.textContent = historyStatusLabel(run.status);
    const date = document.createElement("time");
    date.dateTime = run.createdAt;
    date.textContent = formatHistoryDate(run.createdAt);
    row.append(status, date);
    const task = document.createElement("strong");
    task.textContent = run.task;
    const meta = document.createElement("small");
    meta.textContent = `${run.steps} 步 · ${run.changedFiles.length} 个改动文件`;
    button.append(row, task, meta);
    button.addEventListener("click", () => void showHistoryDetail(run.id));
    historyList.append(button);
  }
}

async function showHistoryDetail(id: string): Promise<void> {
  renderHistoryList(id);
  historyDetail.replaceChildren(historyLoading("正在读取任务详情…"));
  try {
    const detail = await api.getRunHistory(id);
    renderHistoryDetail(detail);
  } catch (error) {
    historyDetail.replaceChildren(historyLoading(errorMessage(error)));
  }
}

function renderHistoryDetail(detail: RunHistoryDetail): void {
  historyDetail.replaceChildren();
  const heading = document.createElement("header");
  const headingCopy = document.createElement("div");
  const status = document.createElement("span");
  status.className = `history-status ${detail.status}`;
  status.textContent = historyStatusLabel(detail.status);
  const task = document.createElement("h3");
  task.textContent = detail.task;
  const timestamp = document.createElement("time");
  timestamp.dateTime = detail.createdAt;
  timestamp.textContent = `${formatHistoryDate(detail.createdAt)} · ${detail.steps} 步 · ${detail.eventCount} 条事件`;
  headingCopy.append(status, task, timestamp);
  heading.append(headingCopy);

  const summary = document.createElement("section");
  summary.className = "history-summary";
  const summaryTitle = document.createElement("strong");
  summaryTitle.textContent = "执行结果";
  const summaryCopy = document.createElement("p");
  summaryCopy.textContent = detail.summary;
  summary.append(summaryTitle, summaryCopy);

  const context = document.createElement("div");
  context.className = "history-context";
  if (detail.selectedFile) {
    context.append(historyChip(`文件 · ${detail.selectedFile}`));
  }
  if (detail.skillIds.length > 0) {
    context.append(historyChip(`${detail.skillIds.length} 个 Skill`));
  }
  if (detail.changedFiles.length > 0) {
    context.append(historyChip(`${detail.changedFiles.length} 个改动文件`));
  }

  const events = document.createElement("section");
  events.className = "history-events";
  const eventsTitle = document.createElement("strong");
  eventsTitle.textContent = "执行过程";
  events.append(eventsTitle);
  const eventList = document.createElement("div");
  eventList.className = "history-event-list";
  for (const event of detail.events) {
    const item = document.createElement("div");
    item.className = `history-event ${historyEventState(event)}`;
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("p");
    copy.textContent = historyEventText(event);
    item.append(mark, copy);
    eventList.append(item);
  }
  if (detail.events.length === 0) {
    eventList.append(historyLoading("没有可显示的过程事件。"));
  }
  events.append(eventList);

  const files = document.createElement("section");
  files.className = "history-files";
  const filesTitle = document.createElement("strong");
  filesTitle.textContent = "改动文件";
  files.append(filesTitle);
  if (detail.changedFiles.length === 0) {
    const none = document.createElement("p");
    none.textContent = "本次任务没有记录到文件改动。";
    files.append(none);
  } else {
    const list = document.createElement("div");
    for (const file of detail.changedFiles) {
      const code = document.createElement("code");
      code.textContent = file;
      list.append(code);
    }
    files.append(list);
  }

  historyDetail.append(heading, summary);
  if (context.childElementCount > 0) {
    historyDetail.append(context);
  }
  historyDetail.append(events, files);
}

function renderEmptyHistoryDetail(): void {
  historyDetail.replaceChildren(historyLoading("运行第一个 Agent 任务后，这里会显示完整记录。"));
}

function historyLoading(text: string): HTMLElement {
  const value = document.createElement("p");
  value.className = "history-empty";
  value.textContent = text;
  return value;
}

function historyChip(text: string): HTMLElement {
  const chip = document.createElement("span");
  chip.textContent = text;
  return chip;
}

function historyStatusLabel(status: RunHistoryStatus): string {
  const labels: Record<RunHistoryStatus, string> = {
    running: "运行中",
    completed: "已完成",
    cancelled: "已停止",
    failed: "失败",
    interrupted: "意外中断",
  };
  return labels[status];
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
}

function historyEventState(event: AgentEvent): "neutral" | "success" | "error" {
  if (event.type === "run_failed" || event.type === "run_cancelled") {
    return "error";
  }
  if (event.type === "run_completed" || (event.type === "tool_finished" && !event.result.isError)) {
    return "success";
  }
  return "neutral";
}

function historyEventText(event: AgentEvent): string {
  switch (event.type) {
    case "run_started":
      return `开始任务 · ${event.task}`;
    case "model_started":
      return `模型请求 · 第 ${event.step} 步`;
    case "assistant_message":
      return `Agent · ${event.text}`;
    case "tool_started":
      return `${toolLabel(event.name)} · ${summarizeArguments(event.name, event.arguments)}`;
    case "tool_finished":
      return `${toolLabel(event.name)}${event.result.isError ? "失败" : "完成"} · ${event.durationMs} ms`;
    case "run_completed":
      return `任务完成 · ${event.summary}`;
    case "run_cancelled":
      return `任务已停止 · 共执行 ${event.steps} 步`;
    case "run_failed":
      return `任务失败 · ${event.message}`;
  }
}

async function loadProjectContext(showMessage = false): Promise<void> {
  if (!project) {
    return;
  }
  try {
    projectContext = await api.getProjectContext();
    const availableIds = new Set(projectContext.skills.map((skill) => skill.id));
    for (const id of selectedSkillIds) {
      if (!availableIds.has(id)) {
        selectedSkillIds.delete(id);
      }
    }
    renderContextControls();
    renderSkillList();
    if (showMessage) {
      notify(`已发现 ${projectContext.skills.length} 个 Skill。`);
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}

function renderContextControls(): void {
  skillsButton.disabled = !project;
  memoryButton.disabled = !project;
  skillsBadge.textContent = projectContext.skills.length
    ? `${selectedSkillIds.size}/${projectContext.skills.length}`
    : "0";
  skillsButton.classList.toggle("active", selectedSkillIds.size > 0);
  const hasMemory = projectContext.memory.trim().length > 0;
  memoryBadge.textContent = hasMemory ? "已保存" : "未设置";
  memoryButton.classList.toggle("active", hasMemory);
}

function openSkills(): void {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  renderSkillList();
  skillsDialog.showModal();
}

function renderSkillList(): void {
  skillList.replaceChildren();
  if (projectContext.skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "context-empty";
    const mark = document.createElement("span");
    mark.textContent = "◇";
    const title = document.createElement("strong");
    title.textContent = "这个项目还没有 Skill";
    const copy = document.createElement("p");
    copy.textContent = "在 .localforge/skills 中添加 Markdown 文件，然后重新扫描。";
    empty.append(mark, title, copy);
    skillList.append(empty);
    return;
  }
  for (const skill of projectContext.skills) {
    const label = document.createElement("label");
    label.className = "skill-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedSkillIds.has(skill.id);
    const copy = document.createElement("span");
    const heading = document.createElement("strong");
    heading.textContent = skill.name;
    const description = document.createElement("small");
    description.textContent = skill.description;
    const file = document.createElement("code");
    file.textContent = skill.relativePath;
    copy.append(heading, description, file);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (selectedSkillIds.size >= projectContext.maxSelectedSkills) {
          checkbox.checked = false;
          notify(`每次任务最多选择 ${projectContext.maxSelectedSkills} 个 Skill。`);
          return;
        }
        selectedSkillIds.add(skill.id);
      } else {
        selectedSkillIds.delete(skill.id);
      }
      renderContextControls();
    });
    label.append(checkbox, copy);
    skillList.append(label);
  }
}

function openMemory(): void {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  memoryInput.value = projectContext.memory;
  memoryInput.maxLength = projectContext.maxMemoryChars;
  memoryError.textContent = "";
  renderMemoryCharacterCount();
  memoryDialog.showModal();
  memoryInput.focus();
}

function renderMemoryCharacterCount(): void {
  memoryCharacterCount.textContent = `${memoryInput.value.length.toLocaleString()} / ${projectContext.maxMemoryChars.toLocaleString()}`;
}

async function saveMemory(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  memoryError.textContent = "";
  try {
    projectContext = await api.saveProjectMemory(memoryInput.value);
    renderContextControls();
    memoryDialog.close();
    notify(projectContext.memory.trim() ? "项目记忆已保存。" : "项目记忆已清空。");
  } catch (error) {
    memoryError.textContent = errorMessage(error);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
  }
  return String(error);
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setupColumnResizing(): void {
  const leftDefault = 270;
  const rightDefault = 390;
  const leftStored = storedWidth("localforge.leftPanelWidth", leftDefault);
  const rightStored = storedWidth("localforge.rightPanelWidth", rightDefault);

  setPanelWidth("left", leftStored, false);
  setPanelWidth("right", rightStored, false);
  setPanelWidth("left", panelWidth("left"), false);

  attachResizer(leftResizer, "left", leftDefault);
  attachResizer(rightResizer, "right", rightDefault);
  window.addEventListener("resize", () => {
    setPanelWidth("right", panelWidth("right"), false);
    setPanelWidth("left", panelWidth("left"), false);
  });
}

function attachResizer(
  resizer: HTMLElement,
  side: "left" | "right",
  defaultWidth: number,
): void {
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth(side);
    resizer.classList.add("active");
    document.body.classList.add("resizing-columns");
    resizer.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX;
      setPanelWidth(side, startWidth + (side === "left" ? delta : -delta));
    };
    const finish = (finishEvent: PointerEvent): void => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", finish);
      resizer.removeEventListener("pointercancel", finish);
      if (resizer.hasPointerCapture(finishEvent.pointerId)) {
        resizer.releasePointerCapture(finishEvent.pointerId);
      }
      resizer.classList.remove("active");
      document.body.classList.remove("resizing-columns");
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);
  });

  resizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setPanelWidth(side, panelWidth(side) + (side === "left" ? direction : -direction) * 12);
  });

  resizer.addEventListener("dblclick", () => setPanelWidth(side, defaultWidth));
}

function setPanelWidth(side: "left" | "right", requestedWidth: number, persist = true): void {
  const minimum = side === "left" ? 210 : 300;
  const configuredMaximum = side === "left" ? 480 : 560;
  const otherWidth = panelWidth(side === "left" ? "right" : "left");
  const availableMaximum = workbench.clientWidth - otherWidth - 360 - 14;
  const maximum = Math.max(minimum, Math.min(configuredMaximum, availableMaximum));
  const width = Math.round(Math.min(maximum, Math.max(minimum, requestedWidth)));
  const property = side === "left" ? "--left-panel-width" : "--right-panel-width";
  const resizer = side === "left" ? leftResizer : rightResizer;
  workbench.style.setProperty(property, `${width}px`);
  resizer.setAttribute("aria-valuenow", String(width));
  resizer.setAttribute("aria-valuemax", String(Math.round(maximum)));
  if (persist) {
    localStorage.setItem(`localforge.${side}PanelWidth`, String(width));
  }
}

function panelWidth(side: "left" | "right"): number {
  const property = side === "left" ? "--left-panel-width" : "--right-panel-width";
  const value = getComputedStyle(workbench).getPropertyValue(property);
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : side === "left" ? 270 : 390;
}

function storedWidth(key: string, fallback: number): number {
  const parsed = Number.parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}
