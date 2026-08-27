import * as vscode from "vscode";
import { LocalForgeViewProvider } from "./panel/localForgeView";

const API_KEY_SECRET = "localForge.apiKey";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LocalForgeViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LocalForgeViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("localForge.setApiKey", async () => {
      const apiKey = await vscode.window.showInputBox({
        title: "Set LocalForge API key",
        prompt: "The key is stored in VS Code SecretStorage and is never written to settings.",
        password: true,
        ignoreFocusOut: true,
      });

      if (apiKey?.trim()) {
        await context.secrets.store(API_KEY_SECRET, apiKey.trim());
        void vscode.window.showInformationMessage("LocalForge API key saved securely.");
      }
    }),
  );
}

export function deactivate(): void {}

