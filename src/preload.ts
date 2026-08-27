import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, CommandApprovalRequest } from "./core/protocol";
import {
  IPC_CHANNELS,
  type ChangedFileSnapshot,
  type DesktopApi,
  type SettingsInput,
} from "./desktop/contracts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: DesktopApi = {
  selectProject: () => ipcRenderer.invoke(IPC_CHANNELS.selectProject),
  refreshProject: () => ipcRenderer.invoke(IPC_CHANNELS.refreshProject),
  readFile: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.readFile, relativePath),
  getProjectContext: () => ipcRenderer.invoke(IPC_CHANNELS.getProjectContext),
  saveProjectMemory: (memory) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveProjectMemory, memory),
  listRunHistory: () => ipcRenderer.invoke(IPC_CHANNELS.listRunHistory),
  getRunHistory: (id) => ipcRenderer.invoke(IPC_CHANNELS.getRunHistory, id),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (input: SettingsInput) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, input),
  openModelScopeTokenPage: () => ipcRenderer.invoke(IPC_CHANNELS.openModelScopeTokenPage),
  startRun: (request) => ipcRenderer.invoke(IPC_CHANNELS.startRun, request),
  stopRun: () => ipcRenderer.invoke(IPC_CHANNELS.stopRun),
  getChanges: () => ipcRenderer.invoke(IPC_CHANNELS.getChanges),
  answerApproval: (id, approved) =>
    ipcRenderer.invoke(IPC_CHANNELS.answerApproval, id, approved),
  onAgentEvent: (listener) => subscribe<AgentEvent>(IPC_CHANNELS.agentEvent, listener),
  onApprovalRequested: (listener) =>
    subscribe<CommandApprovalRequest>(IPC_CHANNELS.approvalRequested, listener),
  onChangesUpdated: (listener) =>
    subscribe<ChangedFileSnapshot[]>(IPC_CHANNELS.changesUpdated, listener),
};

contextBridge.exposeInMainWorld("localForge", api);
