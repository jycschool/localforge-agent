import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChangedFileSnapshot,
  RestoreChangedFilesRequest,
  RestoreChangedFilesResult,
} from "../desktop/contracts";
import { readProjectFile } from "../desktop/projectService";
import type { ChangeTracker } from "./changeTracker";

const MAX_RESTORE_FILES = 200;

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function collectTrackedChanges(
  rootPath: string,
  tracker: ChangeTracker,
): Promise<ChangedFileSnapshot[]> {
  return Promise.all(
    tracker.list().map(async (change) => {
      const current = await readProjectFile(rootPath, change.relativePath);
      return {
        relativePath: change.relativePath,
        originalContent: change.originalContent,
        currentContent: current.content,
        currentHash: hashContent(current.content),
      };
    }),
  );
}

export async function restoreTrackedChanges(
  rootPath: string,
  tracker: ChangeTracker,
  request: RestoreChangedFilesRequest,
): Promise<RestoreChangedFilesResult> {
  if (!Array.isArray(request.files) || request.files.length === 0) {
    throw new Error("请选择要恢复的文件。");
  }
  if (request.files.length > MAX_RESTORE_FILES) {
    throw new Error(`一次最多恢复 ${MAX_RESTORE_FILES} 个文件。`);
  }

  const seen = new Set<string>();
  const candidates = await Promise.all(
    request.files.map(async (requested) => {
      if (
        !requested ||
        typeof requested.relativePath !== "string" ||
        typeof requested.currentHash !== "string"
      ) {
        throw new Error("恢复请求无效。");
      }
      if (seen.has(requested.relativePath)) {
        throw new Error(`恢复列表包含重复文件：${requested.relativePath}`);
      }
      seen.add(requested.relativePath);
      const tracked = tracker.get(requested.relativePath);
      if (!tracked) {
        throw new Error(`文件已不在本次变更中：${requested.relativePath}`);
      }
      const current = await readProjectFile(rootPath, requested.relativePath);
      if (hashContent(current.content) !== requested.currentHash) {
        throw new Error(
          `文件在任务结束后又被修改，已停止恢复：${requested.relativePath}`,
        );
      }
      return { tracked, absolutePath: path.join(rootPath, current.relativePath) };
    }),
  );

  for (const candidate of candidates) {
    const requested = request.files.find(
      (file) => file.relativePath === candidate.tracked.relativePath,
    );
    const latest = await readProjectFile(rootPath, candidate.tracked.relativePath);
    if (!requested || hashContent(latest.content) !== requested.currentHash) {
      throw new Error(
        `文件在恢复前发生了变化，未覆盖外部修改：${candidate.tracked.relativePath}`,
      );
    }
  }

  for (const candidate of candidates) {
    if (candidate.tracked.originalContent === null) {
      await unlink(candidate.absolutePath);
    } else {
      await writeFile(candidate.absolutePath, candidate.tracked.originalContent, "utf8");
    }
    tracker.remove(candidate.tracked.relativePath);
  }

  return {
    restoredFiles: candidates.map((candidate) => candidate.tracked.relativePath),
    changes: await collectTrackedChanges(rootPath, tracker),
  };
}
