import path from "node:path";
import * as vscode from "vscode";
import { AgentLoop } from "../agent/agentLoop";
import { ChangeTracker } from "../agent/changeTracker";
import { ToolRegistry } from "../agent/toolRegistry";
import type { AgentEvent, CommandApprovalRequest } from "../core/protocol";
import { OpenAICompatibleClient } from "../model/openAICompatibleClient";
import { createWorkspaceTools, isPathInside } from "../tools/workspaceTools";
import { DiffContentProvider } from "./diffContentProvider";

interface PendingApproval {
  resolve(approved: boolean): void;
}

interface LocalForgeConfiguration {
  apiBaseUrl: string;
  model: string;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
}

export class LocalForgeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "localForge.agentView";

  private view: vscode.WebviewView | undefined;
  private activeRun: AbortController | undefined;
  private activeRootPath: string | undefined;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly changeTracker = new ChangeTracker();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diffProvider: DiffContentProvider,
    private readonly apiKeySecret: string,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.stopRun();
        this.view = undefined;
      }
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "setApiKey":
        await vscode.commands.executeCommand("localForge.setApiKey");
        this.post({ type: "notice", text: "API key updated in VS Code SecretStorage." });
        break;
      case "run":
        if (typeof message.prompt === "string") {
          await this.startRun(message.prompt);
        }
        break;
      case "stop":
        this.stopRun();
        break;
      case "approval":
        if (typeof message.id === "string" && typeof message.approved === "boolean") {
          this.resolveApproval(message.id, message.approved);
        }
        break;
      case "openDiff":
        if (typeof message.path === "string") {
          await this.openDiff(message.path);
        }
        break;
    }
  }

  private async startRun(rawPrompt: string): Promise<void> {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      this.post({ type: "error", text: "Describe a task before starting." });
      return;
    }
    if (this.activeRun) {
      this.post({ type: "error", text: "A LocalForge run is already active." });
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.post({ type: "error", text: "Open a local workspace folder before starting LocalForge." });
      return;
    }
    const apiKey = await this.context.secrets.get(this.apiKeySecret);
    if (!apiKey) {
      this.post({ type: "error", text: "No API key is configured. Select “Set API key” first." });
      return;
    }

    const config = readConfiguration();
    const controller = new AbortController();
    this.activeRun = controller;
    this.activeRootPath = workspaceFolder.uri.fsPath;
    this.changeTracker.clear();
    this.post({ type: "state", state: "running", model: config.model });

    try {
      const tools = await createWorkspaceTools({
        rootPath: workspaceFolder.uri.fsPath,
        changeTracker: this.changeTracker,
        commandTimeoutMs: config.commandTimeoutMs,
        maxOutputChars: config.maxOutputChars,
      });
      const model = new OpenAICompatibleClient({
        apiBaseUrl: config.apiBaseUrl,
        apiKey,
        model: config.model,
      });
      const loop = new AgentLoop(model, new ToolRegistry(tools));
      const taskWithContext = buildTaskWithEditorContext(prompt, workspaceFolder.uri.fsPath);

      await loop.run({
        task: taskWithContext,
        systemPrompt: buildSystemPrompt(workspaceFolder.uri.fsPath),
        maxSteps: config.maxSteps,
        signal: controller.signal,
        onEvent: (event) => this.postAgentEvent(event),
        requestCommandApproval: (request) => this.requestCommandApproval(request, controller.signal),
      });
    } catch (error) {
      this.post({ type: "error", text: errorMessage(error) });
    } finally {
      this.resolveAllApprovals(false);
      if (this.activeRun === controller) {
        this.activeRun = undefined;
      }
      this.post({ type: "state", state: "idle", model: config.model });
      this.post({
        type: "changes",
        files: this.changeTracker.list().map((file) => ({
          path: file.relativePath,
          created: file.originalContent === null,
        })),
      });
    }
  }

  private postAgentEvent(event: AgentEvent): void {
    this.post({ type: "agentEvent", event });
  }

  private requestCommandApproval(
    request: CommandApprovalRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean): void => {
        signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(request.id);
        resolve(approved);
      };
      const onAbort = (): void => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(request.id, { resolve: finish });
      this.post({ type: "approval", request });
    });
  }

  private resolveApproval(id: string, approved: boolean): void {
    this.pendingApprovals.get(id)?.resolve(approved);
  }

  private resolveAllApprovals(approved: boolean): void {
    for (const approval of Array.from(this.pendingApprovals.values())) {
      approval.resolve(approved);
    }
  }

  private stopRun(): void {
    this.activeRun?.abort();
    this.resolveAllApprovals(false);
  }

  private async openDiff(relativePath: string): Promise<void> {
    const rootPath = this.activeRootPath;
    const changed = this.changeTracker.list().find((file) => file.relativePath === relativePath);
    if (!rootPath || !changed) {
      void vscode.window.showWarningMessage("The selected LocalForge change is no longer available.");
      return;
    }

    const currentUri = vscode.Uri.file(path.resolve(rootPath, relativePath));
    if (!isPathInside(rootPath, currentUri.fsPath)) {
      void vscode.window.showErrorMessage("Refusing to open a Diff outside the workspace.");
      return;
    }
    const originalUri = this.diffProvider.register(relativePath, changed.originalContent ?? "");
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      currentUri,
      `${relativePath} (before LocalForge ↔ current)`,
    );
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>LocalForge</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    .status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #stop { display: none; }
    #timeline { min-height: 180px; margin: 12px 0; padding-left: 12px; border-left: 1px solid var(--vscode-panel-border); }
    .empty, .secondary-text { color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .event { position: relative; margin: 0 0 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .event::before { content: ''; position: absolute; width: 7px; height: 7px; left: -16px; top: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .event.success::before { background: var(--vscode-testing-iconPassed); }
    .event.error::before { background: var(--vscode-testing-iconFailed); }
    .event.running::before { background: var(--vscode-progressBar-background); }
    .event-title { font-weight: 600; }
    .event-meta { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: pre-wrap; }
    .assistant { white-space: pre-wrap; }
    .approval, .changes { margin: 10px 0; padding: 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); }
    .approval code { display: block; margin: 8px 0; padding: 6px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; overflow-wrap: anywhere; }
    .approval-actions, .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .changes button { display: block; width: 100%; margin-top: 6px; text-align: left; }
    textarea { width: 100%; min-height: 92px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); font: inherit; }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    button { padding: 5px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: 0.55; cursor: default; }
  </style>
</head>
<body>
  <header>
    <div><h1>LocalForge</h1><span id="status" class="status">Idle</span></div>
    <button id="stop" class="secondary" type="button">Stop</button>
  </header>
  <main id="timeline" aria-live="polite"><p class="empty">Describe a coding task. File reads, changes, commands, and validation will appear here.</p></main>
  <textarea id="prompt" aria-label="Coding task" placeholder="Ask LocalForge to inspect or change this workspace..."></textarea>
  <div class="actions">
    <button id="set-key" class="secondary" type="button">Set API key</button>
    <button id="send" type="button">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const prompt = document.getElementById('prompt');
    const timeline = document.getElementById('timeline');
    const status = document.getElementById('status');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    let running = false;

    document.getElementById('set-key').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    send.addEventListener('click', startRun);
    stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        startRun();
      }
    });

    function startRun() {
      const value = prompt.value.trim();
      if (!value || running) return;
      timeline.replaceChildren();
      vscode.postMessage({ type: 'run', prompt: value });
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'state') setRunning(message.state === 'running', message.model);
      if (message.type === 'agentEvent') renderEvent(message.event);
      if (message.type === 'approval') renderApproval(message.request);
      if (message.type === 'changes') renderChanges(message.files);
      if (message.type === 'error') addEvent('Error', message.text, 'error');
      if (message.type === 'notice') addEvent('LocalForge', message.text, 'success');
    });

    function setRunning(value, model) {
      running = value;
      send.disabled = value;
      prompt.disabled = value;
      stop.style.display = value ? 'inline-block' : 'none';
      status.textContent = value ? 'Running · ' + model : 'Idle · ' + model;
    }

    function renderEvent(event) {
      if (!event) return;
      switch (event.type) {
        case 'run_started': addEvent('Task started', event.task, 'running'); break;
        case 'model_started': addEvent('Model turn ' + event.step, 'Choosing the next action…', 'running'); break;
        case 'assistant_message': addEvent('Agent', event.text, 'success', true); break;
        case 'tool_started': addEvent(toolTitle(event.name), toolDetail(event.name, event.arguments), 'running'); break;
        case 'tool_finished': addEvent(event.result?.isError ? 'Tool reported an error' : 'Tool completed', event.name + ' · ' + event.durationMs + ' ms', event.result?.isError ? 'error' : 'success'); break;
        case 'run_completed': addEvent('Ready for review', event.summary, 'success', true); break;
        case 'run_cancelled': addEvent('Run cancelled', 'Existing workspace changes were preserved.', 'error'); break;
        case 'run_failed': addEvent('Run stopped', event.message, 'error'); break;
      }
    }

    function addEvent(title, detail, kind, assistant) {
      const item = document.createElement('section');
      item.className = 'event ' + (kind || '');
      const heading = document.createElement('div');
      heading.className = 'event-title';
      heading.textContent = title || '';
      item.appendChild(heading);
      if (detail) {
        const body = document.createElement('div');
        body.className = assistant ? 'event-meta assistant' : 'event-meta';
        body.textContent = detail;
        item.appendChild(body);
      }
      timeline.appendChild(item);
      item.scrollIntoView({ block: 'nearest' });
    }

    function toolTitle(name) {
      const labels = { list_files: 'Listing files', search_text: 'Searching code', read_file: 'Reading file', replace_in_file: 'Editing file', write_file: 'Writing file', run_command: 'Preparing command' };
      return labels[name] || ('Using ' + name);
    }

    function toolDetail(name, args) {
      if (!args || typeof args !== 'object') return '';
      if (name === 'run_command') return String(args.command || '');
      return String(args.path || args.query || args.glob || '');
    }

    function renderApproval(request) {
      const card = document.createElement('section');
      card.className = 'approval';
      const title = document.createElement('strong');
      title.textContent = 'Command approval required';
      const reason = document.createElement('p');
      reason.className = 'secondary-text';
      reason.textContent = request.reason;
      const code = document.createElement('code');
      code.textContent = request.command;
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'secondary';
      reject.textContent = 'Reject';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Allow once';
      function answer(approved) {
        reject.disabled = true;
        approve.disabled = true;
        vscode.postMessage({ type: 'approval', id: request.id, approved });
      }
      reject.addEventListener('click', () => answer(false));
      approve.addEventListener('click', () => answer(true));
      actions.append(reject, approve);
      card.append(title, reason, code, actions);
      timeline.appendChild(card);
      card.scrollIntoView({ block: 'nearest' });
    }

    function renderChanges(files) {
      if (!Array.isArray(files) || files.length === 0) return;
      const card = document.createElement('section');
      card.className = 'changes';
      const title = document.createElement('strong');
      title.textContent = 'Changed files';
      card.appendChild(title);
      for (const file of files) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = (file.created ? 'New · ' : 'Review · ') + file.path;
        button.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', path: file.path }));
        card.appendChild(button);
      }
      timeline.appendChild(card);
    }
  </script>
</body>
</html>`;
  }
}

function readConfiguration(): LocalForgeConfiguration {
  const config = vscode.workspace.getConfiguration("localForge");
  return {
    apiBaseUrl: config.get("apiBaseUrl", "https://api.openai.com/v1"),
    model: config.get("model", "gpt-5.1-codex"),
    maxSteps: config.get("maxSteps", 20),
    commandTimeoutMs: config.get("commandTimeoutMs", 120_000),
    maxOutputChars: config.get("maxOutputChars", 12_000),
  };
}

function buildTaskWithEditorContext(task: string, rootPath: string): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file" || !isPathInside(rootPath, editor.document.uri.fsPath)) {
    return task;
  }

  const relativePath = path.relative(rootPath, editor.document.uri.fsPath).replaceAll("\\", "/");
  const selected = editor.document.getText(editor.selection).slice(0, 6_000);
  const context = selected
    ? `\n\nEditor context:\nActive file: ${relativePath}\nSelected code:\n\`\`\`\n${selected}\n\`\`\``
    : `\n\nEditor context:\nActive file: ${relativePath}`;
  return `${task}${context}`;
}

function buildSystemPrompt(rootPath: string): string {
  return `You are LocalForge, a local coding agent operating inside one VS Code workspace.

Workspace root: ${rootPath}

Use only the provided tools for file or command operations. Tool paths must be workspace-relative. Inspect relevant code before editing. Prefer replace_in_file for focused edits and write_file for new files or intentional full rewrites. Give every command a short, honest reason because the user must approve it. Treat command exit codes and test output as evidence: never claim tests passed unless a tool result proves it. When a tool fails, read the error and either recover or explain the blocker. Keep changes focused on the user's request. Finish with a concise summary of files changed, validation performed, and anything not verified.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

