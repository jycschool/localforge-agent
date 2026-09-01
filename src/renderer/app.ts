import type {
  AgentEvent,
  CommandApprovalRequest,
  PlanApprovalRequest,
  PlanSnapshot,
  TokenUsage,
} from "../core/protocol";
import {
  MAX_ATTACHMENT_FILES,
  MAX_TASK_CHARS,
  type ChangedFileSnapshot,
  type DesktopApi,
  type FileSnapshot,
  type ModelProfileInput,
  type ModelProfilesSnapshot,
  type ModelProfileSummary,
  type ProjectContextSnapshot,
  type ProjectSnapshot,
  type PublicSettings,
  type RunHistoryDetail,
  type RunOutcomeMetrics,
  type RunHistoryStatus,
  type RunHistorySummary,
  type RunRequest,
} from "../desktop/contracts";
import { replayFrameDelay, summarizeRunOutcome } from "../desktop/runOutcome";
import {
  buildCodeSelectionTask,
  normalizeCodeSelection,
  type CodeSelectionAction,
  type NormalizedCodeSelection,
} from "./features/codeSelection";
import {
  detectLineEnding,
  editorByteLength,
  isEditorDirty,
  normalizeEditorContent,
  serializeEditorContent,
  type LineEnding,
} from "./features/manualEditor";
import { setupPanelResizing } from "./features/panelResizing";
import { LatestRequestGuard } from "./features/latestRequest";
import { rankQuickOpen, type QuickOpenMatch } from "./features/quickOpen";
import {
  changeEvidence,
  parseCommandEvidence,
  testEvidenceProgress,
  type CommandEvidence,
  type TestEvidence,
} from "./features/runEvidence";
import { clearTaskDraft, loadTaskDraft, saveTaskDraft } from "./features/taskDraft";
import { fileVisualFor } from "./shared/fileIcons";
import { displayLocalPath } from "./shared/pathDisplay";
import {
  compactMarkdownText,
  parseSafeMarkdown,
  type InlineToken,
} from "./shared/safeMarkdown";

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

interface ManualEditorState {
  relativePath: string;
  originalNormalized: string;
  expectedHash: string;
  lineEnding: LineEnding;
  textarea: HTMLTextAreaElement;
  lineNumbers: HTMLElement;
}

interface PlanDraftItem {
  id?: string;
  title: string;
}

interface CommandOutputEntry {
  id: string;
  command: string;
  reason: string;
  state: "running" | CommandEvidence["state"];
  evidence?: CommandEvidence;
  expanded: boolean;
}

type OutputFilter = "all" | "error" | "test";

const api = window.localForge;
const AGENT_DISPLAY_NAME = "RepoForge";
let project: ProjectSnapshot | null = null;
let selectedFile: string | null = null;
let changes: ChangedFileSnapshot[] = [];
let currentSettings: PublicSettings | null = null;
let modelProfiles: ModelProfilesSnapshot = {
  activeProfileId: "",
  profiles: [],
  maxProfiles: 12,
};
let editingModelProfileId: string | null = null;
let modelProfileDeleteArmed = false;
let activeApproval: CommandApprovalRequest | null = null;
let activePlanApproval: PlanApprovalRequest | null = null;
let planDraftItems: PlanDraftItem[] = [];
let latestPlan: PlanSnapshot | null = null;
let lastRenderedPlan: PlanSnapshot | null = null;
let planCollapsed = false;
let runHistory: RunHistorySummary[] = [];
let projectContext: ProjectContextSnapshot = {
  skills: [],
  memory: "",
  memoryUpdatedAt: null,
  maxMemoryChars: 12_000,
  maxSelectedSkills: 8,
};
const selectedSkillIds = new Set<string>();
let toastTimer: number | undefined;
let treeInitialized = false;
let lastAssistantMessage = "";
let runIsActive = false;
let memoryEnabled = false;
let memorySelectionInitialized = false;
let conversationHydrated = false;
let selectedHistoryId: string | null = null;
let selectedHistoryDetail: RunHistoryDetail | null = null;
let continuationSource: RunHistoryDetail | null = null;
let activeConversationRunId: string | null = null;
let editingSkillId: string | null = null;
let skillDeleteConfirmId: string | null = null;
let memoryDeleteArmed = false;
let conversationDeleteArmed = false;
let attachmentPaths: string[] = [];
let streamingAssistantText = "";
let streamingStep = 0;
let streamingTimelineItem: HTMLElement | null = null;
let streamingAnimationFrame: number | undefined;
let draftSaveTimer: number | undefined;
let previewCopyPath = "";
let previewCopyContent = "";
let activeDiffPath: string | null = null;
let currentFile: FileSnapshot | null = null;
let manualEditor: ManualEditorState | null = null;
let manualCancelArmed = false;
let restoreArmKey: string | null = null;
let quickOpenMatches: QuickOpenMatch[] = [];
let quickOpenSelectionIndex = 0;
let activeCodeSelection: NormalizedCodeSelection | null = null;
let activeRunEvents: AgentEvent[] = [];
let liveOutcomeCard: HTMLElement | null = null;
let historyReplayTimer: number | undefined;
let historyReplayRunning = false;
let outputFilter: OutputFilter = "all";
let outputAutoFollow = true;
let pendingFilePath: string | null = null;
const expandedDirectories = new Set<string>();
const fileOpenRequests = new LatestRequestGuard();
const activeToolTimelineItems = new Map<string, HTMLElement>();
const reviewedChangePaths = new Set<string>();
const commandOutputEntries: CommandOutputEntry[] = [];
const MAX_TIMELINE_ITEMS = 500;
const MAX_CONVERSATION_HISTORY_RUNS = 12;
const MAX_COMMAND_OUTPUT_ENTRIES = 30;

const openProjectButton = element<HTMLButtonElement>("open-project");
const welcomeOpenProjectButton = element<HTMLButtonElement>("welcome-open-project");
const refreshProjectButton = element<HTMLButtonElement>("refresh-project");
const newFileButton = element<HTMLButtonElement>("new-file");
const projectName = element<HTMLElement>("project-name");
const projectPath = element<HTMLElement>("project-path");
const fileTree = element<HTMLElement>("file-tree");
const changeList = element<HTMLElement>("change-list");
const changeCount = element<HTMLElement>("change-count");
const changeSummary = element<HTMLElement>("change-summary");
const previewTitle = element<HTMLElement>("preview-title");
const previewMeta = element<HTMLElement>("preview-meta");
const previewMode = element<HTMLElement>("preview-mode");
const previewContent = element<HTMLElement>("preview-content");
const copyFilePathButton = element<HTMLButtonElement>("copy-file-path");
const copyFileContentButton = element<HTMLButtonElement>("copy-file-content");
const editFileButton = element<HTMLButtonElement>("edit-file");
const saveFileButton = element<HTMLButtonElement>("save-file");
const cancelFileEditButton = element<HTMLButtonElement>("cancel-file-edit");
const restoreFileChangeButton = element<HTMLButtonElement>("restore-file-change");
const restoreAllChangesButton = element<HTMLButtonElement>("restore-all-changes");
const outputLog = element<HTMLElement>("output-log");
const outputSummary = element<HTMLElement>("output-summary");
const validationProgress = element<HTMLElement>("validation-progress");
const outputFollowButton = element<HTMLButtonElement>("output-follow");
const clearOutputButton = element<HTMLButtonElement>("clear-output");
const timeline = element<HTMLElement>("timeline");
const runStatus = element<HTMLElement>("run-status");
const tokenUsage = element<HTMLElement>("token-usage");
const newConversationButton = element<HTMLButtonElement>("new-conversation");
const historyButton = element<HTMLButtonElement>("history-button");
const historyCount = element<HTMLElement>("history-count");
const stopRunButton = element<HTMLButtonElement>("stop-run");
const taskForm = element<HTMLFormElement>("task-form");
const taskInput = element<HTMLTextAreaElement>("task-input");
taskInput.maxLength = MAX_TASK_CHARS;
const defaultTaskPlaceholder = taskInput.placeholder;
const startRunButton = element<HTMLButtonElement>("start-run");
const executionModeInput = element<HTMLSelectElement>("execution-mode");
const selectedContext = element<HTMLElement>("selected-context");
const attachmentsButton = element<HTMLButtonElement>("attachments-button");
const attachmentsBadge = element<HTMLElement>("attachments-badge");
const attachmentList = element<HTMLElement>("attachment-list");
const continuationContext = element<HTMLElement>("continuation-context");
const continuationTitle = element<HTMLElement>("continuation-title");
const clearContinuationButton = element<HTMLButtonElement>("clear-continuation");
const skillsButton = element<HTMLButtonElement>("skills-button");
const skillsBadge = element<HTMLElement>("skills-badge");
const memoryButton = element<HTMLButtonElement>("memory-button");
const memoryBadge = element<HTMLElement>("memory-badge");
const contextPreviewButton = element<HTMLButtonElement>("context-preview-button");
const contextPreviewDialog = element<HTMLDialogElement>("context-preview-dialog");
const contextPreviewContent = element<HTMLElement>("context-preview-content");
const skillsDialog = element<HTMLDialogElement>("skills-dialog");
const skillList = element<HTMLElement>("skill-list");
const refreshSkillsButton = element<HTMLButtonElement>("refresh-skills");
const newSkillButton = element<HTMLButtonElement>("new-skill");
const skillEditorDialog = element<HTMLDialogElement>("skill-editor-dialog");
const skillEditorForm = element<HTMLFormElement>("skill-editor-form");
const skillEditorTitle = element<HTMLElement>("skill-editor-title");
const skillFileNameInput = element<HTMLInputElement>("skill-file-name");
const skillContentInput = element<HTMLTextAreaElement>("skill-content");
const skillEditorError = element<HTMLElement>("skill-editor-error");
const closeSkillEditorButton = element<HTMLButtonElement>("close-skill-editor");
const cancelSkillEditorButton = element<HTMLButtonElement>("cancel-skill-editor");
const saveSkillButton = element<HTMLButtonElement>("save-skill");
const memoryDialog = element<HTMLDialogElement>("memory-dialog");
const memoryForm = element<HTMLFormElement>("memory-form");
const memoryInput = element<HTMLTextAreaElement>("memory-input");
const memoryEnabledInput = element<HTMLInputElement>("memory-enabled");
const memoryCharacterCount = element<HTMLElement>("memory-character-count");
const memoryUpdatedAt = element<HTMLElement>("memory-updated-at");
const memoryPreview = element<HTMLElement>("memory-preview");
const memoryError = element<HTMLElement>("memory-error");
const closeMemoryButton = element<HTMLButtonElement>("close-memory");
const cancelMemoryButton = element<HTMLButtonElement>("cancel-memory");
const deleteMemoryButton = element<HTMLButtonElement>("delete-memory");
const saveMemoryButton = element<HTMLButtonElement>("save-memory");
const importMemoryButton = element<HTMLButtonElement>("import-memory");
const exportMemoryButton = element<HTMLButtonElement>("export-memory");
const settingsButton = element<HTMLButtonElement>("settings-button");
const modelStatus = element<HTMLElement>("model-status");
const modelProfileSwitch = element<HTMLSelectElement>("model-profile-switch");
const settingsDialog = element<HTMLDialogElement>("settings-dialog");
const settingsForm = element<HTMLFormElement>("settings-form");
const settingsProfileSelect = element<HTMLSelectElement>("settings-profile-select");
const profileNameInput = element<HTMLInputElement>("profile-name");
const newModelProfileButton = element<HTMLButtonElement>("new-model-profile");
const deleteModelProfileButton = element<HTMLButtonElement>("delete-model-profile");
const profileCount = element<HTMLElement>("profile-count");
const apiBaseUrlInput = element<HTMLInputElement>("api-base-url");
const modelNameInput = element<HTMLInputElement>("model-name");
const modelPresetInput = element<HTMLSelectElement>("model-preset");
const apiKeyInput = element<HTMLInputElement>("api-key");
const apiKeyHelp = element<HTMLElement>("api-key-help");
const openModelScopeTokenButton = element<HTMLButtonElement>("open-modelscope-token");
const maxStepsInput = element<HTMLInputElement>("max-steps");
const commandTimeoutInput = element<HTMLInputElement>("command-timeout");
const permissionModeInput = element<HTMLSelectElement>("permission-mode");
const responseProfileInput = element<HTMLSelectElement>("response-profile");
const settingsError = element<HTMLElement>("settings-error");
const testModelButton = element<HTMLButtonElement>("test-model");
const modelDiagnostic = element<HTMLElement>("model-diagnostic");
const approvalPanel = element<HTMLElement>("approval-dialog");
const approvalReason = element<HTMLElement>("approval-reason");
const approvalCommand = element<HTMLElement>("approval-command");
const approvalCwd = element<HTMLElement>("approval-cwd");
const approveCommandButton = element<HTMLButtonElement>("approve-command");
const rejectCommandButton = element<HTMLButtonElement>("reject-command");
const planPanel = element<HTMLElement>("plan-panel");
const planTitle = element<HTMLElement>("plan-title");
const planProgress = element<HTMLElement>("plan-progress");
const planToggleButton = element<HTMLButtonElement>("plan-toggle");
const planList = element<HTMLOListElement>("plan-list");
const planEvidence = element<HTMLElement>("plan-evidence");
const planApprovalPanel = element<HTMLElement>("plan-approval-dialog");
const planApprovalTitle = element<HTMLElement>("plan-approval-title");
const planApprovalExplanation = element<HTMLElement>("plan-approval-explanation");
const planEditorList = element<HTMLElement>("plan-editor-list");
const addPlanStepButton = element<HTMLButtonElement>("add-plan-step");
const approvePlanButton = element<HTMLButtonElement>("approve-plan");
const rejectPlanButton = element<HTMLButtonElement>("reject-plan");
const historyDialog = element<HTMLDialogElement>("history-dialog");
const historyList = element<HTMLElement>("history-list");
const historyDetail = element<HTMLElement>("history-detail");
const continueHistoryButton = element<HTMLButtonElement>("continue-history");
const deleteConversationButton = element<HTMLButtonElement>("delete-conversation");
const exportRunReportButton = element<HTMLButtonElement>("export-run-report");
const quickOpenDialog = element<HTMLDialogElement>("quick-open-dialog");
const quickOpenForm = element<HTMLFormElement>("quick-open-form");
const quickOpenInput = element<HTMLInputElement>("quick-open-input");
const quickOpenCount = element<HTMLElement>("quick-open-count");
const quickOpenList = element<HTMLElement>("quick-open-list");
const newFileDialog = element<HTMLDialogElement>("new-file-dialog");
const newFileForm = element<HTMLFormElement>("new-file-form");
const newFilePathInput = element<HTMLInputElement>("new-file-path");
const newFileContentInput = element<HTMLTextAreaElement>("new-file-content");
const newFileError = element<HTMLElement>("new-file-error");
const closeNewFileButton = element<HTMLButtonElement>("close-new-file");
const cancelNewFileButton = element<HTMLButtonElement>("cancel-new-file");
const createNewFileButton = element<HTMLButtonElement>("create-new-file");
const toast = element<HTMLElement>("toast");
const workbench = element<HTMLElement>("workbench");
const leftResizer = element<HTMLElement>("left-resizer");
const rightResizer = element<HTMLElement>("right-resizer");
const projectPanel = document.querySelector<HTMLElement>(".project-panel");
const previewPanel = document.querySelector<HTMLElement>(".preview-panel");
const projectRowResizer = element<HTMLElement>("project-row-resizer");
const previewRowResizer = element<HTMLElement>("preview-row-resizer");
const codeSelectionToolbar = element<HTMLElement>("code-selection-toolbar");
const codeSelectionLabel = element<HTMLElement>("code-selection-label");

if (!projectPanel || !previewPanel) {
  throw new Error("找不到可调整高度的主面板。");
}

openProjectButton.addEventListener("click", () => void selectProject());
welcomeOpenProjectButton.addEventListener("click", () => void selectProject());
refreshProjectButton.addEventListener("click", () => void refreshProject());
newFileButton.addEventListener("click", openNewFileDialog);
clearOutputButton.addEventListener("click", clearCommandOutput);
outputFollowButton.addEventListener("click", () => {
  outputAutoFollow = !outputAutoFollow;
  outputFollowButton.classList.toggle("active", outputAutoFollow);
  outputFollowButton.setAttribute("aria-pressed", String(outputAutoFollow));
  outputFollowButton.textContent = outputAutoFollow ? "自动跟随" : "已暂停跟随";
  if (outputAutoFollow) outputLog.scrollTop = outputLog.scrollHeight;
});
document.querySelectorAll<HTMLButtonElement>("[data-output-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextFilter = button.dataset.outputFilter as OutputFilter | undefined;
    if (!nextFilter) return;
    outputFilter = nextFilter;
    renderCommandOutput();
  });
});
settingsButton.addEventListener("click", () => void openSettings());
modelProfileSwitch.addEventListener("change", () => void switchModelProfile());
newConversationButton.addEventListener("click", newConversation);
historyButton.addEventListener("click", () => void openHistory());
continueHistoryButton.addEventListener("click", () => void continueSelectedHistory());
deleteConversationButton.addEventListener("click", () => void deleteSelectedConversation());
stopRunButton.addEventListener("click", () => void stopRun());
taskForm.addEventListener("submit", (event) => void startRun(event));
taskInput.addEventListener("input", scheduleDraftPersistence);
copyFilePathButton.addEventListener("click", () => void copyPreviewValue("path"));
copyFileContentButton.addEventListener("click", () => void copyPreviewValue("content"));
editFileButton.addEventListener("click", beginManualEdit);
saveFileButton.addEventListener("click", () => void saveManualEdit());
cancelFileEditButton.addEventListener("click", () => cancelManualEdit());
restoreFileChangeButton.addEventListener("click", () => void restoreCurrentFile());
restoreAllChangesButton.addEventListener("click", () => void restoreAllChanges());
attachmentsButton.addEventListener("click", () => void selectAttachments());
skillsButton.addEventListener("click", openSkills);
memoryButton.addEventListener("click", openMemory);
contextPreviewButton.addEventListener("click", () => void openContextPreview());
clearContinuationButton.addEventListener("click", () => void clearContinuation(true, true));
refreshSkillsButton.addEventListener("click", () => void loadProjectContext(true));
newSkillButton.addEventListener("click", openNewSkill);
skillEditorForm.addEventListener("submit", (event) => void saveSkill(event));
closeSkillEditorButton.addEventListener("click", closeSkillEditor);
cancelSkillEditorButton.addEventListener("click", closeSkillEditor);
skillEditorDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSkillEditor();
});
memoryForm.addEventListener("submit", (event) => void saveMemory(event));
memoryInput.addEventListener("input", () => {
  renderMemoryCharacterCount();
  renderMemoryUseOption();
  renderMemoryPreview();
});
closeMemoryButton.addEventListener("click", () => memoryDialog.close());
cancelMemoryButton.addEventListener("click", () => memoryDialog.close());
deleteMemoryButton.addEventListener("click", () => void deleteMemory());
importMemoryButton.addEventListener("click", () => void importMemory());
exportMemoryButton.addEventListener("click", () => void exportMemory());
settingsForm.addEventListener("submit", (event) => void saveSettings(event));
settingsProfileSelect.addEventListener("change", selectSettingsProfile);
newModelProfileButton.addEventListener("click", newModelProfile);
deleteModelProfileButton.addEventListener("click", () => void deleteModelProfile());
testModelButton.addEventListener("click", () => void testModelConnection());
modelPresetInput.addEventListener("change", selectModelPreset);
modelNameInput.addEventListener("input", syncModelPreset);
openModelScopeTokenButton.addEventListener("click", () => void api.openModelScopeTokenPage());
exportRunReportButton.addEventListener("click", () => void exportSelectedRunReport());
codeSelectionToolbar.querySelectorAll<HTMLButtonElement>("[data-selection-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.selectionAction as CodeSelectionAction | undefined;
    if (action) applyCodeSelectionAction(action);
  });
});
approveCommandButton.addEventListener("click", (event) => void answerApproval(event, true));
rejectCommandButton.addEventListener("click", (event) => void answerApproval(event, false));
addPlanStepButton.addEventListener("click", addPlanStep);
approvePlanButton.addEventListener("click", () => void answerPlanApproval(true));
rejectPlanButton.addEventListener("click", () => void answerPlanApproval(false));
planToggleButton.addEventListener("click", () => setPlanCollapsed(!planCollapsed));
quickOpenInput.addEventListener("input", () => {
  quickOpenSelectionIndex = 0;
  renderQuickOpenResults();
});
quickOpenInput.addEventListener("keydown", handleQuickOpenKeydown);
quickOpenForm.addEventListener("submit", handleQuickOpenSubmit);
newFileForm.addEventListener("submit", (event) => void createManualFile(event));
closeNewFileButton.addEventListener("click", closeNewFileDialog);
cancelNewFileButton.addEventListener("click", closeNewFileDialog);
newFileDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeNewFileDialog();
});
document.addEventListener("keydown", handleGlobalShortcut);
previewContent.addEventListener("mouseup", (event) => captureCodeSelection(event));
previewContent.addEventListener("keyup", () => captureCodeSelection());
document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (
    target instanceof Node &&
    !codeSelectionToolbar.contains(target) &&
    !previewContent.contains(target)
  ) {
    hideCodeSelectionToolbar();
  }
});
historyDialog.addEventListener("close", () => stopHistoryReplay());
window.addEventListener("beforeunload", (event) => {
  persistDraftNow();
  if (manualEditor && isEditorDirty(manualEditor.textarea.value, manualEditor.originalNormalized)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

setupPanelResizing({
  workbench,
  leftResizer,
  rightResizer,
  projectPanel,
  projectRowResizer,
  previewPanel,
  previewRowResizer,
});

api.onAgentEvent(handleAgentEvent);
api.onApprovalRequested(showApproval);
api.onPlanApprovalRequested(showPlanApproval);
api.onChangesUpdated((nextChanges) => {
  changes = nextChanges;
  const currentPaths = new Set(nextChanges.map((change) => change.relativePath));
  for (const path of reviewedChangePaths) {
    if (!currentPaths.has(path)) reviewedChangePaths.delete(path);
  }
  restoreArmKey = null;
  renderChanges();
  refreshLiveOutcomeCard();
  void refreshProject(false);
  void loadRunHistory();
});

void initialize();

async function initialize(): Promise<void> {
  try {
    await loadModelProfiles();
  } catch (error) {
    notify(errorMessage(error));
  }
  try {
    const restored = await api.restoreProject();
    if (restored) {
      await activateProject(restored);
      notify(taskInput.value ? "已恢复上次项目和未发送草稿。" : "已恢复上次项目。");
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function selectProject(): Promise<void> {
  if (!canLeaveManualEditor("打开其他项目")) {
    return;
  }
  try {
    persistDraftNow();
    const selected = await api.selectProject();
    if (!selected) {
      return;
    }
    await activateProject(selected);
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function activateProject(selected: ProjectSnapshot): Promise<void> {
  project = selected;
  selectedFile = null;
  currentFile = null;
  manualEditor = null;
  manualCancelArmed = false;
  changes = [];
  reviewedChangePaths.clear();
  clearCommandOutput();
  activeDiffPath = null;
  restoreArmKey = null;
  selectedSkillIds.clear();
  runHistory = [];
  memoryEnabled = false;
  memorySelectionInitialized = false;
  conversationHydrated = false;
  selectedHistoryId = null;
  selectedHistoryDetail = null;
  continuationSource = null;
  activeConversationRunId = null;
  editingSkillId = null;
  skillDeleteConfirmId = null;
  memoryDeleteArmed = false;
  conversationDeleteArmed = false;
  attachmentPaths = [];
  taskInput.value = loadTaskDraft(window.localStorage, selected.rootPath);
  renderTokenUsage(null);
  renderContinuationContext();
  renderAttachments();
  projectContext = {
    skills: [],
    memory: "",
    memoryUpdatedAt: null,
    maxMemoryChars: 12_000,
    maxSelectedSkills: 8,
  };
  treeInitialized = false;
  expandedDirectories.clear();
  clearTimeline(true);
  resetPlanUi();
  renderProject();
  renderChanges();
  showProjectWelcome();
  await Promise.all([loadProjectContext(), loadRunHistory()]);
  await hydrateConversationFromHistory();
}

async function refreshProject(showMessage = true): Promise<void> {
  if (!canLeaveManualEditor("刷新项目结构")) {
    return;
  }
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

function handleGlobalShortcut(event: KeyboardEvent): void {
  if (
    !event.defaultPrevented &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLocaleLowerCase() === "s" &&
    manualEditor
  ) {
    event.preventDefault();
    void saveManualEdit();
    return;
  }
  if (
    event.defaultPrevented ||
    (!event.ctrlKey && !event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    event.key.toLocaleLowerCase() !== "p"
  ) {
    return;
  }
  event.preventDefault();
  openQuickOpen();
}

function openQuickOpen(): void {
  if (!canLeaveManualEditor("快速打开其他文件")) {
    return;
  }
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  const anotherDialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (anotherDialog && anotherDialog !== quickOpenDialog) {
    notify("请先关闭当前窗口，再快速打开文件。");
    return;
  }
  quickOpenInput.value = "";
  quickOpenSelectionIndex = 0;
  renderQuickOpenResults();
  if (!quickOpenDialog.open) {
    quickOpenDialog.showModal();
  }
  quickOpenInput.focus();
}

function renderQuickOpenResults(): void {
  quickOpenMatches = rankQuickOpen(project?.files ?? [], quickOpenInput.value);
  quickOpenSelectionIndex = Math.min(
    quickOpenSelectionIndex,
    Math.max(0, quickOpenMatches.length - 1),
  );
  quickOpenCount.textContent = `${quickOpenMatches.length} 个匹配文件`;
  quickOpenList.replaceChildren();
  if (quickOpenMatches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "quick-open-empty";
    empty.textContent = "没有匹配的项目文件。";
    quickOpenList.append(empty);
    return;
  }
  quickOpenMatches.forEach((match, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quick-open-result${index === quickOpenSelectionIndex ? " selected" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === quickOpenSelectionIndex));
    const name = document.createElement("strong");
    name.textContent = match.fileName;
    const pathValue = document.createElement("span");
    pathValue.textContent = match.relativePath;
    button.append(name, pathValue);
    button.addEventListener("mousemove", () => {
      if (quickOpenSelectionIndex !== index) {
        quickOpenSelectionIndex = index;
        updateQuickOpenSelection();
      }
    });
    button.addEventListener("click", () => void selectQuickOpenMatch(index));
    quickOpenList.append(button);
  });
}

function handleQuickOpenKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (quickOpenMatches.length === 0) {
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    quickOpenSelectionIndex =
      (quickOpenSelectionIndex + direction + quickOpenMatches.length) % quickOpenMatches.length;
    updateQuickOpenSelection();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void selectQuickOpenMatch(quickOpenSelectionIndex);
  }
}

function handleQuickOpenSubmit(event: SubmitEvent): void {
  const submitter = event.submitter as HTMLButtonElement | null;
  if (submitter?.value === "cancel") {
    return;
  }
  event.preventDefault();
  void selectQuickOpenMatch(quickOpenSelectionIndex);
}

function updateQuickOpenSelection(): void {
  quickOpenList.querySelectorAll<HTMLButtonElement>(".quick-open-result").forEach(
    (button, index) => {
      const selected = index === quickOpenSelectionIndex;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
      if (selected) {
        button.scrollIntoView({ block: "nearest" });
      }
    },
  );
}

async function selectQuickOpenMatch(index: number): Promise<void> {
  const match = quickOpenMatches[index];
  if (!match) {
    return;
  }
  if (quickOpenDialog.open) {
    quickOpenDialog.close("selected");
  }
  await openFile(match.relativePath);
}

function renderProject(): void {
  if (!project) {
    return;
  }
  projectName.textContent = project.name;
  projectPath.textContent = displayLocalPath(project.rootPath);
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
  treeInitialized = true;
  fileTree.scrollTop = previousScrollTop;
  newConversationButton.disabled = runIsActive;
  attachmentsButton.disabled = runIsActive;
  newFileButton.disabled = runIsActive || !project || Boolean(manualEditor);
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
    button.className = `tree-file${selectedFile === relativePath ? " selected" : ""}${pendingFilePath === relativePath ? " loading" : ""}`;
    button.title = relativePath;
    button.dataset.path = relativePath;
    const indent = document.createElement("span");
    indent.className = "tree-indent";
    indent.setAttribute("aria-hidden", "true");
    const icon = createFileIcon(relativePath);
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

function createFileIcon(relativePath: string): HTMLSpanElement {
  const visual = fileVisualFor(relativePath);
  const icon = document.createElement("span");
  icon.className = `file-icon ${visual.className}`;
  icon.setAttribute("aria-hidden", "true");
  if (visual.className !== "icon-default") {
    icon.textContent = visual.label;
    return icon;
  }

  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 16 18");
  svg.setAttribute("focusable", "false");
  const outline = document.createElementNS(namespace, "path");
  outline.setAttribute("d", "M3 1.5h5.6l4.1 4.1v10.9H3z");
  const fold = document.createElementNS(namespace, "path");
  fold.setAttribute("d", "M8.6 1.8v4h3.8");
  const lines = document.createElementNS(namespace, "path");
  lines.setAttribute("d", "M5.4 9.2h4.9M5.4 12.2h4.9");
  svg.append(outline, fold, lines);
  icon.append(svg);
  return icon;
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
    button.classList.toggle("loading", button.dataset.path === pendingFilePath);
  });
}

async function openFile(relativePath: string): Promise<void> {
  if (manualEditor) {
    if (manualEditor.relativePath === relativePath) {
      manualEditor.textarea.focus();
    } else {
      canLeaveManualEditor("打开其他文件");
    }
    return;
  }
  const revision = fileOpenRequests.begin();
  pendingFilePath = relativePath;
  updateFileSelection();
  renderManualEditorActions();
  try {
    const file = await api.readFile(relativePath);
    if (!fileOpenRequests.isCurrent(revision)) {
      return;
    }
    pendingFilePath = null;
    showFileSnapshot(file);
  } catch (error) {
    if (!fileOpenRequests.isCurrent(revision)) {
      return;
    }
    pendingFilePath = null;
    updateFileSelection();
    renderManualEditorActions();
    notify(errorMessage(error));
  }
}

function cancelPendingFileOpen(): void {
  fileOpenRequests.cancel();
  pendingFilePath = null;
  updateFileSelection();
}

function showFileSnapshot(file: FileSnapshot): void {
  hideCodeSelectionToolbar();
  currentFile = file;
  selectedFile = file.relativePath;
  activeDiffPath = null;
  restoreArmKey = null;
  previewTitle.textContent = file.relativePath;
  previewMeta.textContent = `${file.language} · ${formatBytes(file.size)} · 可编辑`;
  previewMode.textContent = "FILE";
  previewContent.replaceChildren(codePreview(file.content));
  setPreviewCopyValues(file.relativePath, file.content);
  selectedContext.textContent = `上下文：${file.relativePath}`;
  updateFileSelection();
  renderChanges();
  renderRestoreActions();
  renderManualEditorActions();
}

function beginManualEdit(): void {
  if (!currentFile || runIsActive || manualEditor) {
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.className = "manual-editor";
  textarea.value = normalizeEditorContent(currentFile.content);
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", `编辑 ${currentFile.relativePath}`);
  const lineNumbers = document.createElement("pre");
  lineNumbers.className = "code-line-numbers";
  lineNumbers.setAttribute("aria-hidden", "true");
  const frame = document.createElement("div");
  frame.className = "manual-editor-frame";
  frame.append(lineNumbers, textarea);
  manualEditor = {
    relativePath: currentFile.relativePath,
    originalNormalized: textarea.value,
    expectedHash: currentFile.contentHash,
    lineEnding: detectLineEnding(currentFile.content),
    textarea,
    lineNumbers,
  };
  manualCancelArmed = false;
  hideCodeSelectionToolbar();
  textarea.addEventListener("input", updateManualEditorState);
  textarea.addEventListener("scroll", () => {
    lineNumbers.scrollTop = textarea.scrollTop;
  });
  previewContent.replaceChildren(frame);
  updateManualEditorState();
  renderManualEditorActions();
  textarea.focus();
}

function updateManualEditorState(): void {
  if (!manualEditor || !currentFile) {
    return;
  }
  const dirty = isEditorDirty(
    manualEditor.textarea.value,
    manualEditor.originalNormalized,
  );
  const lines = manualEditor.textarea.value.split("\n").length;
  manualEditor.lineNumbers.textContent = Array.from(
    { length: lines },
    (_, index) => index + 1,
  ).join("\n");
  const bytes = editorByteLength(manualEditor.textarea.value, manualEditor.lineEnding);
  previewMeta.textContent = `${currentFile.language} · ${formatBytes(bytes)} · ${dirty ? "未保存" : "编辑中"}`;
  previewCopyContent = serializeEditorContent(
    manualEditor.textarea.value,
    manualEditor.lineEnding,
  );
  manualCancelArmed = false;
  renderManualEditorActions();
}

async function saveManualEdit(): Promise<void> {
  if (!manualEditor || !currentFile || runIsActive) {
    return;
  }
  const editor = manualEditor;
  const content = serializeEditorContent(editor.textarea.value, editor.lineEnding);
  if (!isEditorDirty(editor.textarea.value, editor.originalNormalized)) {
    cancelManualEdit(true);
    notify("文件内容没有变化。");
    return;
  }
  const wasAgentChange = changes.some((change) => change.relativePath === editor.relativePath);
  saveFileButton.disabled = true;
  try {
    const result = await api.saveFile({
      relativePath: editor.relativePath,
      content,
      expectedHash: editor.expectedHash,
    });
    manualEditor = null;
    manualCancelArmed = false;
    changes = result.changes;
    showFileSnapshot(result.file);
    await refreshProject(false);
    renderChanges();
    notify(
      wasAgentChange
        ? "文件已保存，并已从本次 Agent 变更区移除。"
        : "文件已保存。",
    );
  } catch (error) {
    saveFileButton.disabled = false;
    notify(errorMessage(error));
  }
}

function cancelManualEdit(force = false): void {
  if (!manualEditor || !currentFile) {
    return;
  }
  const dirty = isEditorDirty(
    manualEditor.textarea.value,
    manualEditor.originalNormalized,
  );
  if (dirty && !force && !manualCancelArmed) {
    manualCancelArmed = true;
    renderManualEditorActions();
    notify("再点一次“确认放弃”，未保存内容不会写入文件。");
    return;
  }
  const file = currentFile;
  manualEditor = null;
  manualCancelArmed = false;
  showFileSnapshot(file);
}

function renderManualEditorActions(): void {
  const editing = Boolean(manualEditor);
  editFileButton.hidden = !currentFile || editing || activeDiffPath !== null;
  editFileButton.disabled = runIsActive || !currentFile || pendingFilePath !== null;
  saveFileButton.hidden = !editing;
  saveFileButton.disabled = runIsActive || !editing;
  cancelFileEditButton.hidden = !editing;
  cancelFileEditButton.disabled = runIsActive || !editing;
  cancelFileEditButton.textContent = manualCancelArmed ? "确认放弃" : "取消";
  newFileButton.disabled = runIsActive || !project || editing || pendingFilePath !== null;
}

function canLeaveManualEditor(action: string): boolean {
  if (!manualEditor) {
    return true;
  }
  notify(`请先保存或取消当前编辑，再${action}。`);
  manualEditor.textarea.focus();
  return false;
}

function openNewFileDialog(): void {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  if (runIsActive || !canLeaveManualEditor("新建文件")) {
    return;
  }
  newFilePathInput.value = "";
  newFileContentInput.value = "";
  newFileError.textContent = "";
  createNewFileButton.disabled = false;
  newFileDialog.showModal();
  newFilePathInput.focus();
}

function closeNewFileDialog(): void {
  if (newFileDialog.open) {
    newFileDialog.close();
  }
}

async function createManualFile(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!project || runIsActive) {
    return;
  }
  newFileError.textContent = "";
  createNewFileButton.disabled = true;
  try {
    const result = await api.createFile({
      relativePath: newFilePathInput.value.trim(),
      content: newFileContentInput.value,
    });
    changes = result.changes;
    closeNewFileDialog();
    await refreshProject(false);
    showFileSnapshot(result.file);
    renderChanges();
    notify(`已创建 ${result.file.relativePath}。`);
  } catch (error) {
    newFileError.textContent = errorMessage(error);
    createNewFileButton.disabled = false;
  }
}

function renderChanges(): void {
  changeCount.textContent = String(changes.length);
  changeList.replaceChildren();
  if (changes.length === 0) {
    changeSummary.textContent = "等待 Agent 修改";
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "Agent 修改的文件会集中显示。";
    changeList.append(empty);
    renderRestoreActions();
    return;
  }

  const entries = changes.map((change) => ({ change, evidence: changeEvidence(change) }));
  const totalAdditions = entries.reduce((total, entry) => total + entry.evidence.additions, 0);
  const totalDeletions = entries.reduce((total, entry) => total + entry.evidence.deletions, 0);
  const reviewedCount = changes.filter((change) => reviewedChangePaths.has(change.relativePath)).length;
  const estimated = entries.some((entry) => entry.evidence.estimated);
  changeSummary.textContent = `${estimated ? "约 " : ""}+${totalAdditions} / -${totalDeletions} · 已审查 ${reviewedCount}/${changes.length}`;

  for (const { change, evidence } of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `change-file ${evidence.kind}${activeDiffPath === change.relativePath ? " selected" : ""}${reviewedChangePaths.has(change.relativePath) ? " reviewed" : ""}`;
    button.title = `查看 ${change.relativePath} 的修改前后差异`;

    const kind = document.createElement("span");
    kind.className = `change-kind ${evidence.kind}`;
    kind.textContent = evidence.kind === "added" ? "A" : "M";
    kind.title = evidence.kind === "added" ? "新增文件" : "修改文件";

    const icon = createFileIcon(change.relativePath);

    const path = document.createElement("span");
    path.className = "change-path";
    const segments = change.relativePath.split("/");
    const name = document.createElement("strong");
    name.textContent = segments.pop() ?? change.relativePath;
    const directory = document.createElement("small");
    directory.textContent = segments.length > 0 ? segments.join("/") : "项目根目录";
    path.append(name, directory);

    const meta = document.createElement("span");
    meta.className = "change-meta";
    const stats = document.createElement("span");
    stats.className = "change-line-stats";
    const additions = document.createElement("b");
    additions.textContent = `+${evidence.additions}`;
    const deletions = document.createElement("i");
    deletions.textContent = `−${evidence.deletions}`;
    stats.append(additions, deletions);
    const review = document.createElement("span");
    review.className = "change-review-mark";
    review.textContent = reviewedChangePaths.has(change.relativePath) ? "✓" : "·";
    review.title = reviewedChangePaths.has(change.relativePath) ? "已经打开审查" : "尚未审查";
    meta.append(stats, review);

    const heat = document.createElement("span");
    heat.className = "change-heat";
    const total = evidence.additions + evidence.deletions;
    const additionBar = document.createElement("span");
    additionBar.className = "change-heat-add";
    additionBar.style.width = `${evidence.additions > 0 ? Math.max(8, (evidence.additions / total) * 100) : 0}%`;
    const deletionBar = document.createElement("span");
    deletionBar.className = "change-heat-delete";
    deletionBar.style.width = `${evidence.deletions > 0 ? Math.max(8, (evidence.deletions / total) * 100) : 0}%`;
    heat.append(additionBar, deletionBar);

    button.append(kind, icon, path, meta, heat);
    button.addEventListener("click", () => showDiff(change));
    changeList.append(button);
  }
  renderRestoreActions();
}

function showDiff(change: ChangedFileSnapshot): void {
  if (!canLeaveManualEditor("查看 Agent Diff")) {
    return;
  }
  cancelPendingFileOpen();
  selectedFile = change.relativePath;
  hideCodeSelectionToolbar();
  currentFile = null;
  activeDiffPath = change.relativePath;
  reviewedChangePaths.add(change.relativePath);
  restoreArmKey = null;
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
  setPreviewCopyValues(change.relativePath, change.currentContent);
  selectedContext.textContent = `上下文：${change.relativePath}`;
  updateFileSelection();
  renderChanges();
  renderRestoreActions();
  renderManualEditorActions();
}

function renderRestoreActions(): void {
  const activeChange = activeDiffPath
    ? changes.find((change) => change.relativePath === activeDiffPath)
    : undefined;
  restoreFileChangeButton.hidden = !activeChange;
  restoreFileChangeButton.disabled = runIsActive || !activeChange;
  restoreFileChangeButton.textContent = restoreArmKey === activeDiffPath
    ? "确认撤销此文件"
    : "撤销此文件";
  restoreAllChangesButton.hidden = changes.length === 0;
  restoreAllChangesButton.disabled = runIsActive || changes.length === 0;
  restoreAllChangesButton.textContent = restoreArmKey === "*"
    ? `确认撤销 ${changes.length} 个文件`
    : "全部撤销";
}

async function restoreCurrentFile(): Promise<void> {
  const change = activeDiffPath
    ? changes.find((item) => item.relativePath === activeDiffPath)
    : undefined;
  if (!change || runIsActive) {
    return;
  }
  if (restoreArmKey !== change.relativePath) {
    restoreArmKey = change.relativePath;
    renderRestoreActions();
    notify("再点一次确认撤销；若文件已被外部修改，将自动停止保护现有内容。");
    return;
  }
  restoreFileChangeButton.disabled = true;
  try {
    const result = await api.restoreChanges({
      files: [{ relativePath: change.relativePath, currentHash: change.currentHash }],
    });
    changes = result.changes;
    activeDiffPath = null;
    restoreArmKey = null;
    await refreshProject(false);
    if (change.originalContent === null) {
      selectedFile = null;
      showProjectWelcome();
    } else {
      await openFile(change.relativePath);
    }
    renderChanges();
    notify(`已撤销 ${change.relativePath} 的本次变更。`);
  } catch (error) {
    restoreArmKey = null;
    renderRestoreActions();
    notify(errorMessage(error));
  }
}

async function restoreAllChanges(): Promise<void> {
  if (changes.length === 0 || runIsActive) {
    return;
  }
  if (restoreArmKey !== "*") {
    restoreArmKey = "*";
    renderRestoreActions();
    notify("再点一次确认全部撤销；检测到外部修改时不会覆盖。 ");
    return;
  }
  restoreAllChangesButton.disabled = true;
  try {
    const result = await api.restoreChanges({
      files: changes.map((change) => ({
        relativePath: change.relativePath,
        currentHash: change.currentHash,
      })),
    });
    changes = result.changes;
    activeDiffPath = null;
    restoreArmKey = null;
    selectedFile = null;
    await refreshProject(false);
    showProjectWelcome();
    renderChanges();
    notify(`已撤销 ${result.restoredFiles.length} 个文件的本次变更。`);
  } catch (error) {
    restoreArmKey = null;
    renderRestoreActions();
    notify(errorMessage(error));
  }
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
  cancelPendingFileOpen();
  hideCodeSelectionToolbar();
  currentFile = null;
  activeDiffPath = null;
  restoreArmKey = null;
  previewTitle.textContent = project ? project.name : "代码预览";
  previewMeta.textContent = project ? `${project.files.length} 个文件` : "只读";
  previewMode.textContent = "PROJECT";
  const welcome = document.createElement("div");
  welcome.className = "welcome-state";
  const mark = document.createElement("img");
  mark.className = "welcome-mark";
  mark.src = "./app-icon.svg";
  mark.alt = "RepoForge 代码锻造智能体";
  const kicker = document.createElement("span");
  kicker.className = "welcome-kicker";
  kicker.textContent = "REPOFORGE · 代码锻造";
  const heading = document.createElement("h1");
  heading.textContent = project ? `${project.name} 已就绪` : "从项目结构开始";
  const copy = document.createElement("p");
  copy.textContent = "从左侧选择文件查看代码，或直接在右侧描述希望 Agent 完成的任务。";
  const hints = document.createElement("div");
  hints.className = "welcome-hints";
  hints.setAttribute("aria-label", "核心能力");
  for (const hint of ["预览与编辑", "命令审批", "Diff 审查"]) {
    const item = document.createElement("span");
    item.textContent = hint;
    hints.append(item);
  }
  welcome.append(mark, kicker, heading, copy, hints);
  previewContent.replaceChildren(welcome);
  setPreviewCopyValues("", "");
  selectedContext.textContent = "未选择文件";
  renderRestoreActions();
  renderManualEditorActions();
}

function codePreview(content: string): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "code-frame";
  const lineNumbers = document.createElement("pre");
  lineNumbers.className = "code-line-numbers";
  lineNumbers.setAttribute("aria-hidden", "true");
  const lineCount = content.split("\n").length;
  lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  const code = document.createElement("pre");
  code.className = "code-view";
  code.textContent = content;
  frame.append(lineNumbers, code);
  return frame;
}

function captureCodeSelection(event?: MouseEvent): void {
  if (!currentFile || activeDiffPath) {
    hideCodeSelectionToolbar();
    return;
  }
  let startOffset = 0;
  let endOffset = 0;
  let content = currentFile.content;
  if (manualEditor) {
    startOffset = manualEditor.textarea.selectionStart;
    endOffset = manualEditor.textarea.selectionEnd;
    content = manualEditor.textarea.value;
  } else {
    const code = previewContent.querySelector<HTMLElement>(".code-view");
    if (!code) {
      hideCodeSelectionToolbar();
      return;
    }
    const offsets = selectionOffsetsWithin(code);
    if (!offsets) {
      hideCodeSelectionToolbar();
      return;
    }
    ({ startOffset, endOffset } = offsets);
  }
  const normalized = normalizeCodeSelection({
    relativePath: currentFile.relativePath,
    language: currentFile.language,
    content,
    startOffset,
    endOffset,
  });
  if (!normalized) {
    hideCodeSelectionToolbar();
    return;
  }
  activeCodeSelection = normalized;
  codeSelectionLabel.textContent = `第 ${normalized.startLine}—${normalized.endLine} 行`;
  const x = event ? event.clientX : previewContent.getBoundingClientRect().right - 24;
  const y = event ? event.clientY : previewContent.getBoundingClientRect().top + 64;
  codeSelectionToolbar.style.left = `${Math.max(16, Math.min(window.innerWidth - 520, x))}px`;
  codeSelectionToolbar.style.top = `${Math.max(72, Math.min(window.innerHeight - 72, y + 12))}px`;
  codeSelectionToolbar.hidden = false;
}

function selectionOffsetsWithin(element: HTMLElement): { startOffset: number; endOffset: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const startOffset = prefix.toString().length;
  return { startOffset, endOffset: startOffset + range.toString().length };
}

function applyCodeSelectionAction(action: CodeSelectionAction): void {
  if (!activeCodeSelection || runIsActive) return;
  const generated = buildCodeSelectionTask(action, activeCodeSelection);
  const existing = taskInput.value.trim();
  const next = existing ? `${existing}\n\n${generated}` : generated;
  if (next.length > MAX_TASK_CHARS) {
    notify("当前任务加上代码选区后超过 20,000 字符，请先精简任务或选区。");
    return;
  }
  taskInput.value = next;
  selectedFile = activeCodeSelection.relativePath;
  selectedContext.textContent = `上下文：${activeCodeSelection.relativePath} · 第 ${activeCodeSelection.startLine}—${activeCodeSelection.endLine} 行`;
  scheduleDraftPersistence();
  hideCodeSelectionToolbar();
  taskInput.focus();
  taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
  notify("代码选区已加入可编辑的任务草稿，确认后再发送。 ");
}

function hideCodeSelectionToolbar(): void {
  activeCodeSelection = null;
  codeSelectionToolbar.hidden = true;
}

function setPreviewCopyValues(relativePath: string, content: string): void {
  previewCopyPath = relativePath;
  previewCopyContent = content;
  copyFilePathButton.disabled = !relativePath;
  copyFileContentButton.disabled = !relativePath;
}

async function copyPreviewValue(kind: "path" | "content"): Promise<void> {
  const value = kind === "path" ? previewCopyPath : previewCopyContent;
  if (!value && kind === "path") {
    return;
  }
  try {
    await writeClipboard(value);
    notify(kind === "path" ? "已复制项目内路径。" : "已复制文件内容。");
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) {
    throw new Error("复制失败，请重试。");
  }
}

async function loadModelProfiles(): Promise<void> {
  modelProfiles = await api.getModelProfiles();
  currentSettings = modelProfiles.profiles.find(
    (profile) => profile.profileId === modelProfiles.activeProfileId,
  ) ?? await api.getSettings();
  renderModelProfileSwitch();
  renderModelStatus();
}

function renderModelProfileSwitch(): void {
  modelProfileSwitch.replaceChildren();
  for (const profile of modelProfiles.profiles) {
    const option = document.createElement("option");
    option.value = profile.profileId;
    option.textContent = `${profile.profileName} · ${profileCapabilityLabel(profile)}`;
    option.title = `${profile.model}\n${profile.apiBaseUrl}`;
    modelProfileSwitch.append(option);
  }
  modelProfileSwitch.value = modelProfiles.activeProfileId;
  const active = modelProfiles.profiles.find(
    (profile) => profile.profileId === modelProfiles.activeProfileId,
  );
  modelProfileSwitch.title = active
    ? `${active.model}\n${active.apiBaseUrl}`
    : "快速切换模型配置";
  modelProfileSwitch.disabled = runIsActive || modelProfiles.profiles.length === 0;
}

function profileCapabilityLabel(profile: ModelProfileSummary): string {
  if (!profile.hasApiKey) {
    return "缺少 Key";
  }
  if (!profile.lastDiagnostic) {
    return "未测试";
  }
  return profile.lastDiagnostic.ok ? "✓ Agent" : "! 需检查";
}

async function switchModelProfile(): Promise<void> {
  if (runIsActive || !modelProfileSwitch.value) {
    modelProfileSwitch.value = modelProfiles.activeProfileId;
    return;
  }
  const nextId = modelProfileSwitch.value;
  if (nextId === modelProfiles.activeProfileId) {
    return;
  }
  modelProfileSwitch.disabled = true;
  try {
    currentSettings = await api.activateModelProfile(nextId);
    await loadModelProfiles();
    if (project) {
      appendTimeline(
        "模型已切换",
        `${currentSettings.profileName}\n${currentSettings.model}\n从下一条任务开始生效。`,
        "success",
      );
    }
    notify(`已切换到 ${currentSettings.profileName}。`);
  } catch (error) {
    modelProfileSwitch.value = modelProfiles.activeProfileId;
    notify(errorMessage(error));
  } finally {
    modelProfileSwitch.disabled = runIsActive;
  }
}

async function openSettings(): Promise<void> {
  try {
    await loadModelProfiles();
    editingModelProfileId = modelProfiles.activeProfileId;
    modelProfileDeleteArmed = false;
    renderSettingsProfileSelect();
    const active = modelProfiles.profiles.find(
      (profile) => profile.profileId === editingModelProfileId,
    );
    if (active) {
      applyProfileToSettingsForm(active);
    }
    settingsError.textContent = "";
    modelDiagnostic.hidden = true;
    modelDiagnostic.replaceChildren();
    settingsDialog.showModal();
  } catch (error) {
    notify(errorMessage(error));
  }
}

function renderSettingsProfileSelect(): void {
  settingsProfileSelect.replaceChildren();
  for (const profile of modelProfiles.profiles) {
    const option = document.createElement("option");
    option.value = profile.profileId;
    option.textContent = `${profile.profileName} · ${profileCapabilityLabel(profile)}`;
    settingsProfileSelect.append(option);
  }
  if (!editingModelProfileId) {
    const draft = document.createElement("option");
    draft.value = "__new__";
    draft.textContent = "新配置（尚未保存）";
    settingsProfileSelect.append(draft);
    settingsProfileSelect.value = draft.value;
  } else {
    settingsProfileSelect.value = editingModelProfileId;
  }
  profileCount.textContent = `${modelProfiles.profiles.length} / ${modelProfiles.maxProfiles} 个配置；不同配置的 Key 独立加密保存。`;
  newModelProfileButton.disabled = modelProfiles.profiles.length >= modelProfiles.maxProfiles;
  deleteModelProfileButton.disabled = !editingModelProfileId || modelProfiles.profiles.length <= 1;
  deleteModelProfileButton.textContent = modelProfileDeleteArmed ? "确认删除" : "删除配置";
}

function applyProfileToSettingsForm(profile: ModelProfileSummary): void {
  profileNameInput.value = profile.profileName;
  apiBaseUrlInput.value = profile.apiBaseUrl;
  modelNameInput.value = profile.model;
  syncModelPreset();
  apiKeyInput.value = "";
  maxStepsInput.value = String(profile.maxSteps);
  commandTimeoutInput.value = String(Math.round(profile.commandTimeoutMs / 1000));
  permissionModeInput.value = profile.permissionMode;
  responseProfileInput.value = profile.responseProfile;
  apiKeyHelp.textContent = profile.hasApiKey
    ? `已有 Key（来源：${profile.apiKeySource === "environment" ? "环境变量" : "此配置的系统加密存储"}）`
    : "此配置尚未保存 Key；不会继承其他模型配置的 Key。";
}

function selectSettingsProfile(): void {
  const profile = modelProfiles.profiles.find(
    (item) => item.profileId === settingsProfileSelect.value,
  );
  if (!profile) {
    return;
  }
  editingModelProfileId = profile.profileId;
  modelProfileDeleteArmed = false;
  applyProfileToSettingsForm(profile);
  renderSettingsProfileSelect();
  modelDiagnostic.hidden = true;
}

function newModelProfile(): void {
  if (modelProfiles.profiles.length >= modelProfiles.maxProfiles) {
    notify(`最多保存 ${modelProfiles.maxProfiles} 个模型配置。`);
    return;
  }
  const source = currentSettings;
  editingModelProfileId = null;
  modelProfileDeleteArmed = false;
  profileNameInput.value = "新模型配置";
  apiBaseUrlInput.value = source?.apiBaseUrl ?? "https://api-inference.modelscope.cn/v1";
  modelNameInput.value = source?.model ?? "Qwen/Qwen3-Coder-30B-A3B-Instruct";
  maxStepsInput.value = String(source?.maxSteps ?? 20);
  commandTimeoutInput.value = String(Math.round((source?.commandTimeoutMs ?? 120_000) / 1000));
  permissionModeInput.value = source?.permissionMode ?? "workspace";
  responseProfileInput.value = source?.responseProfile ?? "balanced";
  apiKeyInput.value = "";
  apiKeyHelp.textContent = "新配置不会继承当前配置的 Key，请填写对应平台的 Key。";
  syncModelPreset();
  renderSettingsProfileSelect();
  modelDiagnostic.hidden = true;
  profileNameInput.focus();
  profileNameInput.select();
}

async function deleteModelProfile(): Promise<void> {
  if (!editingModelProfileId || modelProfiles.profiles.length <= 1 || runIsActive) {
    return;
  }
  if (!modelProfileDeleteArmed) {
    modelProfileDeleteArmed = true;
    renderSettingsProfileSelect();
    notify("再点一次确认删除；该配置保存的加密 Key 也会一起移除。 ");
    return;
  }
  deleteModelProfileButton.disabled = true;
  try {
    modelProfiles = await api.deleteModelProfile(editingModelProfileId);
    currentSettings = modelProfiles.profiles.find(
      (profile) => profile.profileId === modelProfiles.activeProfileId,
    ) ?? await api.getSettings();
    editingModelProfileId = modelProfiles.activeProfileId;
    modelProfileDeleteArmed = false;
    renderModelProfileSwitch();
    renderModelStatus();
    renderSettingsProfileSelect();
    const active = modelProfiles.profiles.find(
      (profile) => profile.profileId === editingModelProfileId,
    );
    if (active) {
      applyProfileToSettingsForm(active);
    }
    notify("模型配置已删除。 ");
  } catch (error) {
    modelProfileDeleteArmed = false;
    settingsError.textContent = errorMessage(error);
    renderSettingsProfileSelect();
  }
}

function selectModelPreset(): void {
  if (modelPresetInput.value !== "custom") {
    modelNameInput.value = modelPresetInput.value;
  }
  modelNameInput.focus();
}

function syncModelPreset(): void {
  const hasPreset = Array.from(modelPresetInput.options).some(
    (option) => option.value !== "custom" && option.value === modelNameInput.value.trim(),
  );
  modelPresetInput.value = hasPreset ? modelNameInput.value.trim() : "custom";
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
    modelProfiles = await api.saveModelProfile(modelProfileInputValue());
    currentSettings = modelProfiles.profiles.find(
      (profile) => profile.profileId === modelProfiles.activeProfileId,
    ) ?? await api.getSettings();
    settingsDialog.close();
    renderModelProfileSwitch();
    renderModelStatus();
    notify(`模型配置“${currentSettings.profileName}”已保存并启用。`);
  } catch (error) {
    settingsError.textContent = errorMessage(error);
  }
}

function modelProfileInputValue(): ModelProfileInput {
  return {
    id: editingModelProfileId ?? undefined,
    name: profileNameInput.value,
    apiBaseUrl: apiBaseUrlInput.value,
    model: modelNameInput.value,
    apiKey: apiKeyInput.value || undefined,
    maxSteps: Number(maxStepsInput.value),
    commandTimeoutMs: Number(commandTimeoutInput.value) * 1000,
    maxOutputChars: currentSettings?.maxOutputChars ?? 20_000,
    permissionMode: permissionModeInput.value as PublicSettings["permissionMode"],
    responseProfile: responseProfileInput.value as PublicSettings["responseProfile"],
  };
}

async function testModelConnection(): Promise<void> {
  if (!settingsForm.reportValidity()) {
    return;
  }
  settingsError.textContent = "";
  modelDiagnostic.hidden = false;
  modelDiagnostic.textContent = "正在检查文本、流式响应、Token 用量和工具调用…";
  testModelButton.disabled = true;
  testModelButton.textContent = "测试中…";
  try {
    modelProfiles = await api.saveModelProfile(modelProfileInputValue());
    editingModelProfileId = modelProfiles.activeProfileId;
    currentSettings = modelProfiles.profiles.find(
      (profile) => profile.profileId === modelProfiles.activeProfileId,
    ) ?? await api.getSettings();
    apiKeyInput.value = "";
    renderModelProfileSwitch();
    renderModelStatus();
    const result = await api.testModelConnection();
    renderModelDiagnostic(result);
    await loadModelProfiles();
    renderSettingsProfileSelect();
    notify(result.ok ? "模型已通过 Agent 能力自检。" : "连接可用，但部分 Agent 能力未通过。 ");
  } catch (error) {
    modelDiagnostic.hidden = false;
    modelDiagnostic.textContent = "";
    const failure = document.createElement("p");
    failure.className = "diagnostic-summary failed";
    failure.textContent = errorMessage(error);
    modelDiagnostic.append(failure);
  } finally {
    testModelButton.disabled = false;
    testModelButton.textContent = "保存并测试";
  }
}

function renderModelDiagnostic(result: Awaited<ReturnType<DesktopApi["testModelConnection"]>>): void {
  modelDiagnostic.hidden = false;
  modelDiagnostic.replaceChildren();
  const summary = document.createElement("p");
  summary.className = `diagnostic-summary ${result.ok ? "passed" : "failed"}`;
  summary.textContent = `${result.model} · ${result.latencyMs.toLocaleString()} ms · ${result.ok ? "适合运行 Agent" : "需要检查"}`;
  const list = document.createElement("div");
  list.className = "diagnostic-checks";
  for (const check of result.checks) {
    const item = document.createElement("div");
    item.className = `diagnostic-check ${check.status}`;
    const mark = document.createElement("span");
    mark.textContent = check.status === "passed" ? "✓" : check.status === "failed" ? "!" : "–";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = diagnosticLabel(check.id);
    const detail = document.createElement("small");
    detail.textContent = check.detail;
    copy.append(title, detail);
    item.append(mark, copy);
    list.append(item);
  }
  modelDiagnostic.append(summary, list);
}

function diagnosticLabel(id: "connection" | "text" | "streaming" | "toolCalling" | "usage"): string {
  return {
    connection: "连接与认证",
    text: "文本响应",
    streaming: "流式输出",
    toolCalling: "工具调用",
    usage: "Token 用量",
  }[id];
}

function renderModelStatus(): void {
  if (!currentSettings) {
    return;
  }
  const profile = modelProfiles.profiles.find(
    (item) => item.profileId === currentSettings?.profileId,
  );
  modelStatus.classList.toggle("ready", currentSettings.hasApiKey);
  modelStatus.classList.toggle("verified", profile?.lastDiagnostic?.ok === true);
  modelStatus.classList.toggle(
    "warning",
    Boolean(profile?.lastDiagnostic && !profile.lastDiagnostic.ok),
  );
  modelStatus.lastChild!.textContent = !currentSettings.hasApiKey
    ? " 缺少 Key"
    : profile?.lastDiagnostic?.ok
      ? " Agent 已验证"
      : profile?.lastDiagnostic
        ? " 能力需检查"
        : ` ${responseProfileLabel(currentSettings.responseProfile)} · 未测试`;
}

function responseProfileLabel(profile: PublicSettings["responseProfile"]): string {
  return profile === "fast" ? "快速" : profile === "thorough" ? "深入" : "标准";
}

function renderTokenUsage(usage: TokenUsage | null): void {
  tokenUsage.classList.toggle("active", Boolean(usage));
  tokenUsage.textContent = usage
    ? `${usage.estimated ? "≈" : ""}${formatTokenCount(usage.totalTokens)} Token`
    : "Token —";
  tokenUsage.title = usage
    ? `${usage.estimated ? "本地估算" : "接口精确值"}：输入 ${usage.promptTokens.toLocaleString("zh-CN")}，输出 ${usage.completionTokens.toLocaleString("zh-CN")}，合计 ${usage.totalTokens.toLocaleString("zh-CN")}`
    : "本次任务的模型 Token 用量";
}

function lastTokenUsage(events: readonly AgentEvent[]): TokenUsage | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "model_usage") {
      if (
        event.promptTokens === 0 &&
        event.completionTokens === 0 &&
        event.totalTokens === 0
      ) {
        continue;
      }
      return {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        estimated: event.estimated,
      };
    }
  }
  return null;
}

function tokenUsageForHistory(detail: RunHistoryDetail): TokenUsage | null {
  const reported = lastTokenUsage(detail.events);
  if (reported) {
    return reported;
  }
  if (detail.messages.length === 0) {
    return null;
  }
  const promptText = detail.messages
    .filter((message) => message.role !== "assistant")
    .map((message) => message.content)
    .join("\n");
  const completionText = detail.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content ?? "")
    .join("\n");
  const promptTokens = estimateVisibleTokens(promptText);
  const completionTokens = estimateVisibleTokens(completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function estimateVisibleTokens(text: string): number {
  let weightedCharacters = 0;
  for (const character of text) {
    if (/\s/u.test(character)) {
      continue;
    }
    weightedCharacters += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
      ? 1
      : 0.25;
  }
  return Math.max(1, Math.ceil(weightedCharacters));
}

function formatTokenCount(value: number): string {
  return value >= 1_000
    ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : value.toLocaleString("zh-CN");
}

function newConversation(): void {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  if (runIsActive) {
    notify("请先停止或等待当前任务结束。");
    return;
  }
  activeConversationRunId = null;
  continuationSource = null;
  attachmentPaths = [];
  taskInput.value = "";
  clearCurrentDraft();
  renderContinuationContext();
  renderAttachments();
  clearTimeline(true);
  resetPlanUi();
  renderTokenUsage(null);
  taskInput.focus();
  notify("已新建空白会话；原记录仍保留在历史中。");
}

async function selectAttachments(): Promise<void> {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  try {
    const selected = await api.selectAttachments();
    attachmentPaths = Array.from(
      new Set([...attachmentPaths, ...selected.map((file) => file.relativePath)]),
    ).slice(0, MAX_ATTACHMENT_FILES);
    renderAttachments();
  } catch (error) {
    notify(errorMessage(error));
  }
}

function renderAttachments(): void {
  attachmentsBadge.textContent = String(attachmentPaths.length);
  attachmentsButton.classList.toggle("active", attachmentPaths.length > 0);
  attachmentList.hidden = attachmentPaths.length === 0;
  attachmentList.replaceChildren();
  for (const relativePath of attachmentPaths) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.title = relativePath;
    const label = document.createElement("span");
    label.textContent = relativePath.split("/").pop() ?? relativePath;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除附件 ${relativePath}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      attachmentPaths = attachmentPaths.filter((pathValue) => pathValue !== relativePath);
      renderAttachments();
    });
    chip.append(label, remove);
    attachmentList.append(chip);
  }
}

function currentRunRequest(): RunRequest {
  return {
    task: taskInput.value.trim(),
    executionMode: executionModeInput.value === "plan" ? "plan" : "direct",
    selectedFile: selectedFile ?? undefined,
    attachmentPaths,
    skillIds: Array.from(selectedSkillIds),
    useMemory: memoryEnabled && Boolean(projectContext.memory.trim()),
    continueFromRunId: activeConversationRunId ?? undefined,
  };
}

async function openContextPreview(): Promise<void> {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  if (!taskInput.value.trim()) {
    notify("请先写下任务，再查看发送清单。");
    taskInput.focus();
    return;
  }
  contextPreviewContent.replaceChildren(historyLoading("正在整理本次上下文…"));
  contextPreviewDialog.showModal();
  try {
    const preview = await api.previewRunContext(currentRunRequest());
    if (!contextPreviewDialog.open) {
      return;
    }
    contextPreviewContent.replaceChildren();
    const hero = document.createElement("div");
    hero.className = "context-preview-hero";
    const token = document.createElement("strong");
    token.textContent = `≈ ${formatTokenCount(preview.estimatedInputTokens)} Token`;
    const model = document.createElement("span");
    model.textContent = `${preview.profileName} · ${preview.model} · ${preview.permissionMode === "readOnly" ? "只读" : "工作区读写"} · ${responseProfileLabel(preview.responseProfile)} · ${preview.executionMode === "plan" ? "先规划" : "直接执行"}`;
    hero.append(token, model);

    const metrics = document.createElement("div");
    metrics.className = "context-preview-metrics";
    metrics.append(
      previewMetric("历史消息", String(preview.conversationMessageCount)),
      previewMetric("Skills", String(preview.skills.length)),
      previewMetric("附件", String(preview.attachments.length)),
      previewMetric("可用工具", String(preview.toolCount)),
    );
    contextPreviewContent.append(hero, metrics);
    contextPreviewContent.append(
      previewGroup(
        "当前文件",
        preview.selectedFile ? [preview.selectedFile] : ["未选择；Agent 仍可按需读取项目文件。"],
      ),
      previewGroup(
        `Memory · ${preview.memoryChars.toLocaleString()} 字符`,
        preview.memoryChars > 0
          ? [preview.memoryPreview || "已启用", preview.memoryUpdatedAt ? `更新于 ${formatHistoryDate(preview.memoryUpdatedAt)}` : "更新时间未知"]
          : ["本次不注入 Memory。"],
      ),
      previewGroup(
        "Skills",
        preview.skills.length > 0
          ? preview.skills.map((skill) => `${skill.name} · ${skill.contentChars.toLocaleString()} 字符 · ${skill.relativePath}`)
          : ["本次未选择 Skill。"],
      ),
      previewGroup(
        "附件",
        preview.attachments.length > 0
          ? preview.attachments.map((file) => `${file.relativePath} · ${file.contentChars.toLocaleString()} 字符`)
          : ["本次没有附件。"],
      ),
    );
    if (preview.warnings.length > 0) {
      const warnings = previewGroup("注意", preview.warnings);
      warnings.classList.add("warning");
      contextPreviewContent.append(warnings);
    }
  } catch (error) {
    contextPreviewContent.replaceChildren(historyLoading(errorMessage(error)));
  }
}

function previewMetric(label: string, value: string): HTMLElement {
  const item = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  item.append(strong, span);
  return item;
}

function previewGroup(titleText: string, rows: string[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "context-preview-group";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const list = document.createElement("ul");
  for (const row of rows) {
    const item = document.createElement("li");
    item.textContent = row;
    list.append(item);
  }
  section.append(title, list);
  return section;
}

async function startRun(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!canLeaveManualEditor("启动 Agent 任务")) {
    return;
  }
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
    const result = await api.startRun({ ...currentRunRequest(), task });
    if (!result.started) {
      notify(result.message ?? "任务未能启动。");
      return;
    }
    setRunning(true);
    activeConversationRunId = result.runId ?? activeConversationRunId;
    taskInput.value = "";
    clearCurrentDraft();
    attachmentPaths = [];
    renderAttachments();
    void clearContinuation(false);
    void loadRunHistory();
  } catch (error) {
    notify(errorMessage(error));
  }
}

function scheduleDraftPersistence(): void {
  if (draftSaveTimer !== undefined) {
    window.clearTimeout(draftSaveTimer);
  }
  draftSaveTimer = window.setTimeout(() => {
    draftSaveTimer = undefined;
    persistDraftNow();
  }, 250);
}

function persistDraftNow(): void {
  if (draftSaveTimer !== undefined) {
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
  }
  if (project) {
    saveTaskDraft(window.localStorage, project.rootPath, taskInput.value);
  }
}

function clearCurrentDraft(): void {
  if (draftSaveTimer !== undefined) {
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
  }
  if (project) {
    clearTaskDraft(window.localStorage, project.rootPath);
  }
}

async function continueSelectedHistory(): Promise<void> {
  if (!selectedHistoryDetail) {
    notify("请先在左侧选择一条历史记录。");
    return;
  }
  if (runIsActive || selectedHistoryDetail.status === "running") {
    notify("请等待当前任务结束后再继续这段对话。");
    return;
  }
  continuationSource = selectedHistoryDetail;
  activeConversationRunId = selectedHistoryDetail.id;
  renderContinuationContext();
  historyDialog.close("continue");
  await showHistoryConversation(selectedHistoryDetail);
  taskInput.focus();
  notify("已切换并接续所选历史对话，请输入下一条消息。");
}

async function clearContinuation(
  focusInput: boolean,
  restoreRecentConversation = false,
): Promise<void> {
  continuationSource = null;
  renderContinuationContext();
  if (restoreRecentConversation) {
    await hydrateConversationFromHistory(true);
  }
  if (focusInput) {
    taskInput.focus();
  }
}

function renderContinuationContext(): void {
  const source = continuationSource;
  continuationContext.hidden = !source;
  continuationTitle.textContent = source?.task ?? "";
  continuationContext.title = source
    ? `将把 ${formatHistoryDate(source.createdAt)} 的对话作为模型上下文`
    : "";
  taskInput.placeholder = source
    ? "输入下一条消息，Agent 会结合所选历史对话继续处理。"
    : defaultTaskPlaceholder;
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
  if (event.type === "run_started") {
    activeRunEvents = [event];
  } else if (event.type !== "assistant_delta") {
    activeRunEvents.push(event);
  }
  switch (event.type) {
    case "run_started":
      lastAssistantMessage = "";
      resetStreamingTimeline();
      resetPlanUi();
      activeToolTimelineItems.clear();
      liveOutcomeCard = null;
      changes = [];
      reviewedChangePaths.clear();
      clearCommandOutput();
      renderChanges();
      renderTokenUsage(null);
      setRunning(true);
      appendConversationMessage("user", event.task, "你", undefined, true);
      break;
    case "model_started":
      beginStreamingTimeline(event.step);
      break;
    case "assistant_delta":
      appendStreamingText(event.step, event.text);
      break;
    case "model_usage":
      renderTokenUsage(event);
      break;
    case "assistant_message":
      lastAssistantMessage = event.text.trim();
      finishStreamingMessage(event.text);
      break;
    case "tool_started":
      if (event.name === "run_command") {
        beginCommandOutput(
          event.id,
          typeof event.arguments.command === "string" ? event.arguments.command : "本地命令",
          typeof event.arguments.reason === "string" ? event.arguments.reason : "等待执行结果",
        );
      }
      activeToolTimelineItems.set(
        event.id,
        finishStreamingToolDecision(event.name, event.arguments) ??
          appendTimeline(
            toolLabel(event.name),
            summarizeArguments(event.name, event.arguments),
            "active",
          ),
      );
      break;
    case "tool_finished": {
      if (event.name === "run_command") {
        finishCommandOutput(event.id, event.result.content, event.result.isError === true, event.durationMs);
      }
      const toolItem = activeToolTimelineItems.get(event.id);
      if (toolItem) {
        updateTimelineItem(
          toolItem,
          event.result.isError ? `${toolLabel(event.name)}失败` : `${toolLabel(event.name)}完成`,
          toolResultDetail(event.name, event.result.content, event.durationMs),
          event.result.isError ? "error" : "success",
        );
        activeToolTimelineItems.delete(event.id);
      } else {
        appendTimeline(
          event.result.isError ? `${toolLabel(event.name)}失败` : `${toolLabel(event.name)}完成`,
          toolResultDetail(event.name, event.result.content, event.durationMs),
          event.result.isError ? "error" : "success",
        );
      }
      break;
    }
    case "plan_updated":
      latestPlan = event.plan;
      renderPlan(event.plan);
      break;
    case "completion_blocked":
      appendTimeline("完成检查未通过", event.message, "active");
      break;
    case "run_completed":
      finishPendingToolItems("任务已结束，但工具未返回完整结果。", "error");
      finishPendingCommandOutputs("任务结束时没有收到完整命令结果。");
      if (lastAssistantMessage === event.summary.trim()) {
        appendTimeline("任务完成", `共执行 ${event.steps} 步，完整结果见上一条 Agent 消息。`, "success");
      } else {
        appendTimeline("任务完成", event.summary, "success", true);
      }
      lastAssistantMessage = "";
      setRunning(false);
      liveOutcomeCard = appendOutcomeCard(
        summarizeRunOutcome(activeRunEvents, changes),
        "本次任务成果",
        true,
      );
      break;
    case "run_cancelled":
      finishInterruptedStream("模型响应已停止");
      finishPendingToolItems("任务停止时工具尚未返回结果。", "error");
      finishPendingCommandOutputs("任务已停止，命令结果可能不完整。");
      appendTimeline("任务已停止", `共执行 ${event.steps} 步`, "error");
      setRunning(false);
      break;
    case "run_failed":
      finishInterruptedStream("模型响应未完成");
      finishPendingToolItems("任务异常结束，工具结果可能不完整。", "error");
      finishPendingCommandOutputs("任务异常结束，命令结果不完整。");
      if (event.reason === "max_steps") {
        const item = appendTimeline("已达到步骤上限", event.message, "active");
        appendContinueRunAction(item);
        setRunning(false);
        setRunStatus("可继续", "idle");
      } else {
        appendTimeline("任务失败", event.message, "error");
        setRunning(false, true);
      }
      break;
  }
}

function finishPendingToolItems(
  detail: string,
  state: "success" | "error",
): void {
  for (const item of activeToolTimelineItems.values()) {
    const currentTitle = item.querySelector("strong")?.textContent ?? "工具调用";
    updateTimelineItem(item, currentTitle, detail, state);
  }
  activeToolTimelineItems.clear();
}

function appendContinueRunAction(item: HTMLElement): void {
  const body = item.querySelector<HTMLElement>(".timeline-body");
  if (!body) {
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "timeline-recovery-button";
  button.textContent = "继续此任务";
  button.addEventListener("click", () => {
    taskInput.value = "继续完成刚才的任务。请结合已有上下文，先确认剩余工作，再从未完成处继续。";
    scheduleDraftPersistence();
    taskInput.focus();
    taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
    notify("已准备继续指令，确认后发送即可。");
  });
  body.append(button);
}

function appendOutcomeCard(
  outcome: RunOutcomeMetrics,
  title: string,
  interactive: boolean,
): HTMLElement {
  const shouldStick = isTimelineNearBottom();
  const card = buildOutcomeCard(outcome, title, interactive);
  timeline.append(card);
  trimTimeline();
  scrollTimelineIfNeeded(shouldStick);
  return card;
}

function buildOutcomeCard(
  outcome: RunOutcomeMetrics,
  title: string,
  interactive: boolean,
): HTMLElement {
  const card = document.createElement("section");
  card.className = "run-outcome-card";
  const header = document.createElement("header");
  const mark = document.createElement("span");
  mark.className = "run-outcome-mark";
  mark.textContent = "✓";
  const heading = document.createElement("div");
  const kicker = document.createElement("small");
  kicker.textContent = "REPOFORGE RESULT";
  const strong = document.createElement("strong");
  strong.textContent = title;
  heading.append(kicker, strong);
  header.append(mark, heading);

  const metrics = document.createElement("div");
  metrics.className = "run-outcome-metrics";
  metrics.append(
    outcomeMetric(
      "代码变更",
      `${outcome.changedFileCount} 个文件${outcome.changedFileCount > 0
        ? outcome.lineStatsEstimated && outcome.additions === 0 && outcome.deletions === 0
          ? " · 行数未记录"
          : ` · ${outcome.lineStatsEstimated ? "约 " : ""}+${outcome.additions} / -${outcome.deletions}`
        : ""}`,
      outcome.changedFileCount > 0 ? "accent" : "neutral",
    ),
    outcomeMetric(
      "验证结果",
      outcome.testCount !== undefined
        ? `${outcome.testCount} 项测试通过`
        : outcome.commandCalls > 0
          ? `${outcome.commandCalls} 条命令已执行${outcome.rejectedCommandCalls > 0 ? ` · ${outcome.rejectedCommandCalls} 条未获批准` : ""}`
          : outcome.rejectedCommandCalls > 0
            ? `${outcome.rejectedCommandCalls} 条命令未获批准`
          : "未执行命令",
      outcome.rejectedCommandCalls > 0
        ? "warning"
        : outcome.testCount !== undefined
          ? "success"
          : "neutral",
    ),
    outcomeMetric(
      "工具调用",
      `${outcome.toolCalls} 次${outcome.failedToolCalls > 0 ? ` · ${outcome.failedToolCalls} 次失败` : " · 无失败"}`,
      outcome.failedToolCalls > 0 ? "warning" : "success",
    ),
    outcomeMetric(
      "Token",
      outcome.tokenUsage
        ? `${outcome.tokenUsage.estimated ? "约 " : ""}${formatTokenCount(outcome.tokenUsage.totalTokens)}`
        : "未记录",
      "neutral",
    ),
  );
  card.append(header, metrics);

  if (interactive) {
    const actions = document.createElement("footer");
    const changesButton = document.createElement("button");
    changesButton.type = "button";
    changesButton.textContent = "查看变更";
    changesButton.disabled = changes.length === 0;
    changesButton.addEventListener("click", () => {
      const first = changes[0];
      if (first) showDiff(first);
    });
    const history = document.createElement("button");
    history.type = "button";
    history.textContent = "查看完整记录";
    history.addEventListener("click", () => void openHistory());
    const followUp = document.createElement("button");
    followUp.type = "button";
    followUp.textContent = "继续追问";
    followUp.addEventListener("click", () => {
      taskInput.value = "请基于刚才的修改和验证结果，继续完成以下调整：\n";
      scheduleDraftPersistence();
      taskInput.focus();
      taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
    });
    actions.append(changesButton, history, followUp);
    card.append(actions);
  }
  return card;
}

function outcomeMetric(
  label: string,
  value: string,
  tone: "neutral" | "accent" | "success" | "warning",
): HTMLElement {
  const item = document.createElement("div");
  item.className = `run-outcome-metric ${tone}`;
  const copy = document.createElement("span");
  copy.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  item.append(copy, strong);
  return item;
}

function refreshLiveOutcomeCard(): void {
  if (!liveOutcomeCard?.isConnected) return;
  const replacement = buildOutcomeCard(
    summarizeRunOutcome(activeRunEvents, changes),
    "本次任务成果",
    true,
  );
  liveOutcomeCard.replaceWith(replacement);
  liveOutcomeCard = replacement;
}

function beginStreamingTimeline(step: number): void {
  finishInterruptedStream("本轮响应已结束");
  streamingStep = step;
  streamingAssistantText = "";
  streamingTimelineItem = appendTimeline(
    `第 ${step} 步`,
    "模型正在生成响应…",
    "active",
  );
}

function appendStreamingText(step: number, text: string): void {
  if (!text) {
    return;
  }
  if (!streamingTimelineItem || streamingStep !== step) {
    beginStreamingTimeline(step);
  }
  streamingAssistantText += text;
  if (streamingAnimationFrame === undefined) {
    streamingAnimationFrame = window.requestAnimationFrame(() => {
      streamingAnimationFrame = undefined;
      renderStreamingText();
    });
  }
}

function renderStreamingText(): void {
  if (!streamingTimelineItem || !streamingAssistantText) {
    return;
  }
  updateConversationItem(
    streamingTimelineItem,
    "assistant",
    streamingAssistantText,
    AGENT_DISPLAY_NAME,
    `第 ${streamingStep} 步 · 正在生成`,
    true,
  );
}

function finishStreamingMessage(text: string): void {
  cancelStreamingFrame();
  if (streamingTimelineItem) {
    updateConversationItem(streamingTimelineItem, "assistant", text, AGENT_DISPLAY_NAME);
  } else {
    appendConversationMessage("assistant", text, AGENT_DISPLAY_NAME);
  }
  resetStreamingTimeline();
}

function finishStreamingToolDecision(
  toolName: string,
  argumentsValue: Record<string, unknown>,
): HTMLElement | null {
  if (!streamingTimelineItem) {
    return null;
  }
  cancelStreamingFrame();
  const item = streamingTimelineItem;
  if (streamingAssistantText) {
    updateConversationItem(
      item,
      "assistant",
      streamingAssistantText,
      AGENT_DISPLAY_NAME,
    );
    resetStreamingTimeline();
    return null;
  } else {
    updateTimelineItem(
      item,
      toolLabel(toolName),
      summarizeArguments(toolName, argumentsValue),
      "active",
    );
  }
  resetStreamingTimeline();
  return item;
}

function finishInterruptedStream(label: string): void {
  if (!streamingTimelineItem) {
    return;
  }
  cancelStreamingFrame();
  if (streamingAssistantText) {
    updateConversationItem(
      streamingTimelineItem,
      "assistant",
      streamingAssistantText,
      AGENT_DISPLAY_NAME,
      label,
      false,
      true,
    );
  } else {
    updateTimelineItem(
      streamingTimelineItem,
      `第 ${streamingStep} 步`,
      label,
      "error",
    );
  }
  resetStreamingTimeline();
}

function cancelStreamingFrame(): void {
  if (streamingAnimationFrame !== undefined) {
    window.cancelAnimationFrame(streamingAnimationFrame);
    streamingAnimationFrame = undefined;
  }
}

function resetStreamingTimeline(): void {
  cancelStreamingFrame();
  streamingAssistantText = "";
  streamingStep = 0;
  streamingTimelineItem = null;
}

function beginCommandOutput(id: string, command: string, reason: string): void {
  commandOutputEntries.push({ id, command, reason, state: "running", expanded: true });
  while (commandOutputEntries.length > MAX_COMMAND_OUTPUT_ENTRIES) commandOutputEntries.shift();
  renderCommandOutput();
}

function finishCommandOutput(id: string, raw: string, isError: boolean, durationMs: number): void {
  let entry = commandOutputEntries.find((item) => item.id === id);
  if (!entry) {
    entry = { id, command: "本地命令", reason: "命令执行结果", state: "running", expanded: true };
    commandOutputEntries.push(entry);
  }
  const evidence = parseCommandEvidence(raw, entry.command, isError, durationMs);
  entry.command = evidence.command || entry.command;
  entry.evidence = evidence;
  entry.state = evidence.state;
  entry.expanded = evidence.state !== "success";
  renderCommandOutput();
}

function finishPendingCommandOutputs(message: string): void {
  for (const entry of commandOutputEntries.filter((item) => item.state === "running")) {
    const evidence = parseCommandEvidence(
      JSON.stringify({ command: entry.command, stderr: message }),
      entry.command,
      true,
      0,
    );
    entry.evidence = evidence;
    entry.state = "error";
    entry.expanded = true;
  }
  renderCommandOutput();
}

function appendTimeline(
  title: string,
  detail: string,
  state: "active" | "success" | "error",
  rich = false,
): HTMLElement {
  const shouldStick = isTimelineNearBottom();
  document.getElementById("timeline-empty")?.remove();
  const item = document.createElement("article");
  const dot = document.createElement("span");
  dot.className = "timeline-dot";
  const body = document.createElement("div");
  body.className = "timeline-body";
  item.append(dot, body);
  updateTimelineItem(item, title, detail, state, rich);
  timeline.append(item);
  trimTimeline();
  scrollTimelineIfNeeded(shouldStick);
  return item;
}

function updateTimelineItem(
  item: HTMLElement,
  title: string,
  detail: string,
  state: "active" | "success" | "error",
  rich = false,
  streaming = false,
): void {
  const shouldStick = item.isConnected && isTimelineNearBottom();
  item.className = `timeline-item ${state}${streaming ? " streaming" : ""}`;
  const dot = item.querySelector<HTMLElement>(".timeline-dot");
  const body = item.querySelector<HTMLElement>(".timeline-body");
  if (!dot || !body) {
    return;
  }
  dot.textContent = state === "success" ? "✓" : state === "error" ? "!" : "·";
  const heading = document.createElement("strong");
  heading.textContent = title;
  if (rich) {
    body.replaceChildren(heading, renderRichText(detail));
  } else {
    const copy = document.createElement(detail.includes("\n") ? "pre" : "p");
    if (streaming) {
      copy.className = "streaming-copy";
    }
    copy.textContent = detail;
    body.replaceChildren(heading, copy);
  }
  scrollTimelineIfNeeded(shouldStick);
}

function appendConversationMessage(
  role: "user" | "assistant",
  text: string,
  title: string,
  meta?: string,
  forceScroll = false,
): HTMLElement {
  const shouldStick = isTimelineNearBottom();
  document.getElementById("timeline-empty")?.remove();
  const item = document.createElement("article");
  updateConversationItem(item, role, text, title, meta);
  timeline.append(item);
  trimTimeline();
  scrollTimelineIfNeeded(shouldStick || forceScroll);
  return item;
}

function updateConversationItem(
  item: HTMLElement,
  role: "user" | "assistant",
  text: string,
  title: string,
  meta?: string,
  streaming = false,
  interrupted = false,
): void {
  const shouldStick = item.isConnected && isTimelineNearBottom();
  item.className = `chat-message ${role}${streaming ? " streaming" : ""}${interrupted ? " interrupted" : ""}`;
  const header = document.createElement("header");
  const heading = document.createElement("strong");
  heading.textContent = title;
  header.append(heading);
  if (meta) {
    const detail = document.createElement("small");
    detail.textContent = meta;
    header.append(detail);
  }
  const content = document.createElement("div");
  content.className = "chat-message-content";
  if (role === "assistant" && !streaming && !interrupted) {
    content.append(renderRichText(text));
  } else {
    const copy = document.createElement(text.includes("\n") ? "pre" : "p");
    if (streaming) {
      copy.className = "streaming-copy";
    }
    copy.textContent = text;
    content.append(copy);
  }
  item.replaceChildren(header, content);
  scrollTimelineIfNeeded(shouldStick);
}

function isTimelineNearBottom(): boolean {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 90;
}

function scrollTimelineIfNeeded(shouldScroll: boolean): void {
  if (shouldScroll) {
    timeline.scrollTop = timeline.scrollHeight;
  }
}

function trimTimeline(): void {
  while (timeline.childElementCount > MAX_TIMELINE_ITEMS) {
    timeline.firstElementChild?.remove();
  }
}

function clearTimeline(showEmpty = false): void {
  lastAssistantMessage = "";
  resetStreamingTimeline();
  timeline.replaceChildren();
  if (showEmpty) {
    const empty = document.createElement("div");
    empty.id = "timeline-empty";
    empty.className = "timeline-empty";
    const title = document.createElement("strong");
    title.textContent = "在这里开始连续对话";
    const copy = document.createElement("p");
    copy.textContent = "你的问题、Agent 回复、工具调用和运行结果都会按顺序保留。";
    empty.append(title, copy);
    timeline.append(empty);
  }
}

function renderRichText(value: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "rich-text";
  for (const block of parseSafeMarkdown(value)) {
    if (block.kind === "code") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (block.language) {
        code.dataset.language = block.language;
      }
      code.textContent = block.value;
      pre.append(code);
      root.append(pre);
      continue;
    }
    if (block.kind === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const entry = document.createElement("li");
        appendInline(entry, item);
        list.append(entry);
      }
      root.append(list);
      continue;
    }
    const tag =
      block.kind === "heading"
        ? block.level <= 2
          ? "h4"
          : "h5"
        : block.kind === "quote"
          ? "blockquote"
          : "p";
    const element = document.createElement(tag);
    appendInline(element, block.content);
    root.append(element);
  }
  return root;
}

function appendInline(parent: HTMLElement, tokens: InlineToken[]): void {
  for (const token of tokens) {
    if (token.kind === "text") {
      parent.append(document.createTextNode(token.value));
      continue;
    }
    const element = document.createElement(token.kind === "strong" ? "strong" : "code");
    element.textContent = token.value;
    parent.append(element);
  }
}

function clearCommandOutput(): void {
  commandOutputEntries.splice(0, commandOutputEntries.length);
  renderCommandOutput();
}

function renderCommandOutput(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-output-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.outputFilter === outputFilter);
  });

  const completed = commandOutputEntries.filter((entry) => entry.state !== "running");
  const failures = completed.filter((entry) => entry.state === "error" || entry.state === "rejected").length;
  const running = commandOutputEntries.filter((entry) => entry.state === "running").length;
  outputSummary.textContent = running > 0
    ? `${running} 条执行中 · 共 ${commandOutputEntries.length} 条`
    : commandOutputEntries.length > 0
      ? `${commandOutputEntries.length} 条命令${failures > 0 ? ` · ${failures} 个问题` : " · 全部完成"}`
      : "等待命令";

  renderValidationProgress();
  outputLog.replaceChildren();
  const visible = commandOutputEntries.filter((entry) => {
    if (outputFilter === "error") return entry.state === "error" || entry.state === "rejected";
    if (outputFilter === "test") return Boolean(entry.evidence?.test) || looksLikeTestCommand(entry.command);
    return true;
  });

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "output-empty";
    const mark = document.createElement("span");
    mark.className = "output-empty-mark";
    mark.textContent = outputFilter === "all" ? ">_" : "◇";
    const copy = document.createElement("p");
    copy.textContent = commandOutputEntries.length === 0
      ? "命令输出会按执行次数整理；文件工具仍在右侧过程区展示。"
      : outputFilter === "error"
        ? "当前没有失败或被拒绝的命令。"
        : "当前没有识别到测试命令。";
    empty.append(mark, copy);
    outputLog.append(empty);
    return;
  }

  for (const entry of visible) outputLog.append(commandOutputCard(entry));
  if (outputAutoFollow) {
    window.requestAnimationFrame(() => {
      outputLog.scrollTop = outputLog.scrollHeight;
    });
  }
}

function commandOutputCard(entry: CommandOutputEntry): HTMLElement {
  const card = document.createElement("article");
  card.className = `command-card ${entry.state}${entry.expanded ? " expanded" : ""}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "command-card-toggle";
  toggle.setAttribute("aria-expanded", String(entry.expanded));

  const stateMark = document.createElement("span");
  stateMark.className = "command-state-mark";
  stateMark.textContent = entry.state === "running"
    ? "·"
    : entry.state === "success"
      ? "✓"
      : "!";

  const copy = document.createElement("span");
  copy.className = "command-card-copy";
  const command = document.createElement("code");
  command.textContent = entry.command;
  const reason = document.createElement("small");
  reason.textContent = entry.reason;
  copy.append(command, reason);

  const meta = document.createElement("span");
  meta.className = "command-card-meta";
  if (entry.evidence?.test) {
    const test = document.createElement("span");
    test.className = `command-test-chip${entry.evidence.test.failed > 0 ? " failed" : ""}`;
    test.textContent = `${entry.evidence.test.passed}/${entry.evidence.test.total} 通过`;
    meta.append(test);
  }
  const duration = document.createElement("span");
  duration.textContent = entry.state === "running"
    ? "执行中"
    : entry.state === "rejected"
      ? "未执行"
      : formatDuration(entry.evidence?.executionDurationMs ?? 0);
  const caret = document.createElement("span");
  caret.className = "command-card-caret";
  caret.textContent = "⌄";
  meta.append(duration, caret);
  toggle.append(stateMark, copy, meta);

  const details = document.createElement("div");
  details.className = "command-card-details";
  details.hidden = !entry.expanded;
  if (entry.state === "running") {
    const pending = document.createElement("p");
    pending.className = "command-pending-copy";
    pending.textContent = "等待批准或执行结果…";
    details.append(pending);
  } else {
    const evidence = entry.evidence;
    if (evidence?.stdout) details.append(commandOutputBlock("标准输出", evidence.stdout, "stdout"));
    if (evidence?.stderr) details.append(commandOutputBlock("错误输出", evidence.stderr, "stderr"));
    if (!evidence?.stdout && !evidence?.stderr) {
      const noOutput = document.createElement("p");
      noOutput.className = "command-pending-copy";
      noOutput.textContent = entry.state === "rejected" ? "用户拒绝了这条命令，没有产生运行输出。" : "命令没有产生文本输出。";
      details.append(noOutput);
    }
    if (evidence) {
      const footer = document.createElement("footer");
      footer.className = "command-card-footer";
      footer.append(
        commandFact(evidence.timedOut ? "执行超时" : evidence.exitCode === undefined ? "无退出码" : `退出码 ${evidence.exitCode}`),
        commandFact(`执行 ${formatDuration(evidence.executionDurationMs)}`),
      );
      if (evidence.approvalDurationMs >= 500) footer.append(commandFact(`等待批准 ${formatDuration(evidence.approvalDurationMs)}`));
      if (evidence.outputTruncated) footer.append(commandFact("输出已截断"));
      details.append(footer);
    }
  }

  toggle.addEventListener("click", () => {
    entry.expanded = !entry.expanded;
    details.hidden = !entry.expanded;
    card.classList.toggle("expanded", entry.expanded);
    toggle.setAttribute("aria-expanded", String(entry.expanded));
  });
  card.append(toggle, details);
  return card;
}

function commandOutputBlock(label: string, value: string, tone: "stdout" | "stderr"): HTMLElement {
  const block = document.createElement("section");
  block.className = `command-output-block ${tone}`;
  const heading = document.createElement("span");
  heading.textContent = label;
  const content = document.createElement("pre");
  content.textContent = value;
  block.append(heading, content);
  return block;
}

function commandFact(value: string): HTMLElement {
  const fact = document.createElement("span");
  fact.textContent = value;
  return fact;
}

function renderValidationProgress(): void {
  const tests = commandOutputEntries
    .map((entry) => entry.evidence?.test)
    .filter((test): test is TestEvidence => Boolean(test));
  validationProgress.replaceChildren();
  validationProgress.hidden = tests.length === 0;
  if (tests.length === 0) return;

  const first = tests[0]!;
  const latest = tests.at(-1)!;
  const header = document.createElement("header");
  const label = document.createElement("span");
  label.textContent = "验证进展";
  const strong = document.createElement("strong");
  strong.textContent = tests.length > 1
    ? `${first.passed}/${first.total} → ${latest.passed}/${latest.total} 通过`
    : `${latest.passed}/${latest.total} 项通过`;
  const status = document.createElement("span");
  status.className = `validation-status${latest.failed === 0 && latest.total > 0 ? " success" : ""}`;
  status.textContent = latest.failed === 0 && latest.total > 0 ? "验证通过" : `${latest.failed} 项失败`;
  header.append(label, strong, status);

  const rows = document.createElement("div");
  rows.className = "validation-rows";
  if (tests.length > 1) rows.append(validationRow("首次", first));
  rows.append(validationRow(tests.length > 1 ? "最终" : "当前", latest));
  validationProgress.append(header, rows);
}

function validationRow(label: string, test: TestEvidence): HTMLElement {
  const row = document.createElement("div");
  row.className = "validation-row";
  const name = document.createElement("span");
  name.textContent = label;
  const track = document.createElement("span");
  track.className = "validation-track";
  const fill = document.createElement("span");
  fill.className = `validation-fill${test.failed === 0 && test.total > 0 ? " success" : ""}`;
  fill.style.width = `${testEvidenceProgress(test)}%`;
  track.append(fill);
  const value = document.createElement("span");
  value.textContent = `${test.passed}/${test.total}`;
  row.append(name, track, value);
  return row;
}

function looksLikeTestCommand(command: string): boolean {
  return /(?:^|\s)(?:pnpm\s+test|npm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|$)/i.test(command);
}

function setRunning(isRunning: boolean, failed = false): void {
  runIsActive = isRunning;
  stopRunButton.disabled = !isRunning;
  startRunButton.disabled = isRunning;
  openProjectButton.disabled = isRunning;
  settingsButton.disabled = isRunning;
  modelProfileSwitch.disabled = isRunning || modelProfiles.profiles.length === 0;
  skillsButton.disabled = isRunning || !project;
  memoryButton.disabled = isRunning || !project;
  attachmentsButton.disabled = isRunning || !project;
  contextPreviewButton.disabled = isRunning || !project;
  executionModeInput.disabled = isRunning;
  newConversationButton.disabled = isRunning || !project;
  historyButton.disabled = !project;
  newFileButton.disabled = isRunning || !project || Boolean(manualEditor);
  if (!isRunning) {
    activeApproval = null;
    approvalPanel.hidden = true;
    activePlanApproval = null;
    planApprovalPanel.hidden = true;
    if (latestPlan) {
      renderPlan(latestPlan);
    }
  }
  renderContinueHistoryButton();
  renderRestoreActions();
  renderManualEditorActions();
  setRunStatus(isRunning ? "运行中" : failed ? "出错" : "待命", isRunning ? "running" : failed ? "error" : "idle");
}

function setRunStatus(label: string, state: "running" | "error" | "idle"): void {
  runStatus.className = `run-status ${state}`;
  const dot = document.createElement("span");
  runStatus.replaceChildren(dot, document.createTextNode(` ${label}`));
}

function showApproval(request: CommandApprovalRequest): void {
  activeApproval = request;
  approvalReason.textContent = request.reason;
  approvalCommand.textContent = request.command;
  approvalCwd.textContent = `运行目录：${displayLocalPath(request.cwd)}`;
  appendTimeline("等待命令批准", request.command, "active");
  planPanel.hidden = true;
  approvalPanel.hidden = false;
  approvalPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function answerApproval(event: MouseEvent, approved: boolean): Promise<void> {
  event.preventDefault();
  if (!activeApproval) {
    approvalPanel.hidden = true;
    return;
  }
  const request = activeApproval;
  activeApproval = null;
  approvalPanel.hidden = true;
  await api.answerApproval(request.id, approved);
  appendTimeline(approved ? "命令已允许" : "命令已拒绝", request.command, approved ? "success" : "error");
  if (latestPlan) {
    renderPlan(latestPlan);
  }
}

function showPlanApproval(request: PlanApprovalRequest): void {
  activePlanApproval = request;
  planPanel.hidden = true;
  planDraftItems = request.items.map((item) => ({ id: item.id, title: item.title }));
  planApprovalTitle.textContent = request.reason === "revision"
    ? `确认修订后的计划 · 第 ${request.revision} 版`
    : "确认 Agent 的执行范围";
  planApprovalExplanation.textContent = request.explanation;
  renderPlanEditor();
  appendTimeline(
    request.reason === "revision" ? "等待计划变更确认" : "等待计划确认",
    `${request.items.length} 个步骤；确认前不会写文件或运行命令。`,
    "active",
  );
  planApprovalPanel.hidden = false;
  planApprovalPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderPlanEditor(): void {
  planEditorList.replaceChildren();
  planDraftItems.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "plan-editor-row";
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 160;
    input.value = item.title;
    input.setAttribute("aria-label", `计划步骤 ${index + 1}`);
    input.addEventListener("input", () => {
      const current = planDraftItems[index];
      if (current) current.title = input.value;
    });
    const actions = document.createElement("div");
    actions.className = "plan-editor-actions";
    const up = planEditorButton("↑", "上移", index === 0, () => movePlanStep(index, -1));
    const down = planEditorButton(
      "↓",
      "下移",
      index === planDraftItems.length - 1,
      () => movePlanStep(index, 1),
    );
    const remove = planEditorButton("×", "删除", planDraftItems.length === 1, () => {
      planDraftItems.splice(index, 1);
      renderPlanEditor();
    });
    actions.append(up, down, remove);
    row.append(number, input, actions);
    planEditorList.append(row);
  });
  addPlanStepButton.disabled = planDraftItems.length >= 12;
}

function planEditorButton(
  text: string,
  label: string,
  disabled: boolean,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function movePlanStep(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= planDraftItems.length) return;
  const [item] = planDraftItems.splice(index, 1);
  if (item) planDraftItems.splice(target, 0, item);
  renderPlanEditor();
}

function addPlanStep(): void {
  if (planDraftItems.length >= 12) {
    notify("计划最多包含 12 个步骤。");
    return;
  }
  planDraftItems.push({ title: "" });
  renderPlanEditor();
  planEditorList.querySelector<HTMLInputElement>(".plan-editor-row:last-child input")?.focus();
}

async function answerPlanApproval(approved: boolean): Promise<void> {
  if (!activePlanApproval) {
    planApprovalPanel.hidden = true;
    return;
  }
  const items = planDraftItems
    .map((item) => ({ id: item.id, title: item.title.trim() }))
    .filter((item) => item.title);
  if (approved && items.length !== planDraftItems.length) {
    notify("请填写所有计划步骤，或删除空白步骤。");
    return;
  }
  const request = activePlanApproval;
  approvePlanButton.disabled = true;
  rejectPlanButton.disabled = true;
  try {
    const accepted = await api.answerPlanApproval(request.id, { approved, items });
    if (!accepted) {
      notify("该计划确认已经失效。");
      return;
    }
    activePlanApproval = null;
    planApprovalPanel.hidden = true;
    if (latestPlan) {
      renderPlan(latestPlan);
    }
    appendTimeline(
      approved ? "计划已确认" : "计划已退回",
      approved ? `将按你确认的 ${items.length} 个步骤执行。` : "Agent 会收到拒绝结果。",
      approved ? "success" : "error",
    );
  } catch (error) {
    notify(errorMessage(error));
  } finally {
    approvePlanButton.disabled = false;
    rejectPlanButton.disabled = false;
  }
}

function renderPlan(plan: PlanSnapshot): void {
  planPanel.hidden = Boolean(activePlanApproval);
  if (plan !== lastRenderedPlan && plan.state === "completed") {
    setPlanCollapsed(true);
  }
  lastRenderedPlan = plan;
  planTitle.textContent = planStateLabel(plan.state);
  const finished = plan.items.filter(
    (item) => item.status === "completed" || item.status === "skipped",
  ).length;
  planProgress.textContent = `${finished} / ${plan.items.length}`;
  planList.replaceChildren();
  for (const item of plan.items) {
    const row = document.createElement("li");
    row.className = item.status;
    row.textContent = item.title;
    planList.append(row);
  }
  planEvidence.replaceChildren();
  const evidenceRows = [
    ...plan.verification.map((item) => `已核验 · ${item}`),
    ...plan.remaining.map((item) => `未完成 · ${item}`),
  ];
  planEvidence.hidden = evidenceRows.length === 0;
  if (evidenceRows.length > 0) {
    for (const row of evidenceRows) {
      const line = document.createElement("div");
      line.textContent = row;
      planEvidence.append(line);
    }
  }
}

function setPlanCollapsed(collapsed: boolean): void {
  planCollapsed = collapsed;
  planPanel.classList.toggle("collapsed", collapsed);
  planToggleButton.textContent = collapsed ? "展开" : "收起";
  planToggleButton.title = collapsed ? "展开执行计划" : "收起执行计划";
  planToggleButton.setAttribute("aria-expanded", String(!collapsed));
}

function resetPlanUi(): void {
  latestPlan = null;
  lastRenderedPlan = null;
  setPlanCollapsed(false);
  activePlanApproval = null;
  planDraftItems = [];
  planPanel.hidden = true;
  planApprovalPanel.hidden = true;
  planList.replaceChildren();
  planEvidence.replaceChildren();
}

function planStateLabel(state: PlanSnapshot["state"]): string {
  return {
    awaiting_approval: "等待确认",
    active: "正在执行",
    ready_to_finish: "等待完成核验",
    completed: "计划已完成",
    rejected: "计划未获批准",
  }[state];
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_files: "查看项目结构",
    search_text: "搜索代码",
    read_file: "读取文件",
    replace_in_file: "修改文件",
    edit_file_lines: "按行修改文件",
    write_file: "写入文件",
    run_command: "运行命令",
    propose_plan: "提交执行计划",
    update_plan: "更新计划进度",
    finish_task: "完成核验",
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
  if (name === "propose_plan" && Array.isArray(args.steps)) {
    return `${args.steps.length} 个步骤`;
  }
  if (name === "update_plan" && Array.isArray(args.items)) {
    return `${args.items.length} 个步骤`;
  }
  if (name === "finish_task" && Array.isArray(args.verification)) {
    return `${args.verification.length} 项核验证据`;
  }
  return Object.keys(args).length ? JSON.stringify(args) : "准备执行";
}

function toolResultDetail(name: string, raw: string, durationMs: number): string {
  if (name !== "run_command") {
    return `${durationMs} ms`;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) {
      return `${durationMs} ms`;
    }
    if (value.approved === false) {
      const approvalDuration = numericDuration(value.approvalDurationMs);
      return approvalDuration === null
        ? `用户已拒绝 · ${durationMs} ms`
        : `用户已拒绝 · 等待 ${formatDuration(approvalDuration)}`;
    }
    const parts: string[] = [];
    if (value.timedOut === true) {
      parts.push("执行超时");
    } else if (typeof value.exitCode === "number") {
      parts.push(`退出码 ${value.exitCode}`);
    }
    if (value.outputTruncated === true) {
      parts.push("输出已截断");
    }
    const executionDuration = numericDuration(value.executionDurationMs);
    const approvalDuration = numericDuration(value.approvalDurationMs);
    parts.push(
      executionDuration === null
        ? `${durationMs} ms`
        : `执行 ${formatDuration(executionDuration)}`,
    );
    if (approvalDuration !== null && approvalDuration >= 500) {
      parts.push(`批准等待 ${formatDuration(approvalDuration)}`);
    }
    return parts.join(" · ");
  } catch {
    return `${durationMs} ms`;
  }
}

function numericDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
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
      renderHistoryList(selectedHistoryId ?? undefined);
    }
    if (showMessage) {
      notify(`已读取 ${runHistory.length} 条任务历史。`);
    }
  } catch (error) {
    notify(errorMessage(error));
  }
}

async function hydrateConversationFromHistory(force = false): Promise<void> {
  if (!project || (conversationHydrated && !force)) {
    return;
  }
  conversationHydrated = true;
  const rootPath = project.rootPath;
  const latestRun = runHistory.find((run) => run.status !== "running");
  if (!latestRun) {
    activeConversationRunId = null;
    clearTimeline(true);
    return;
  }
  try {
    const detail = await api.getRunHistory(latestRun.id);
    if (!project || project.rootPath !== rootPath) {
      return;
    }
    activeConversationRunId = detail.id;
    continuationSource = null;
    renderContinuationContext();
    await showHistoryConversation(detail);
  } catch (error) {
    conversationHydrated = false;
    notify(`会话记录读取失败：${errorMessage(error)}`);
  }
}

async function showHistoryConversation(source: RunHistoryDetail): Promise<void> {
  if (!project) {
    return;
  }
  const rootPath = project.rootPath;
  const sourceId = source.id;
  const chain: RunHistoryDetail[] = [source];
  const seen = new Set<string>([source.id]);
  let parentId = source.continuedFromRunId;

  clearTimeline();
  appendTimeline("正在切换历史对话", source.task, "active");
  while (parentId && chain.length < MAX_CONVERSATION_HISTORY_RUNS && !seen.has(parentId)) {
    seen.add(parentId);
    try {
      const parent = await api.getRunHistory(parentId);
      chain.unshift(parent);
      parentId = parent.continuedFromRunId;
    } catch {
      break;
    }
  }
  if (
    !project ||
    project.rootPath !== rootPath ||
    activeConversationRunId !== sourceId
  ) {
    return;
  }
  clearTimeline();
  for (const detail of chain) {
    appendHistoryRunToTimeline(detail);
  }
  if (source.plan) {
    latestPlan = source.plan;
    renderPlan(source.plan);
  } else {
    resetPlanUi();
  }
  renderTokenUsage(tokenUsageForHistory(source));
  timeline.scrollTop = timeline.scrollHeight;
}

function appendHistoryRunToTimeline(detail: RunHistoryDetail): void {
  const context = [
    formatHistoryDate(detail.createdAt),
    detail.memoryUsed ? "Memory" : "",
    detail.skillIds.length > 0 ? `${detail.skillIds.length} 个 Skill` : "",
    detail.attachmentPaths.length > 0 ? `${detail.attachmentPaths.length} 个附件` : "",
    detail.continuedFromRunId ? "接续" : "",
  ].filter(Boolean).join(" · ");
  appendConversationMessage("user", detail.task, "你", context);

  const assistantMessages = detail.messages
    .filter(
      (message): message is Extract<(typeof detail.messages)[number], { role: "assistant" }> =>
        message.role === "assistant" && Boolean(message.content?.trim()),
    )
    .map((message) => message.content?.trim() ?? "")
    .filter((text, index, values) => text && text !== values[index - 1]);
  for (const message of assistantMessages) {
    appendConversationMessage("assistant", message, AGENT_DISPLAY_NAME);
  }

  if (detail.status === "completed") {
    const summary = detail.summary.trim();
    if (summary && assistantMessages.at(-1) !== summary) {
      appendConversationMessage("assistant", summary, AGENT_DISPLAY_NAME);
    }
  } else {
    appendTimeline(
      historyStatusLabel(detail.status),
      detail.summary,
      detail.status === "cancelled" ? "active" : "error",
    );
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
  selectedHistoryId = null;
  selectedHistoryDetail = null;
  conversationDeleteArmed = false;
  renderContinueHistoryButton();
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
    meta.textContent = `${run.steps} 步 · ${run.changedFiles.length} 个改动文件${run.attachmentPaths.length > 0 ? ` · ${run.attachmentPaths.length} 附件` : ""}${run.continuedFromRunId ? " · 接续" : ""}`;
    button.append(row, task, meta);
    button.addEventListener("click", () => void showHistoryDetail(run.id));
    button.addEventListener("dblclick", () => {
      if (selectedHistoryDetail?.id === run.id) {
        void continueSelectedHistory();
      }
    });
    historyList.append(button);
  }
}

async function showHistoryDetail(id: string): Promise<void> {
  if (selectedHistoryId !== id) {
    conversationDeleteArmed = false;
  }
  selectedHistoryId = id;
  selectedHistoryDetail = null;
  renderContinueHistoryButton();
  renderHistoryList(id);
  historyDetail.replaceChildren(historyLoading("正在读取任务详情…"));
  try {
    const detail = await api.getRunHistory(id);
    if (selectedHistoryId !== id) {
      return;
    }
    selectedHistoryDetail = detail;
    renderContinueHistoryButton();
    renderHistoryDetail(detail);
  } catch (error) {
    if (selectedHistoryId !== id) {
      return;
    }
    historyDetail.replaceChildren(historyLoading(errorMessage(error)));
  }
}

function renderHistoryDetail(detail: RunHistoryDetail): void {
  stopHistoryReplay();
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
  const replayButton = document.createElement("button");
  replayButton.type = "button";
  replayButton.className = "history-replay-button";
  replayButton.textContent = "回放过程";
  replayButton.disabled = detail.events.length === 0;
  heading.append(headingCopy, replayButton);

  const summary = document.createElement("section");
  summary.className = "history-summary";
  const summaryTitle = document.createElement("strong");
  summaryTitle.textContent = "执行结果";
  const summaryCopy = renderRichText(detail.summary);
  summary.append(summaryTitle, summaryCopy);

  const context = document.createElement("div");
  context.className = "history-context";
  if (detail.selectedFile) {
    context.append(historyChip(`文件 · ${detail.selectedFile}`));
  }
  if (detail.model) {
    context.append(historyChip(`模型 · ${detail.modelProfileName ?? detail.model}`));
  }
  if (detail.permissionMode) {
    context.append(historyChip(
      detail.permissionMode === "readOnly" ? "只读权限" : "工作区读写",
    ));
  }
  if (detail.responseProfile) {
    context.append(historyChip(`响应 · ${responseProfileLabel(detail.responseProfile)}`));
  }
  context.append(historyChip(detail.executionMode === "plan" ? "先规划" : "直接执行"));
  if (detail.skillIds.length > 0) {
    context.append(historyChip(`${detail.skillIds.length} 个 Skill`));
  }
  if (detail.memoryUsed) {
    context.append(historyChip("已使用 Memory"));
  }
  if (detail.attachmentPaths.length > 0) {
    context.append(historyChip(`${detail.attachmentPaths.length} 个附件`));
  }
  if (detail.continuedFromRunId) {
    context.append(historyChip("接续历史对话"));
  }
  if (detail.changedFiles.length > 0) {
    context.append(historyChip(`${detail.changedFiles.length} 个改动文件`));
  }
  const usage = tokenUsageForHistory(detail);
  if (usage) {
    context.append(historyChip(`${usage.estimated ? "约 " : ""}${formatTokenCount(usage.totalTokens)} Token`));
  }

  const events = document.createElement("section");
  events.className = "history-events";
  const eventsHeader = document.createElement("div");
  eventsHeader.className = "history-events-header";
  const eventsTitle = document.createElement("strong");
  eventsTitle.textContent = "执行过程";
  const replayProgress = document.createElement("span");
  replayProgress.textContent = "本地记录 · 不重新执行";
  eventsHeader.append(eventsTitle, replayProgress);
  events.append(eventsHeader);
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
  replayButton.addEventListener("click", () => {
    if (historyReplayRunning) {
      stopHistoryReplay();
      replayButton.textContent = "重新回放";
      replayProgress.textContent = "已停止 · 全部记录可见";
      return;
    }
    startHistoryReplay(eventList, replayButton, replayProgress);
  });
  const plan = renderHistoryPlan(detail.plan);
  const outcome = buildOutcomeCard(
    historyOutcome(detail),
    "任务成果概览",
    false,
  );

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

  historyDetail.append(heading, outcome, summary);
  if (context.childElementCount > 0) {
    historyDetail.append(context);
  }
  if (plan) {
    historyDetail.append(plan);
  }
  historyDetail.append(events, files);
}

function fallbackHistoryOutcome(detail: RunHistoryDetail): RunOutcomeMetrics {
  const outcome = summarizeRunOutcome(detail.events, []);
  return {
    ...outcome,
    changedFileCount: detail.changedFiles.length,
    lineStatsEstimated: detail.changedFiles.length > 0,
  };
}

function historyOutcome(detail: RunHistoryDetail): RunOutcomeMetrics {
  const fallback = fallbackHistoryOutcome(detail);
  if (!detail.outcome) {
    return fallback;
  }
  const hasCommandEvidence = detail.events.some(
    (event) => event.type === "tool_finished" && event.name === "run_command",
  );
  return hasCommandEvidence
    ? {
        ...detail.outcome,
        commandCalls: fallback.commandCalls,
        rejectedCommandCalls: fallback.rejectedCommandCalls,
      }
    : {
        ...detail.outcome,
        rejectedCommandCalls: detail.outcome.rejectedCommandCalls ?? 0,
      };
}

function startHistoryReplay(
  eventList: HTMLElement,
  button: HTMLButtonElement,
  progress: HTMLElement,
): void {
  stopHistoryReplay();
  const items = Array.from(eventList.querySelectorAll<HTMLElement>(".history-event"));
  if (items.length === 0) return;
  historyReplayRunning = true;
  items.forEach((item) => item.classList.add("replay-pending"));
  button.textContent = "停止回放";
  let index = 0;
  const delay = replayFrameDelay(items.length);
  const showNext = (): void => {
    if (!historyReplayRunning) return;
    const previous = items[index - 1];
    previous?.classList.remove("replay-current");
    const current = items[index];
    if (!current) {
      historyReplayRunning = false;
      historyReplayTimer = undefined;
      button.textContent = "重新回放";
      progress.textContent = `回放完成 · ${items.length} / ${items.length}`;
      return;
    }
    current.classList.remove("replay-pending");
    current.classList.add("replay-current");
    progress.textContent = `正在回放 · ${index + 1} / ${items.length}`;
    current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    index += 1;
    historyReplayTimer = window.setTimeout(showNext, delay);
  };
  showNext();
}

function stopHistoryReplay(): void {
  historyReplayRunning = false;
  if (historyReplayTimer !== undefined) {
    window.clearTimeout(historyReplayTimer);
    historyReplayTimer = undefined;
  }
  historyDetail.querySelectorAll<HTMLElement>(".history-event").forEach((item) => {
    item.classList.remove("replay-pending", "replay-current");
  });
}

function renderHistoryPlan(plan: PlanSnapshot | undefined): HTMLElement | null {
  if (!plan) return null;
  const section = document.createElement("section");
  section.className = "history-summary history-plan";
  const title = document.createElement("strong");
  title.textContent = `执行计划 · ${planStateLabel(plan.state)}`;
  const list = document.createElement("ol");
  for (const item of plan.items) {
    const row = document.createElement("li");
    row.className = item.status;
    row.textContent = item.title;
    list.append(row);
  }
  section.append(title, list);
  if (plan.verification.length > 0) {
    const evidence = document.createElement("p");
    evidence.textContent = `核验：${plan.verification.join("；")}`;
    section.append(evidence);
  }
  if (plan.remaining.length > 0) {
    const remaining = document.createElement("p");
    remaining.textContent = `遗留：${plan.remaining.join("；")}`;
    section.append(remaining);
  }
  return section;
}

function renderEmptyHistoryDetail(): void {
  selectedHistoryId = null;
  selectedHistoryDetail = null;
  conversationDeleteArmed = false;
  renderContinueHistoryButton();
  historyDetail.replaceChildren(historyLoading("运行第一个 Agent 任务后，这里会显示完整记录。"));
}

function renderContinueHistoryButton(): void {
  const detail = selectedHistoryDetail;
  continueHistoryButton.disabled =
    runIsActive || !detail || detail.status === "running";
  continueHistoryButton.textContent = runIsActive
    ? "当前任务运行中"
    : !detail
      ? "选择一条记录"
      : detail.status === "running"
        ? "任务运行中"
        : "切换并继续";
  deleteConversationButton.disabled = runIsActive || !detail || detail.status === "running";
  exportRunReportButton.disabled = !detail || detail.status === "running";
  deleteConversationButton.textContent = conversationDeleteArmed
    ? "确认删除整个会话"
    : "删除会话";
}

async function exportSelectedRunReport(): Promise<void> {
  const detail = selectedHistoryDetail;
  if (!detail || detail.status === "running") {
    return;
  }
  exportRunReportButton.disabled = true;
  try {
    const result = await api.exportRunReport(detail.id);
    if (result.saved) {
      notify(`任务证据报告已导出${result.filePath ? `：${result.filePath}` : ""}`);
    }
  } catch (error) {
    notify(errorMessage(error));
  } finally {
    renderContinueHistoryButton();
  }
}

async function deleteSelectedConversation(): Promise<void> {
  const detail = selectedHistoryDetail;
  if (!detail || runIsActive || detail.status === "running") {
    return;
  }
  if (!conversationDeleteArmed) {
    conversationDeleteArmed = true;
    renderContinueHistoryButton();
    notify("再点一次将删除该会话及其所有接续记录；项目文件不会被删除。");
    return;
  }

  const deletedSourceId = detail.id;
  deleteConversationButton.disabled = true;
  try {
    const result = await api.deleteRunConversation(deletedSourceId);
    selectedHistoryId = null;
    selectedHistoryDetail = null;
    conversationDeleteArmed = false;
    await loadRunHistory();

    if (
      activeConversationRunId &&
      !runHistory.some((run) => run.id === activeConversationRunId)
    ) {
      activeConversationRunId = null;
      continuationSource = null;
      conversationHydrated = true;
      renderContinuationContext();
      clearTimeline(true);
      renderTokenUsage(null);
    }

    renderHistoryList();
    const first = runHistory[0];
    if (first) {
      await showHistoryDetail(first.id);
    } else {
      renderEmptyHistoryDetail();
    }
    notify(`会话已删除，共清理 ${result.deletedCount} 条任务记录。`);
  } catch (error) {
    conversationDeleteArmed = false;
    renderContinueHistoryButton();
    notify(errorMessage(error));
  }
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
  if (
    event.type === "run_completed" ||
    (event.type === "tool_finished" && !event.result.isError) ||
    (event.type === "plan_updated" && event.plan.state === "completed")
  ) {
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
    case "assistant_delta":
      return `Agent 正在生成 · ${compactMarkdownText(event.text)}`;
    case "model_usage":
      return `Token 累计 · ${event.estimated ? "约 " : ""}${formatTokenCount(event.totalTokens)}（输入 ${formatTokenCount(event.promptTokens)} / 输出 ${formatTokenCount(event.completionTokens)}）`;
    case "assistant_message":
      return `Agent · ${compactMarkdownText(event.text)}`;
    case "tool_started":
      return `${toolLabel(event.name)} · ${summarizeArguments(event.name, event.arguments)}`;
    case "tool_finished":
      return `${toolLabel(event.name)}${event.result.isError ? "失败" : "完成"} · ${event.durationMs} ms`;
    case "plan_updated":
      return `计划更新 · 第 ${event.plan.revision} 版 · ${planStateLabel(event.plan.state)}`;
    case "completion_blocked":
      return `完成检查未通过 · ${event.message}`;
    case "run_completed":
      return `任务完成 · ${compactMarkdownText(event.summary)}`;
    case "run_cancelled":
      return `任务已停止 · 共执行 ${event.steps} 步`;
    case "run_failed":
      return `${event.reason === "max_steps" ? "达到步骤上限" : "任务失败"} · ${event.message}`;
  }
}

async function loadProjectContext(showMessage = false): Promise<void> {
  if (!project) {
    return;
  }
  try {
    projectContext = await api.getProjectContext();
    const hasMemory = Boolean(projectContext.memory.trim());
    if (!memorySelectionInitialized) {
      memoryEnabled = hasMemory;
      memorySelectionInitialized = true;
    } else if (!hasMemory) {
      memoryEnabled = false;
    }
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
  skillsButton.disabled = runIsActive || !project;
  memoryButton.disabled = runIsActive || !project;
  contextPreviewButton.disabled = runIsActive || !project;
  skillsBadge.textContent = projectContext.skills.length
    ? `${selectedSkillIds.size}/${projectContext.skills.length}`
    : "0";
  skillsButton.classList.toggle("active", selectedSkillIds.size > 0);
  const hasMemory = projectContext.memory.trim().length > 0;
  memoryBadge.textContent = !hasMemory ? "未设置" : memoryEnabled ? "已启用" : "未启用";
  memoryButton.classList.toggle("active", hasMemory && memoryEnabled);
}

function openSkills(): void {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  skillDeleteConfirmId = null;
  renderSkillList();
  skillsDialog.showModal();
}

function renderSkillList(): void {
  newSkillButton.disabled = runIsActive || !project;
  skillList.replaceChildren();
  if (projectContext.skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "context-empty";
    const mark = document.createElement("span");
    mark.textContent = "◇";
    const title = document.createElement("strong");
    title.textContent = "这个项目还没有 Skill";
    const copy = document.createElement("p");
    copy.textContent = "点击“新建 Skill”创建第一条项目工作方式。";
    empty.append(mark, title, copy);
    skillList.append(empty);
    return;
  }
  for (const skill of projectContext.skills) {
    const row = document.createElement("div");
    row.className = "skill-option";
    const label = document.createElement("label");
    label.className = "skill-selector";
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

    const actions = document.createElement("div");
    actions.className = "skill-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "skill-action";
    edit.textContent = "编辑";
    edit.disabled = runIsActive;
    edit.addEventListener("click", () => void openSkillEditor(skill.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = `skill-action delete${skillDeleteConfirmId === skill.id ? " armed" : ""}`;
    remove.textContent = skillDeleteConfirmId === skill.id ? "确认删除" : "删除";
    remove.disabled = runIsActive;
    remove.addEventListener("click", () => void deleteSkill(skill.id));
    actions.append(edit, remove);
    row.append(label, actions);
    skillList.append(row);
  }
}

function openNewSkill(): void {
  editingSkillId = null;
  skillEditorTitle.textContent = "新建 Skill";
  skillFileNameInput.value = "";
  skillFileNameInput.disabled = false;
  skillContentInput.value = "# Skill 名称\n\n写下希望 Agent 长期遵循的项目工作方式。";
  skillContentInput.disabled = false;
  skillEditorError.textContent = "";
  saveSkillButton.textContent = "创建 Skill";
  saveSkillButton.disabled = false;
  skillsDialog.close();
  skillEditorDialog.showModal();
  skillFileNameInput.focus();
}

async function openSkillEditor(id: string): Promise<void> {
  editingSkillId = id;
  skillEditorTitle.textContent = "编辑 Skill";
  skillFileNameInput.value = id.split("/").at(-1) ?? "";
  skillFileNameInput.disabled = true;
  skillContentInput.value = "正在读取…";
  skillContentInput.disabled = true;
  skillEditorError.textContent = "";
  saveSkillButton.textContent = "保存修改";
  saveSkillButton.disabled = true;
  skillsDialog.close();
  skillEditorDialog.showModal();
  try {
    const detail = await api.getProjectSkill(id);
    if (editingSkillId !== id || !skillEditorDialog.open) {
      return;
    }
    skillContentInput.value = detail.content;
    skillContentInput.disabled = false;
    saveSkillButton.disabled = false;
    skillContentInput.focus();
    skillContentInput.setSelectionRange(0, 0);
    skillContentInput.scrollTop = 0;
  } catch (error) {
    skillEditorError.textContent = errorMessage(error);
  }
}

function closeSkillEditor(): void {
  skillEditorDialog.close();
  editingSkillId = null;
  if (project && !skillsDialog.open) {
    renderSkillList();
    skillsDialog.showModal();
  }
}

async function saveSkill(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  skillEditorError.textContent = "";
  saveSkillButton.disabled = true;
  try {
    projectContext = await api.saveProjectSkill({
      id: editingSkillId ?? undefined,
      fileName: skillFileNameInput.value,
      content: skillContentInput.value,
    });
    const created = !editingSkillId;
    skillEditorDialog.close();
    editingSkillId = null;
    renderContextControls();
    renderSkillList();
    await refreshProject(false);
    skillsDialog.showModal();
    notify(created ? "Skill 已创建并保存到项目。" : "Skill 已更新。");
  } catch (error) {
    skillEditorError.textContent = errorMessage(error);
    saveSkillButton.disabled = false;
  }
}

async function deleteSkill(id: string): Promise<void> {
  if (skillDeleteConfirmId !== id) {
    skillDeleteConfirmId = id;
    renderSkillList();
    notify("再点一次“确认删除”；这个 Markdown 文件会从项目中移除。");
    return;
  }
  try {
    projectContext = await api.deleteProjectSkill(id);
    selectedSkillIds.delete(id);
    skillDeleteConfirmId = null;
    renderContextControls();
    renderSkillList();
    await refreshProject(false);
    notify("Skill 已删除。");
  } catch (error) {
    skillDeleteConfirmId = null;
    renderSkillList();
    notify(errorMessage(error));
  }
}

function openMemory(): void {
  if (!project) {
    notify("请先打开一个项目。");
    return;
  }
  memoryInput.value = projectContext.memory;
  memoryEnabledInput.checked = memoryEnabled;
  memoryInput.maxLength = projectContext.maxMemoryChars;
  memoryError.textContent = "";
  memoryDeleteArmed = false;
  renderMemoryCharacterCount();
  renderMemoryPreview();
  renderMemoryUseOption();
  renderMemoryActions();
  memoryDialog.showModal();
  memoryInput.focus();
}

function renderMemoryCharacterCount(): void {
  memoryCharacterCount.textContent = `${memoryInput.value.length.toLocaleString()} / ${projectContext.maxMemoryChars.toLocaleString()}`;
  memoryUpdatedAt.textContent = projectContext.memoryUpdatedAt
    ? `上次保存：${formatHistoryDate(projectContext.memoryUpdatedAt)}`
    : "尚未保存";
}

function renderMemoryPreview(): void {
  const compact = memoryInput.value.replace(/\s+/g, " ").trim();
  memoryPreview.textContent = compact
    ? `注入预览：${compact.slice(0, 260)}${compact.length > 260 ? "…" : ""}`
    : "保存后，这里会显示实际注入模型的开头。";
}

function renderMemoryUseOption(): void {
  const hasContent = Boolean(memoryInput.value.trim());
  memoryEnabledInput.disabled = !hasContent;
  if (!hasContent) {
    memoryEnabledInput.checked = false;
  }
  renderMemoryActions();
}

function renderMemoryActions(): void {
  const hasSavedMemory = Boolean(projectContext.memory.trim());
  deleteMemoryButton.disabled = runIsActive || !hasSavedMemory;
  importMemoryButton.disabled = runIsActive || !project;
  exportMemoryButton.disabled = runIsActive || !hasSavedMemory;
  deleteMemoryButton.textContent = memoryDeleteArmed ? "确认删除记忆" : "删除记忆";
  saveMemoryButton.textContent = hasSavedMemory ? "保存修改" : "创建记忆";
}

async function importMemory(): Promise<void> {
  if (runIsActive || !project) {
    return;
  }
  memoryError.textContent = "";
  importMemoryButton.disabled = true;
  try {
    const imported = await api.importProjectMemory();
    if (!imported) {
      return;
    }
    projectContext = imported;
    memoryInput.value = projectContext.memory;
    memoryEnabledInput.checked = memoryEnabled;
    renderMemoryCharacterCount();
    renderMemoryPreview();
    renderMemoryUseOption();
    renderContextControls();
    notify("Memory 已导入并保存；是否注入下一次任务仍由开关决定。 ");
  } catch (error) {
    memoryError.textContent = errorMessage(error);
  } finally {
    renderMemoryActions();
  }
}

async function exportMemory(): Promise<void> {
  if (runIsActive || !projectContext.memory.trim()) {
    return;
  }
  memoryError.textContent = "";
  exportMemoryButton.disabled = true;
  try {
    const result = await api.exportProjectMemory();
    if (result.saved) {
      notify(`Memory 已导出${result.filePath ? `：${result.filePath}` : ""}`);
    }
  } catch (error) {
    memoryError.textContent = errorMessage(error);
  } finally {
    renderMemoryActions();
  }
}

async function saveMemory(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  memoryError.textContent = "";
  try {
    projectContext = await api.saveProjectMemory(memoryInput.value);
    memoryEnabled = Boolean(projectContext.memory.trim()) && memoryEnabledInput.checked;
    renderContextControls();
    memoryDialog.close();
    notify(
      !projectContext.memory.trim()
        ? "项目记忆已清空。"
        : memoryEnabled
          ? "项目记忆已保存并启用。"
          : "项目记忆已保存，但当前未启用。",
    );
  } catch (error) {
    memoryError.textContent = errorMessage(error);
  }
}

async function deleteMemory(): Promise<void> {
  if (!projectContext.memory.trim() || runIsActive) {
    return;
  }
  if (!memoryDeleteArmed) {
    memoryDeleteArmed = true;
    renderMemoryActions();
    notify("再点一次将永久删除这份本地项目记忆。项目文件不会受影响。");
    return;
  }
  deleteMemoryButton.disabled = true;
  memoryError.textContent = "";
  try {
    projectContext = await api.deleteProjectMemory();
    memoryEnabled = false;
    memoryInput.value = "";
    memoryEnabledInput.checked = false;
    memoryDeleteArmed = false;
    renderMemoryCharacterCount();
    renderMemoryPreview();
    renderMemoryUseOption();
    renderContextControls();
    notify("项目记忆已删除，现在可以直接创建新的 Memory。");
  } catch (error) {
    memoryDeleteArmed = false;
    renderMemoryActions();
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
