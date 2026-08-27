import * as vscode from "vscode";

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly snapshots = new Map<string, string>();

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.snapshots.get(uri.toString()) ?? "";
  }

  public register(relativePath: string, content: string): vscode.Uri {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const uri = vscode.Uri.from({
      scheme: "localforge-original",
      path: `/${relativePath.replaceAll("\\", "/")}`,
      query: `snapshot=${key}`,
    });
    this.snapshots.set(uri.toString(), content);
    return uri;
  }
}

