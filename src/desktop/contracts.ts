import type { AgentEvent, CommandApprovalRequest } from "../core/protocol";

export const IPC_CHANNELS = {
  selectProject: "project:select",
  refreshProject: "project:refresh",
  readFile: "project:read-file",
  getSettings: "settings:get",
  saveSettings: "settings:save",
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
  getSettings(): Promise<PublicSettings>;
  saveSettings(input: SettingsInput): Promise<PublicSettings>;
  startRun(request: RunRequest): Promise<RunStartResult>;
  stopRun(): Promise<boolean>;
  getChanges(): Promise<ChangedFileSnapshot[]>;
  answerApproval(id: string, approved: boolean): Promise<boolean>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onApprovalRequested(listener: (request: CommandApprovalRequest) => void): () => void;
  onChangesUpdated(listener: (changes: ChangedFileSnapshot[]) => void): () => void;
}
