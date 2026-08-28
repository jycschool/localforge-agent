import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface StoredWorkspaceState {
  lastProjectPath?: string;
}

const MAX_STORED_PATH_CHARS = 32_768;

export class WorkspaceStateStore {
  private readonly filePath: string;

  public constructor(storageRoot: string) {
    this.filePath = path.join(storageRoot, "workspace-state.json");
  }

  public async lastProjectPath(): Promise<string | null> {
    const state = await this.read();
    const storedPath = state.lastProjectPath?.trim();
    return storedPath && path.isAbsolute(storedPath) ? storedPath : null;
  }

  public async saveLastProjectPath(projectPath: string): Promise<void> {
    const normalized = projectPath.trim();
    if (!normalized || normalized.length > MAX_STORED_PATH_CHARS || !path.isAbsolute(normalized)) {
      throw new Error("上次项目路径无效。");
    }
    await this.write({ lastProjectPath: normalized });
  }

  public async clearLastProjectPath(): Promise<void> {
    await this.write({});
  }

  private async read(): Promise<StoredWorkspaceState> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(value)) {
        return {};
      }
      return {
        lastProjectPath:
          typeof value.lastProjectPath === "string" ? value.lastProjectPath : undefined,
      };
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) {
        return {};
      }
      throw error;
    }
  }

  private async write(state: StoredWorkspaceState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
