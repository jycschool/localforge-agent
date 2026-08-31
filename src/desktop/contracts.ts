import type {
  AgentEvent,
  ChatMessage,
  CommandApprovalRequest,
  ExecutionMode,
  PlanApprovalDecision,
  PlanApprovalRequest,
  PlanSnapshot,
  TokenUsage,
} from "../core/protocol";

export const MAX_TASK_CHARS = 20_000;
export const MAX_ATTACHMENT_FILES = 8;

export type PermissionMode = "readOnly" | "workspace";
export type ResponseProfile = "fast" | "balanced" | "thorough";

export const IPC_CHANNELS = {
  selectProject: "project:select",
  restoreProject: "project:restore-last",
  refreshProject: "project:refresh",
  readFile: "project:read-file",
  saveFile: "project:save-file",
  createFile: "project:create-file",
  selectAttachments: "project:select-attachments",
  getProjectContext: "project:get-context",
  getProjectSkill: "project:get-skill",
  saveProjectSkill: "project:save-skill",
  deleteProjectSkill: "project:delete-skill",
  saveProjectMemory: "project:save-memory",
  deleteProjectMemory: "project:delete-memory",
  importProjectMemory: "project:import-memory",
  exportProjectMemory: "project:export-memory",
  listRunHistory: "history:list",
  getRunHistory: "history:get",
  deleteRunConversation: "history:delete-conversation",
  getSettings: "settings:get",
  saveSettings: "settings:save",
  getModelProfiles: "settings:get-model-profiles",
  saveModelProfile: "settings:save-model-profile",
  activateModelProfile: "settings:activate-model-profile",
  deleteModelProfile: "settings:delete-model-profile",
  testModelConnection: "settings:test-model-connection",
  openModelScopeTokenPage: "app:open-modelscope-token-page",
  startRun: "agent:start",
  stopRun: "agent:stop",
  getChanges: "agent:get-changes",
  restoreChanges: "agent:restore-changes",
  previewRunContext: "agent:preview-context",
  exportRunReport: "history:export-report",
  answerApproval: "agent:answer-approval",
  answerPlanApproval: "agent:answer-plan-approval",
  agentEvent: "agent:event",
  approvalRequested: "agent:approval-requested",
  planApprovalRequested: "agent:plan-approval-requested",
  changesUpdated: "agent:changes-updated",
} as const;

export interface ProjectFile {
  relativePath: string;
}

export interface ProjectSnapshot {
  name: string;
  rootPath: string;
  files: ProjectFile[];
}

export interface FileSnapshot {
  relativePath: string;
  content: string;
  size: number;
  language: string;
  contentHash: string;
}

export interface ManualFileSaveRequest {
  relativePath: string;
  content: string;
  expectedHash: string;
}

export interface ManualFileCreateRequest {
  relativePath: string;
  content: string;
}

export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  contentChars: number;
}

export interface ProjectSkillDetail extends ProjectSkill {
  content: string;
}

export interface ProjectSkillInput {
  id?: string;
  fileName: string;
  content: string;
}

export interface ProjectContextSnapshot {
  skills: ProjectSkill[];
  memory: string;
  memoryUpdatedAt: string | null;
  maxMemoryChars: number;
  maxSelectedSkills: number;
}

export interface PublicSettings {
  profileId: string;
  profileName: string;
  apiBaseUrl: string;
  model: string;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
  permissionMode: PermissionMode;
  responseProfile: ResponseProfile;
  hasApiKey: boolean;
  apiKeySource: "environment" | "saved" | "missing";
}

export interface SettingsInput {
  apiBaseUrl: string;
  model: string;
  apiKey?: string;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
  permissionMode: PermissionMode;
  responseProfile: ResponseProfile;
}

export interface ModelProfileInput extends SettingsInput {
  id?: string;
  name: string;
}

export interface RunRequest {
  task: string;
  executionMode?: ExecutionMode;
  selectedFile?: string;
  attachmentPaths?: string[];
  skillIds?: string[];
  useMemory?: boolean;
  continueFromRunId?: string;
}

export interface RunStartResult {
  started: boolean;
  runId?: string;
  message?: string;
}

export type RunHistoryStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export interface RunHistorySummary {
  id: string;
  task: string;
  status: RunHistoryStatus;
  summary: string;
  steps: number;
  selectedFile?: string;
  attachmentPaths: string[];
  skillIds: string[];
  memoryUsed: boolean;
  model?: string;
  modelProfileName?: string;
  permissionMode?: PermissionMode;
  responseProfile?: ResponseProfile;
  executionMode?: ExecutionMode;
  continuedFromRunId?: string;
  eventCount: number;
  changedFiles: string[];
  outcome?: RunOutcomeMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface RunHistoryDetail extends RunHistorySummary {
  events: AgentEvent[];
  messages: ChatMessage[];
  plan?: PlanSnapshot;
}

export interface DeleteConversationResult {
  deletedCount: number;
}

export interface ChangedFileSnapshot {
  relativePath: string;
  originalContent: string | null;
  currentContent: string;
  currentHash: string;
}

export interface RunOutcomeMetrics {
  changedFileCount: number;
  additions: number;
  deletions: number;
  lineStatsEstimated: boolean;
  toolCalls: number;
  commandCalls: number;
  rejectedCommandCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  toolDurationMs: number;
  testCount?: number;
  tokenUsage?: TokenUsage;
}

export interface RestoreChangedFilesRequest {
  files: Array<{ relativePath: string; currentHash: string }>;
}

export interface RestoreChangedFilesResult {
  restoredFiles: string[];
  changes: ChangedFileSnapshot[];
}

export interface ManualFileMutationResult {
  file: FileSnapshot;
  changes: ChangedFileSnapshot[];
}

export interface FileExportResult {
  saved: boolean;
  filePath?: string;
}

export interface ModelDiagnosticCheck {
  id: "connection" | "text" | "streaming" | "toolCalling" | "usage";
  status: "passed" | "failed" | "skipped";
  detail: string;
}

export interface ModelDiagnosticResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  checkedAt: string;
  checks: ModelDiagnosticCheck[];
}

export interface ModelProfileSummary extends PublicSettings {
  lastDiagnostic?: ModelDiagnosticResult;
}

export interface ModelProfilesSnapshot {
  activeProfileId: string;
  profiles: ModelProfileSummary[];
  maxProfiles: number;
}

export interface RunContextPreview {
  profileName: string;
  model: string;
  permissionMode: PermissionMode;
  responseProfile: ResponseProfile;
  executionMode: ExecutionMode;
  selectedFile?: string;
  skills: Array<{ name: string; relativePath: string; contentChars: number }>;
  memoryChars: number;
  memoryUpdatedAt: string | null;
  memoryPreview: string;
  attachments: Array<{ relativePath: string; contentChars: number }>;
  conversationMessageCount: number;
  conversationChars: number;
  toolCount: number;
  estimatedInputTokens: number;
  warnings: string[];
}

export interface DesktopApi {
  selectProject(): Promise<ProjectSnapshot | null>;
  restoreProject(): Promise<ProjectSnapshot | null>;
  refreshProject(): Promise<ProjectSnapshot | null>;
  readFile(relativePath: string): Promise<FileSnapshot>;
  saveFile(input: ManualFileSaveRequest): Promise<ManualFileMutationResult>;
  createFile(input: ManualFileCreateRequest): Promise<ManualFileMutationResult>;
  selectAttachments(): Promise<ProjectFile[]>;
  getProjectContext(): Promise<ProjectContextSnapshot>;
  getProjectSkill(id: string): Promise<ProjectSkillDetail>;
  saveProjectSkill(input: ProjectSkillInput): Promise<ProjectContextSnapshot>;
  deleteProjectSkill(id: string): Promise<ProjectContextSnapshot>;
  saveProjectMemory(memory: string): Promise<ProjectContextSnapshot>;
  deleteProjectMemory(): Promise<ProjectContextSnapshot>;
  importProjectMemory(): Promise<ProjectContextSnapshot | null>;
  exportProjectMemory(): Promise<FileExportResult>;
  listRunHistory(): Promise<RunHistorySummary[]>;
  getRunHistory(id: string): Promise<RunHistoryDetail>;
  deleteRunConversation(id: string): Promise<DeleteConversationResult>;
  exportRunReport(id: string): Promise<FileExportResult>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SettingsInput): Promise<PublicSettings>;
  getModelProfiles(): Promise<ModelProfilesSnapshot>;
  saveModelProfile(input: ModelProfileInput): Promise<ModelProfilesSnapshot>;
  activateModelProfile(id: string): Promise<PublicSettings>;
  deleteModelProfile(id: string): Promise<ModelProfilesSnapshot>;
  testModelConnection(): Promise<ModelDiagnosticResult>;
  openModelScopeTokenPage(): Promise<void>;
  startRun(request: RunRequest): Promise<RunStartResult>;
  stopRun(): Promise<boolean>;
  getChanges(): Promise<ChangedFileSnapshot[]>;
  restoreChanges(request: RestoreChangedFilesRequest): Promise<RestoreChangedFilesResult>;
  previewRunContext(request: RunRequest): Promise<RunContextPreview>;
  answerApproval(id: string, approved: boolean): Promise<boolean>;
  answerPlanApproval(id: string, decision: PlanApprovalDecision): Promise<boolean>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onApprovalRequested(listener: (request: CommandApprovalRequest) => void): () => void;
  onPlanApprovalRequested(listener: (request: PlanApprovalRequest) => void): () => void;
  onChangesUpdated(listener: (changes: ChangedFileSnapshot[]) => void): () => void;
}
