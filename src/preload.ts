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
  restoreProject: () => ipcRenderer.invoke(IPC_CHANNELS.restoreProject),
  refreshProject: () => ipcRenderer.invoke(IPC_CHANNELS.refreshProject),
  readFile: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.readFile, relativePath),
  saveFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveFile, input),
  createFile: (input) => ipcRenderer.invoke(IPC_CHANNELS.createFile, input),
  selectAttachments: () => ipcRenderer.invoke(IPC_CHANNELS.selectAttachments),
  getProjectContext: () => ipcRenderer.invoke(IPC_CHANNELS.getProjectContext),
  getProjectSkill: (id) => ipcRenderer.invoke(IPC_CHANNELS.getProjectSkill, id),
  saveProjectSkill: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveProjectSkill, input),
  deleteProjectSkill: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteProjectSkill, id),
  saveProjectMemory: (memory) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveProjectMemory, memory),
  deleteProjectMemory: () => ipcRenderer.invoke(IPC_CHANNELS.deleteProjectMemory),
  importProjectMemory: () => ipcRenderer.invoke(IPC_CHANNELS.importProjectMemory),
  exportProjectMemory: () => ipcRenderer.invoke(IPC_CHANNELS.exportProjectMemory),
  listRunHistory: () => ipcRenderer.invoke(IPC_CHANNELS.listRunHistory),
  getRunHistory: (id) => ipcRenderer.invoke(IPC_CHANNELS.getRunHistory, id),
  deleteRunConversation: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteRunConversation, id),
  exportRunReport: (id) => ipcRenderer.invoke(IPC_CHANNELS.exportRunReport, id),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (input: SettingsInput) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, input),
  getModelProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.getModelProfiles),
  saveModelProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveModelProfile, input),
  activateModelProfile: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.activateModelProfile, id),
  deleteModelProfile: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteModelProfile, id),
  testModelConnection: () => ipcRenderer.invoke(IPC_CHANNELS.testModelConnection),
  openModelScopeTokenPage: () => ipcRenderer.invoke(IPC_CHANNELS.openModelScopeTokenPage),
  startRun: (request) => ipcRenderer.invoke(IPC_CHANNELS.startRun, request),
  stopRun: () => ipcRenderer.invoke(IPC_CHANNELS.stopRun),
  getChanges: () => ipcRenderer.invoke(IPC_CHANNELS.getChanges),
  restoreChanges: (request) => ipcRenderer.invoke(IPC_CHANNELS.restoreChanges, request),
  previewRunContext: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewRunContext, request),
  answerApproval: (id, approved) =>
    ipcRenderer.invoke(IPC_CHANNELS.answerApproval, id, approved),
  onAgentEvent: (listener) => subscribe<AgentEvent>(IPC_CHANNELS.agentEvent, listener),
  onApprovalRequested: (listener) =>
    subscribe<CommandApprovalRequest>(IPC_CHANNELS.approvalRequested, listener),
  onChangesUpdated: (listener) =>
    subscribe<ChangedFileSnapshot[]>(IPC_CHANNELS.changesUpdated, listener),
};

contextBridge.exposeInMainWorld("localForge", api);
