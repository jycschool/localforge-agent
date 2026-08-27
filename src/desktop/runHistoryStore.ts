import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, ChatMessage } from "../core/protocol";
import type {
  RunHistoryDetail,
  RunHistoryStatus,
  RunHistorySummary,
} from "./contracts";

const MAX_RUNS_PER_PROJECT = 50;
const MAX_EVENTS_PER_RUN = 200;
const MAX_MESSAGES_PER_RUN = 160;
const MAX_TASK_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_EVENT_STRING_CHARS = 8_000;
const MAX_MESSAGE_CONTENT_CHARS = 16_000;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface HistoryIndex {
  version: 1;
  projectPath: string;
  runs: RunHistorySummary[];
}

export interface StartRunHistoryInput {
  task: string;
  selectedFile?: string;
  skillIds?: readonly string[];
}

export interface FinishRunHistoryInput {
  status: Exclude<RunHistoryStatus, "running" | "interrupted">;
  summary: string;
  steps: number;
  events: readonly AgentEvent[];
  messages: readonly ChatMessage[];
  changedFiles: readonly string[];
}

export class RunHistoryStore {
  readonly #storageRoot: string;

  constructor(storageRoot: string) {
    this.#storageRoot = path.join(storageRoot, "run-history");
  }

  async startRun(rootPath: string, input: StartRunHistoryInput): Promise<string> {
    const project = await this.#projectStorage(rootPath);
    const id = randomUUID();
    const now = new Date().toISOString();
    const summary: RunHistorySummary = {
      id,
      task: input.task.slice(0, MAX_TASK_CHARS),
      status: "running",
      summary: "任务正在运行。",
      steps: 0,
      selectedFile: input.selectedFile?.slice(0, 1_000),
      skillIds: Array.from(new Set(input.skillIds ?? [])).slice(0, 8),
      eventCount: 0,
      changedFiles: [],
      createdAt: now,
      updatedAt: now,
    };
    const detail: RunHistoryDetail = { ...summary, events: [], messages: [] };
    const index = await this.#readIndex(project.directory, project.rootPath);
    const retained = [summary, ...index.runs.filter((run) => run.id !== id)].slice(
      0,
      MAX_RUNS_PER_PROJECT,
    );
    const retainedIds = new Set(retained.map((run) => run.id));
    const removed = index.runs.filter((run) => !retainedIds.has(run.id));

    await mkdir(project.directory, { recursive: true });
    await this.#writeJson(this.#runFile(project.directory, id), detail);
    await this.#writeJson(this.#indexFile(project.directory), {
      version: 1,
      projectPath: project.rootPath,
      runs: retained,
    } satisfies HistoryIndex);
    await Promise.all(removed.map((run) => this.#removeRunFile(project.directory, run.id)));
    return id;
  }

  async finishRun(
    rootPath: string,
    id: string,
    input: FinishRunHistoryInput,
  ): Promise<void> {
    this.#validateRunId(id);
    const project = await this.#projectStorage(rootPath);
    const index = await this.#readIndex(project.directory, project.rootPath);
    const existing = index.runs.find((run) => run.id === id);
    if (!existing) {
      throw new Error("找不到对应的任务历史记录。");
    }
    const updatedAt = new Date().toISOString();
    const events = input.events.slice(-MAX_EVENTS_PER_RUN).map(sanitizeEvent);
    const messages = input.messages.slice(-MAX_MESSAGES_PER_RUN).map(sanitizeMessage);
    const summary: RunHistorySummary = {
      ...existing,
      status: input.status,
      summary: input.summary.slice(0, MAX_SUMMARY_CHARS),
      steps: Math.max(0, Math.trunc(input.steps)),
      eventCount: events.length,
      changedFiles: Array.from(new Set(input.changedFiles)).slice(0, 200),
      updatedAt,
    };
    const detail: RunHistoryDetail = { ...summary, events, messages };
    await this.#writeJson(this.#runFile(project.directory, id), detail);
    await this.#writeJson(this.#indexFile(project.directory), {
      ...index,
      runs: index.runs.map((run) => (run.id === id ? summary : run)),
    } satisfies HistoryIndex);
  }

  async listRuns(rootPath: string, activeRunId?: string | null): Promise<RunHistorySummary[]> {
    const project = await this.#projectStorage(rootPath);
    const index = await this.#readIndex(project.directory, project.rootPath);
    return index.runs.map((run) => normalizeInterrupted(run, activeRunId));
  }

  async getRun(
    rootPath: string,
    id: string,
    activeRunId?: string | null,
  ): Promise<RunHistoryDetail> {
    this.#validateRunId(id);
    const project = await this.#projectStorage(rootPath);
    const index = await this.#readIndex(project.directory, project.rootPath);
    if (!index.runs.some((run) => run.id === id)) {
      throw new Error("找不到对应的任务历史记录。");
    }
    try {
      const detail = JSON.parse(
        await readFile(this.#runFile(project.directory, id), "utf8"),
      ) as RunHistoryDetail;
      return normalizeInterrupted(detail, activeRunId);
    } catch (error) {
      if (isMissingFile(error)) {
        throw new Error("任务历史详情不存在。", { cause: error });
      }
      throw new Error("任务历史详情无法读取。", { cause: error });
    }
  }

  async #projectStorage(rootPath: string): Promise<{ directory: string; rootPath: string }> {
    const resolved = await realpath(rootPath);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const key = createHash("sha256").update(normalized).digest("hex");
    return { directory: path.join(this.#storageRoot, key), rootPath: resolved };
  }

  async #readIndex(directory: string, projectPath: string): Promise<HistoryIndex> {
    try {
      const parsed = JSON.parse(await readFile(this.#indexFile(directory), "utf8")) as Partial<HistoryIndex>;
      return {
        version: 1,
        projectPath,
        runs: Array.isArray(parsed.runs) ? parsed.runs.slice(0, MAX_RUNS_PER_PROJECT) : [],
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { version: 1, projectPath, runs: [] };
      }
      throw new Error("任务历史索引无法读取。", { cause: error });
    }
  }

  async #writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  }

  async #removeRunFile(directory: string, id: string): Promise<void> {
    try {
      await unlink(this.#runFile(directory, id));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  #indexFile(directory: string): string {
    return path.join(directory, "index.json");
  }

  #runFile(directory: string, id: string): string {
    return path.join(directory, `${id}.json`);
  }

  #validateRunId(id: string): void {
    if (!RUN_ID_PATTERN.test(id)) {
      throw new Error("任务历史 ID 无效。");
    }
  }
}

function normalizeInterrupted<T extends RunHistorySummary>(
  run: T,
  activeRunId?: string | null,
): T {
  return run.status === "running" && run.id !== activeRunId
    ? { ...run, status: "interrupted", summary: "应用关闭前任务未正常结束。" }
    : run;
}

function sanitizeEvent(event: AgentEvent): AgentEvent {
  return JSON.parse(
    JSON.stringify(event, (_key, value: unknown) =>
      typeof value === "string" ? value.slice(0, MAX_EVENT_STRING_CHARS) : value,
    ),
  ) as AgentEvent;
}

function sanitizeMessage(message: ChatMessage): ChatMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content.slice(0, MAX_MESSAGE_CONTENT_CHARS) };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content.slice(0, MAX_MESSAGE_CONTENT_CHARS),
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content?.slice(0, MAX_MESSAGE_CONTENT_CHARS) ?? null,
        tool_calls: message.tool_calls?.slice(0, 16).map((call) => ({
          ...call,
          function: {
            ...call.function,
            arguments: call.function.arguments.slice(0, MAX_EVENT_STRING_CHARS),
          },
        })),
      };
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
