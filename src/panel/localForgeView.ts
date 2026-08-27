import * as vscode from "vscode";

export class LocalForgeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "localForge.agentView";

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRecord(message)) {
        return;
      }

      if (message.type === "setApiKey") {
        await vscode.commands.executeCommand("localForge.setApiKey");
      }

      if (message.type === "submit") {
        void view.webview.postMessage({
          type: "notice",
          text: "The interface is ready. Agent execution is added in the next milestone.",
        });
      }
    });
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
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 14px; font-weight: 600; }
    .status { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #timeline { min-height: 150px; margin: 12px 0; padding-left: 12px; border-left: 1px solid var(--vscode-panel-border); }
    .empty { color: var(--vscode-descriptionForeground); line-height: 1.5; }
    textarea { width: 100%; min-height: 92px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); font: inherit; }
    .actions { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; }
    button { padding: 5px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  </style>
</head>
<body>
  <header><h1>LocalForge</h1><span class="status">Idle</span></header>
  <main id="timeline"><p class="empty">Describe a coding task. LocalForge will show file reads, changes, commands, and validation here.</p></main>
  <textarea id="prompt" aria-label="Coding task" placeholder="Ask LocalForge to inspect or change this workspace..."></textarea>
  <div class="actions">
    <button id="set-key" class="secondary" type="button">Set API key</button>
    <button id="submit" type="button">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const prompt = document.getElementById('prompt');
    const timeline = document.getElementById('timeline');
    document.getElementById('set-key').addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
    document.getElementById('submit').addEventListener('click', () => vscode.postMessage({ type: 'submit', prompt: prompt.value }));
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'notice') {
        timeline.textContent = event.data.text;
      }
    });
  </script>
</body>
</html>`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

