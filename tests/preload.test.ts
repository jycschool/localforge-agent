import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/core/protocol";
import { IPC_CHANNELS, type DesktopApi } from "../src/desktop/contracts";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  await import("../src/preload.js");
});

describe("preload DesktopApi", () => {
  it("exposes only the named LocalForge API and maps commands to fixed channels", async () => {
    const api = exposedApi();
    const settings = {
      apiBaseUrl: "https://example.test/v1",
      model: "test-model",
      apiKey: "secret",
      maxSteps: 8,
      commandTimeoutMs: 10_000,
      maxOutputChars: 5_000,
      permissionMode: "workspace" as const,
      responseProfile: "balanced" as const,
    };

    await api.selectProject();
    await api.restoreProject();
    await api.refreshProject();
    await api.readFile("README.md");
    await api.saveFile({ relativePath: "README.md", content: "saved", expectedHash: "abc" });
    await api.createFile({ relativePath: "notes.md", content: "new" });
    await api.selectAttachments();
    await api.getProjectContext();
    await api.getProjectSkill(".localforge/skills/test.md");
    await api.saveProjectSkill({ fileName: "test.md", content: "# Test" });
    await api.deleteProjectSkill(".localforge/skills/test.md");
    await api.saveProjectMemory("pnpm test");
    await api.deleteProjectMemory();
    await api.importProjectMemory();
    await api.exportProjectMemory();
    await api.listRunHistory();
    await api.getRunHistory("run-1");
    await api.deleteRunConversation("run-1");
    await api.exportRunReport("run-1");
    await api.getSettings();
    await api.saveSettings(settings);
    await api.getModelProfiles();
    await api.saveModelProfile({ ...settings, name: "Demo" });
    await api.activateModelProfile("profile-2");
    await api.deleteModelProfile("profile-2");
    await api.testModelConnection();
    await api.openModelScopeTokenPage();
    await api.startRun({ task: "Inspect", skillIds: ["test-first"] });
    await api.stopRun();
    await api.getChanges();
    await api.restoreChanges({ files: [{ relativePath: "README.md", currentHash: "abc" }] });
    await api.previewRunContext({ task: "Inspect context" });
    await api.answerApproval("approval-1", true);

    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith("localForge", api);
    expect(electronMocks.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.selectProject],
      [IPC_CHANNELS.restoreProject],
      [IPC_CHANNELS.refreshProject],
      [IPC_CHANNELS.readFile, "README.md"],
      [IPC_CHANNELS.saveFile, { relativePath: "README.md", content: "saved", expectedHash: "abc" }],
      [IPC_CHANNELS.createFile, { relativePath: "notes.md", content: "new" }],
      [IPC_CHANNELS.selectAttachments],
      [IPC_CHANNELS.getProjectContext],
      [IPC_CHANNELS.getProjectSkill, ".localforge/skills/test.md"],
      [IPC_CHANNELS.saveProjectSkill, { fileName: "test.md", content: "# Test" }],
      [IPC_CHANNELS.deleteProjectSkill, ".localforge/skills/test.md"],
      [IPC_CHANNELS.saveProjectMemory, "pnpm test"],
      [IPC_CHANNELS.deleteProjectMemory],
      [IPC_CHANNELS.importProjectMemory],
      [IPC_CHANNELS.exportProjectMemory],
      [IPC_CHANNELS.listRunHistory],
      [IPC_CHANNELS.getRunHistory, "run-1"],
      [IPC_CHANNELS.deleteRunConversation, "run-1"],
      [IPC_CHANNELS.exportRunReport, "run-1"],
      [IPC_CHANNELS.getSettings],
      [IPC_CHANNELS.saveSettings, settings],
      [IPC_CHANNELS.getModelProfiles],
      [IPC_CHANNELS.saveModelProfile, { ...settings, name: "Demo" }],
      [IPC_CHANNELS.activateModelProfile, "profile-2"],
      [IPC_CHANNELS.deleteModelProfile, "profile-2"],
      [IPC_CHANNELS.testModelConnection],
      [IPC_CHANNELS.openModelScopeTokenPage],
      [IPC_CHANNELS.startRun, { task: "Inspect", skillIds: ["test-first"] }],
      [IPC_CHANNELS.stopRun],
      [IPC_CHANNELS.getChanges],
      [IPC_CHANNELS.restoreChanges, { files: [{ relativePath: "README.md", currentHash: "abc" }] }],
      [IPC_CHANNELS.previewRunContext, { task: "Inspect context" }],
      [IPC_CHANNELS.answerApproval, "approval-1", true],
    ]);
  });

  it("wraps event subscriptions and removes the exact listener", () => {
    const api = exposedApi();
    const listener = vi.fn();
    const unsubscribe = api.onAgentEvent(listener);
    const wrapped = electronMocks.on.mock.calls[0]?.[1] as
      | ((event: unknown, value: AgentEvent) => void)
      | undefined;
    const event: AgentEvent = { type: "model_started", step: 2 };

    expect(electronMocks.on).toHaveBeenCalledWith(IPC_CHANNELS.agentEvent, wrapped);
    expect(wrapped).toBeTypeOf("function");
    wrapped?.({}, event);
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.agentEvent,
      wrapped,
    );
  });

  it("uses separate fixed channels for approvals and change notifications", () => {
    const api = exposedApi();
    const stopApproval = api.onApprovalRequested(vi.fn());
    const stopChanges = api.onChangesUpdated(vi.fn());

    expect(electronMocks.on.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.approvalRequested,
      IPC_CHANNELS.changesUpdated,
    ]);

    stopApproval();
    stopChanges();
    expect(electronMocks.removeListener.mock.calls.map((call) => call[0])).toEqual([
      IPC_CHANNELS.approvalRequested,
      IPC_CHANNELS.changesUpdated,
    ]);
  });
});

function exposedApi(): DesktopApi {
  const call = electronMocks.exposeInMainWorld.mock.calls[0];
  expect(call?.[0]).toBe("localForge");
  return call?.[1] as DesktopApi;
}
