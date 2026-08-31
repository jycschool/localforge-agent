import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, ChatMessage, PlanSnapshot } from "../core/protocol";
import type {
  RunHistoryDetail,
  RunOutcomeMetrics,
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
const MAX_CONTINUATION_RUNS = 12;
const MAX_CONTINUATION_MESSAGES = 48;
const MAX_CONTINUATION_CHARS = 64_000;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface HistoryIndex {
  version: 1;
  projectPath: string;
  runs: RunHistorySummary[];
}

export interface StartRunHistoryInput {
  task: string;
  selectedFile?: string;
  attachmentPaths?: readonly string[];
  skillIds?: readonly string[];
  memoryUsed?: boolean;
  model?: string;
  modelProfileName?: string;
  permissionMode?: RunHistorySummary["permissionMode"];
  responseProfile?: RunHistorySummary["responseProfile"];
  executionMode?: RunHistorySummary["executionMode"];
  continuedFromRunId?: string;
}

export interface FinishRunHistoryInput {
  status: Exclude<RunHistoryStatus, "running" | "interrupted">;
  summary: string;
  steps: number;
  events: readonly AgentEvent[];
  messages: readonly ChatMessage[];
  changedFiles: readonly string[];
  outcome?: RunOutcomeMetrics;
  plan?: PlanSnapshot;
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
      attachmentPaths: Array.from(new Set(input.attachmentPaths ?? [])).slice(0, 8),
      skillIds: Array.from(new Set(input.skillIds ?? [])).slice(0, 8),
      memoryUsed: input.memoryUsed === true,
      model: input.model?.slice(0, 200),
      modelProfileName: input.modelProfileName?.slice(0, 80),
      permissionMode: input.permissionMode,
      responseProfile: input.responseProfile,
      executionMode: input.executionMode ?? "direct",
      continuedFromRunId: input.continuedFromRunId,
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
      outcome: input.outcome ? sanitizeOutcome(input.outcome) : undefined,
      updatedAt,
    };
    const detail: RunHistoryDetail = {
      ...summary,
      events,
      messages,
      plan: input.plan ? sanitizePlan(input.plan) : undefined,
    };
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

  async deleteConversation(rootPath: string, id: string): Promise<number> {
    this.#validateRunId(id);
    const project = await this.#projectStorage(rootPath);
    const index = await this.#readIndex(project.directory, project.rootPath);
    const runsById = new Map(index.runs.map((run) => [run.id, run]));
    if (!runsById.has(id)) {
      throw new Error("找不到对应的任务历史记录。");
    }

    let rootId = id;
    const ancestors = new Set<string>();
    while (!ancestors.has(rootId)) {
      ancestors.add(rootId);
      const parentId = runsById.get(rootId)?.continuedFromRunId;
      if (!parentId || !runsById.has(parentId)) {
        break;
      }
      rootId = parentId;
    }

    const deletedIds = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of index.runs) {
        if (
          !deletedIds.has(run.id) &&
          run.continuedFromRunId &&
          deletedIds.has(run.continuedFromRunId)
        ) {
          deletedIds.add(run.id);
          changed = true;
        }
      }
    }

    await this.#writeJson(this.#indexFile(project.directory), {
      ...index,
      runs: index.runs.filter((run) => !deletedIds.has(run.id)),
    } satisfies HistoryIndex);
    await Promise.all(
      Array.from(deletedIds, (deletedId) => this.#removeRunFile(project.directory, deletedId)),
    );
    return deletedIds.size;
  }

  async getContinuationMessages(
    rootPath: string,
    id: string,
    activeRunId?: string | null,
  ): Promise<ChatMessage[]> {
    this.#validateRunId(id);
    const chain: RunHistoryDetail[] = [];
    const seen = new Set<string>();
    let nextId: string | undefined = id;

    while (nextId && chain.length < MAX_CONTINUATION_RUNS && !seen.has(nextId)) {
      seen.add(nextId);
      let detail: RunHistoryDetail;
      try {
        detail = await this.getRun(rootPath, nextId, activeRunId);
      } catch (error) {
        if (chain.length === 0) {
          throw error;
        }
        break;
      }
      if (detail.status === "running") {
        throw new Error("运行中的任务不能作为历史对话继续。");
      }
      chain.unshift(detail);
      nextId = detail.continuedFromRunId;
    }

    return trimContinuationMessages(chain.flatMap(conversationMessagesForRun));
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
  const normalized = {
    ...run,
    attachmentPaths: Array.isArray(run.attachmentPaths) ? run.attachmentPaths : [],
    memoryUsed: run.memoryUsed === true,
    executionMode: run.executionMode === "plan" ? "plan" : "direct",
  };
  return (normalized.status === "running" && normalized.id !== activeRunId
    ? { ...normalized, status: "interrupted", summary: "应用关闭前任务未正常结束。" }
    : normalized) as T;
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

function sanitizePlan(plan: PlanSnapshot): PlanSnapshot {
  return {
    revision: Math.max(1, Math.trunc(plan.revision)),
    state: plan.state,
    explanation: plan.explanation.slice(0, 600),
    items: plan.items.slice(0, 12).map((item) => ({
      id: item.id.slice(0, 160),
      title: item.title.slice(0, 160),
      status: item.status,
    })),
    verification: plan.verification.slice(0, 12).map((item) => item.slice(0, 300)),
    remaining: plan.remaining.slice(0, 12).map((item) => item.slice(0, 300)),
  };
}

function sanitizeOutcome(outcome: RunOutcomeMetrics): RunOutcomeMetrics {
  const whole = (value: number): number => Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  return {
    changedFileCount: whole(outcome.changedFileCount),
    additions: whole(outcome.additions),
    deletions: whole(outcome.deletions),
    lineStatsEstimated: outcome.lineStatsEstimated === true,
    toolCalls: whole(outcome.toolCalls),
    commandCalls: whole(outcome.commandCalls),
    rejectedCommandCalls: whole(outcome.rejectedCommandCalls ?? 0),
    successfulToolCalls: whole(outcome.successfulToolCalls),
    failedToolCalls: whole(outcome.failedToolCalls),
    toolDurationMs: whole(outcome.toolDurationMs),
    testCount: outcome.testCount === undefined ? undefined : whole(outcome.testCount),
    tokenUsage: outcome.tokenUsage
      ? {
          promptTokens: whole(outcome.tokenUsage.promptTokens),
          completionTokens: whole(outcome.tokenUsage.completionTokens),
          totalTokens: whole(outcome.tokenUsage.totalTokens),
          estimated: outcome.tokenUsage.estimated === true,
        }
      : undefined,
  };
}

function conversationMessagesForRun(run: RunHistoryDetail): ChatMessage[] {
  let lastUserIndex = -1;
  for (let index = run.messages.length - 1; index >= 0; index -= 1) {
    if (run.messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const messages = lastUserIndex >= 0 ? run.messages.slice(lastUserIndex) : [];
  const userMessage = messages.find(
    (message): message is Extract<ChatMessage, { role: "user" }> => message.role === "user",
  );
  const result: ChatMessage[] = [
    { role: "user", content: userMessage?.content.trim() || run.task },
  ];
  let lastAssistantText = "";
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content?.trim();
    if (!content || content === lastAssistantText) {
      continue;
    }
    result.push({ role: "assistant", content });
    lastAssistantText = content;
  }
  const summary = run.summary.trim();
  if (summary && summary !== "任务正在运行。" && summary !== lastAssistantText) {
    result.push({ role: "assistant", content: summary });
  }
  return result;
}

function trimContinuationMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const retained: ChatMessage[] = [];
  let retainedChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const content = message.content?.trim();
    if (!content) {
      continue;
    }
    if (
      retained.length >= MAX_CONTINUATION_MESSAGES ||
      (retained.length > 0 && retainedChars + content.length > MAX_CONTINUATION_CHARS)
    ) {
      break;
    }
    retained.unshift({ role: message.role, content });
    retainedChars += content.length;
  }
  while (retained[0]?.role === "assistant") {
    retained.shift();
  }
  return retained;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
