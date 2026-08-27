import type { AgentEvent, CommandApprovalRequest } from "../core/protocol";

export const IPC_CHANNELS = {
  selectProject: "project:select",
  refreshProject: "project:refresh",
  readFile: "project:read-file",
  getProjectContext: "project:get-context",
  saveProjectMemory: "project:save-memory",
  getSettings: "settings:get",
  saveSettings: "settings:save",
  openModelScopeTokenPage: "app:open-modelscope-token-page",
  startRun: "agent:start",
  stopRun: "agent:stop",
  getChanges: "agent:get-changes",
  answerApproval: "agent:answer-approval",
  agentEvent: "agent:event",
  approvalRequested: "agent:approval-requested",
  changesUpdated: "agent:changes-updated",
} as const;

export interface ProjectFile {
  relativePath: string;
  size: number;
}

export interface ProjectSnapshot {
  name: string;
  rootPath: string;
  files: ProjectFile[];
  limited: boolean;
}

export interface FileSnapshot {
  relativePath: string;
  content: string;
  size: number;
  language: string;
}

export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  relativePath: string;
}

export interface ProjectContextSnapshot {
  skills: ProjectSkill[];
  memory: string;
  maxMemoryChars: number;
  maxSelectedSkills: number;
}

export interface PublicSettings {
  apiBaseUrl: string;
  model: string;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
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
}

export interface RunRequest {
  task: string;
  selectedFile?: string;
  skillIds?: string[];
}

export interface RunStartResult {
  started: boolean;
  message?: string;
}

export interface ChangedFileSnapshot {
  relativePath: string;
  originalContent: string | null;
  currentContent: string;
}

export interface DesktopApi {
  selectProject(): Promise<ProjectSnapshot | null>;
  refreshProject(): Promise<ProjectSnapshot | null>;
  readFile(relativePath: string): Promise<FileSnapshot>;
  getProjectContext(): Promise<ProjectContextSnapshot>;
  saveProjectMemory(memory: string): Promise<ProjectContextSnapshot>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SettingsInput): Promise<PublicSettings>;
  openModelScopeTokenPage(): Promise<void>;
  startRun(request: RunRequest): Promise<RunStartResult>;
  stopRun(): Promise<boolean>;
  getChanges(): Promise<ChangedFileSnapshot[]>;
  answerApproval(id: string, approved: boolean): Promise<boolean>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onApprovalRequested(listener: (request: CommandApprovalRequest) => void): () => void;
  onChangesUpdated(listener: (changes: ChangedFileSnapshot[]) => void): () => void;
}
