const DRAFT_PREFIX = "localforge.task-draft.v1";

interface StoredDraft {
  projectPath: string;
  text: string;
}

export function loadTaskDraft(storage: Storage, projectPath: string): string {
  try {
    const raw = storage.getItem(draftKey(projectPath));
    if (!raw) {
      return "";
    }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.projectPath !== projectPath || typeof value.text !== "string") {
      return "";
    }
    return value.text;
  } catch {
    return "";
  }
}

export function saveTaskDraft(storage: Storage, projectPath: string, text: string): void {
  try {
    if (!text) {
      clearTaskDraft(storage, projectPath);
      return;
    }
    const value: StoredDraft = { projectPath, text };
    storage.setItem(draftKey(projectPath), JSON.stringify(value));
  } catch {
    // Draft persistence is optional and must never block task submission.
  }
}

export function clearTaskDraft(storage: Storage, projectPath: string): void {
  try {
    storage.removeItem(draftKey(projectPath));
  } catch {
    // Ignore disabled or full browser storage.
  }
}

export function draftKey(projectPath: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < projectPath.length; index += 1) {
    hash = Math.imul(hash ^ projectPath.charCodeAt(index), 16_777_619);
  }
  return `${DRAFT_PREFIX}.${projectPath.length}.${(hash >>> 0).toString(16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
