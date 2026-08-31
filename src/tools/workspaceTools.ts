import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolResult,
} from "../core/protocol";
import { ChangeTracker } from "../agent/changeTracker";
import { ToolExecutionError } from "../agent/toolErrors";

export interface WorkspaceToolOptions {
  rootPath: string;
  changeTracker: ChangeTracker;
  commandTimeoutMs: number;
  maxOutputChars: number;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  ".vscode-test",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);
const MAX_TOOL_FILE_BYTES = 1_000_000;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;

export async function createWorkspaceTools(options: WorkspaceToolOptions): Promise<AgentTool[]> {
  const rootRealPath = await realpath(options.rootPath);
  const resolver = new WorkspacePathResolver(rootRealPath);

  return [
    createListFilesTool(resolver, options.maxOutputChars),
    createSearchTextTool(resolver, options.maxOutputChars),
    createReadFileTool(resolver, options.maxOutputChars),
    createReplaceFileTool(resolver, options.changeTracker),
    createEditFileLinesTool(resolver, options.changeTracker),
    createWriteFileTool(resolver, options.changeTracker),
    createRunCommandTool(rootRealPath, options.commandTimeoutMs, options.maxOutputChars),
  ];
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

class WorkspacePathResolver {
  public constructor(private readonly rootRealPath: string) {}

  public async existing(relativePath: string): Promise<{ absolutePath: string; relativePath: string }> {
    const candidate = this.lexical(relativePath);
    let candidateRealPath: string;
    try {
      candidateRealPath = await realpath(candidate.absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new ToolExecutionError(`Workspace file does not exist: ${candidate.relativePath}`, {
          code: "FILE_NOT_FOUND",
          retryable: true,
          suggestion: "Use list_files or search_text to locate the current project-relative path.",
          details: { path: candidate.relativePath },
        });
      }
      throw error;
    }
    if (!isPathInside(this.rootRealPath, candidateRealPath)) {
      throw new ToolExecutionError(`Path resolves outside the workspace: ${relativePath}`, {
        code: "PATH_OUTSIDE_WORKSPACE",
        retryable: false,
      });
    }
    return { absolutePath: candidateRealPath, relativePath: candidate.relativePath };
  }

  public async writable(relativePath: string): Promise<{ absolutePath: string; relativePath: string }> {
    const candidate = this.lexical(relativePath);
    try {
      const candidateRealPath = await realpath(candidate.absolutePath);
      if (!isPathInside(this.rootRealPath, candidateRealPath)) {
        throw new ToolExecutionError(`Path resolves outside the workspace: ${relativePath}`, {
          code: "PATH_OUTSIDE_WORKSPACE",
          retryable: false,
        });
      }
      return { absolutePath: candidateRealPath, relativePath: candidate.relativePath };
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    const parent = await nearestExistingParent(path.dirname(candidate.absolutePath));
    const parentRealPath = await realpath(parent);
    if (!isPathInside(this.rootRealPath, parentRealPath)) {
      throw new ToolExecutionError(`Path resolves outside the workspace: ${relativePath}`, {
        code: "PATH_OUTSIDE_WORKSPACE",
        retryable: false,
      });
    }
    return candidate;
  }

  public root(): string {
    return this.rootRealPath;
  }

  private lexical(relativePath: string): { absolutePath: string; relativePath: string } {
    if (!relativePath.trim()) {
      throw new ToolExecutionError("A non-empty workspace-relative path is required.", {
        code: "INVALID_TOOL_ARGUMENT",
        retryable: true,
        suggestion: "Supply a path returned by list_files or search_text.",
      });
    }
    if (path.isAbsolute(relativePath)) {
      throw new ToolExecutionError("Absolute paths are not allowed.", {
        code: "ABSOLUTE_PATH_NOT_ALLOWED",
        retryable: true,
        suggestion: "Use a project-relative path such as src/main.ts.",
      });
    }
    const absolutePath = path.resolve(this.rootRealPath, relativePath);
    if (!isPathInside(this.rootRealPath, absolutePath)) {
      throw new ToolExecutionError(`Path is outside the workspace: ${relativePath}`, {
        code: "PATH_OUTSIDE_WORKSPACE",
        retryable: false,
      });
    }
    return {
      absolutePath,
      relativePath: normalizeRelative(path.relative(this.rootRealPath, absolutePath)),
    };
  }
}

function createListFilesTool(resolver: WorkspacePathResolver, maxOutputChars: number): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_files",
        description: "列出项目中的文件路径。用于先定位结构；结果可能受 limit 截断，不会返回文件内容。",
        parameters: {
          type: "object",
          properties: {
            glob: { type: "string", minLength: 1, description: "项目相对的 glob，例如 src/**/*.ts；默认 **/*。" },
            limit: { type: "integer", minimum: 1, maximum: 500, description: "最多返回多少个路径，默认 200。" },
          },
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue, context) {
      const pattern = optionalString(argumentsValue, "glob") ?? "**/*";
      const limit = optionalInteger(argumentsValue, "limit", 1, 500) ?? 200;
      const matcher = globMatcher(pattern);
      const files: string[] = [];
      await walkFiles(resolver.root(), async (absolutePath, relativePath) => {
        if (matcher(relativePath)) {
          files.push(relativePath);
        }
        return files.length < limit;
      }, context.signal);
      const payload = { files, count: files.length, limited: files.length >= limit };
      return textResult(payload, maxOutputChars);
    },
  };
}

function createSearchTextTool(resolver: WorkspacePathResolver, maxOutputChars: number): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "search_text",
        description: "在项目 UTF-8 文本文件中做区分大小写的字面量搜索，返回路径、行号和片段；不会把 query 当正则表达式。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1, description: "要查找的原样文本。" },
            include: { type: "string", minLength: 1, description: "可选项目相对 glob，例如 src/**/*.ts。" },
            limit: { type: "integer", minimum: 1, maximum: 200, description: "最多返回多少处匹配，默认 80。" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue, context) {
      const query = requiredString(argumentsValue, "query");
      const include = optionalString(argumentsValue, "include") ?? "**/*";
      const limit = optionalInteger(argumentsValue, "limit", 1, 200) ?? 80;
      const matcher = globMatcher(include);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      await walkFiles(resolver.root(), async (absolutePath, relativePath) => {
        if (!matcher(relativePath)) {
          return;
        }
        let content: string;
        try {
          const info = await stat(absolutePath);
          if (info.size > 1_000_000) {
            return;
          }
          content = await readFile(absolutePath, "utf8");
        } catch {
          return;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
          const line = lines[index] ?? "";
          if (line.includes(query)) {
            matches.push({ path: relativePath, line: index + 1, text: line.slice(0, 400) });
          }
        }
        return matches.length < limit;
      }, context.signal);
      return textResult({ matches, count: matches.length, limited: matches.length >= limit }, maxOutputChars);
    },
  };
}

function createReadFileTool(resolver: WorkspacePathResolver, maxOutputChars: number): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description: "读取一个项目内 UTF-8 文本文件，可限定首尾行；返回内容带 1 起始行号。读取前应通过已知路径或 list_files/search_text 定位。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "项目相对路径，例如 src/main.ts；不要传绝对路径。" },
            startLine: { type: "integer", minimum: 1, description: "可选起始行，包含该行。" },
            endLine: { type: "integer", minimum: 1, description: "可选结束行，包含该行。" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue) {
      const target = await resolver.existing(requiredString(argumentsValue, "path"));
      const startLine = optionalInteger(argumentsValue, "startLine", 1) ?? 1;
      const endLine = optionalInteger(argumentsValue, "endLine", 1) ?? Number.MAX_SAFE_INTEGER;
      if (endLine < startLine) {
        throw new Error("endLine must be greater than or equal to startLine.");
      }
      const content = await readUtf8FileWithinLimit(target.absolutePath);
      const lines = content.split(/\r?\n/);
      const selected = lines
        .slice(startLine - 1, Math.min(endLine, lines.length))
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n");
      return textResult(
        {
          path: target.relativePath,
          startLine,
          endLine: Math.min(endLine, lines.length),
          totalLines: lines.length,
          hash: hashText(content),
          content: selected,
        },
        maxOutputChars,
      );
    },
  };
}

function createReplaceFileTool(resolver: WorkspacePathResolver, tracker: ChangeTracker): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "replace_in_file",
        description: "在已有项目文件中精确替换唯一一处字面量。oldText 必须只出现一次；适合小范围安全编辑，并保留未涉及内容。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "已有文件的项目相对路径。" },
            oldText: { type: "string", minLength: 1, description: "必须与文件中唯一一处内容完全一致，包括空格和换行。" },
            newText: { type: "string", description: "替换后的完整文本；允许空字符串表示删除。" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue) {
      const target = await resolver.existing(requiredString(argumentsValue, "path"));
      const oldText = requiredString(argumentsValue, "oldText", true);
      const newText = requiredString(argumentsValue, "newText", true);
      if (oldText.length === 0) {
        throw new ToolExecutionError("oldText cannot be empty.", {
          code: "INVALID_TOOL_ARGUMENT",
          retryable: true,
          suggestion: "Read the relevant file section and provide a non-empty exact oldText value.",
        });
      }
      const current = await readUtf8FileWithinLimit(target.absolutePath);
      const occurrences = current.split(oldText).length - 1;
      if (occurrences !== 1) {
        throw new ToolExecutionError(
          `Expected oldText exactly once, found ${occurrences} occurrences.`,
          {
            code: occurrences === 0 ? "REPLACE_TEXT_NOT_FOUND" : "REPLACE_MATCH_NOT_UNIQUE",
            retryable: true,
            suggestion: occurrences === 0
              ? "Read the latest relevant lines and copy the exact current text before retrying."
              : "Use a longer surrounding oldText value or edit_file_lines with the latest file hash.",
            details: { path: target.relativePath, matchCount: occurrences },
          },
        );
      }
      const updated = current.replace(oldText, newText);
      tracker.capture(target.relativePath, current);
      await writeFile(target.absolutePath, updated, "utf8");
      return {
        content: JSON.stringify({
          path: target.relativePath,
          replacements: 1,
          beforeHash: hashText(current),
          afterHash: hashText(updated),
        }),
      };
    },
  };
}

function createEditFileLinesTool(resolver: WorkspacePathResolver, tracker: ChangeTracker): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "edit_file_lines",
        description:
          "按 1 起始的行范围安全替换已有 UTF-8 文件的一段内容。必须传入最近一次 read_file 返回的完整文件 hash；适合精确文本替换不稳定时的小范围编辑。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "已有文件的项目相对路径。" },
            startLine: { type: "integer", minimum: 1, description: "要替换的起始行，包含该行。" },
            endLine: { type: "integer", minimum: 1, description: "要替换的结束行，包含该行。" },
            expectedHash: {
              type: "string",
              minLength: 64,
              maxLength: 64,
              description: "最近一次 read_file 返回的完整文件 SHA-256 hash。",
            },
            replacement: {
              type: "string",
              description: "替换范围的新文本；空字符串表示删除这些行。",
            },
          },
          required: ["path", "startLine", "endLine", "expectedHash", "replacement"],
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue) {
      const target = await resolver.existing(requiredString(argumentsValue, "path"));
      const startLine = requiredInteger(argumentsValue, "startLine", 1);
      const endLine = requiredInteger(argumentsValue, "endLine", 1);
      const expectedHash = requiredString(argumentsValue, "expectedHash");
      const replacement = requiredString(argumentsValue, "replacement", true);
      if (!/^[a-f0-9]{64}$/i.test(expectedHash)) {
        throw new ToolExecutionError("expectedHash must be a 64-character SHA-256 value.", {
          code: "INVALID_TOOL_ARGUMENT",
          retryable: true,
          suggestion: "Call read_file for the target file and reuse its returned hash.",
        });
      }
      if (endLine < startLine) {
        throw new ToolExecutionError("endLine must be greater than or equal to startLine.", {
          code: "INVALID_LINE_RANGE",
          retryable: true,
          suggestion: "Use a line range from the latest numbered read_file output.",
        });
      }
      const current = await readUtf8FileWithinLimit(target.absolutePath);
      const beforeHash = hashText(current);
      if (beforeHash !== expectedHash.toLowerCase()) {
        throw new ToolExecutionError("The file changed after it was read; the supplied hash is stale.", {
          code: "STALE_FILE_CONTENT",
          retryable: true,
          suggestion: "Read the file again, review the latest lines, and retry with the new hash.",
          details: { path: target.relativePath, currentHash: beforeHash },
        });
      }
      const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
      const lines = current.split(/\r\n|\n/);
      if (startLine > lines.length || endLine > lines.length) {
        throw new ToolExecutionError(
          `Line range ${startLine}-${endLine} exceeds the file's ${lines.length} lines.`,
          {
            code: "INVALID_LINE_RANGE",
            retryable: true,
            suggestion: "Use line numbers from the latest read_file result.",
            details: { path: target.relativePath, totalLines: lines.length },
          },
        );
      }
      const replacementLines = replacement.length === 0
        ? []
        : replacement.replace(/\r\n|\r|\n/g, "\n").split("\n");
      lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
      const updated = lines.join(lineEnding);
      if (Buffer.byteLength(updated, "utf8") > MAX_TOOL_FILE_BYTES) {
        throw new ToolExecutionError("Edited file exceeds the 1 MB workspace tool limit.", {
          code: "FILE_TOO_LARGE",
          retryable: true,
          suggestion: "Reduce the replacement size or split the content into a more appropriate file.",
        });
      }
      tracker.capture(target.relativePath, current);
      await writeFile(target.absolutePath, updated, "utf8");
      return {
        content: JSON.stringify({
          path: target.relativePath,
          startLine,
          endLine,
          insertedLines: replacementLines.length,
          beforeHash,
          afterHash: hashText(updated),
        }),
      };
    },
  };
}

function createWriteFileTool(resolver: WorkspacePathResolver, tracker: ChangeTracker): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description: "新建或完整覆盖一个项目内 UTF-8 文件。覆盖会替换整个文件；修改已有大文件时优先使用 replace_in_file。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "项目相对路径；父目录不存在时会自动创建。" },
            content: { type: "string", description: "文件的完整最终内容，不是补丁或片段。" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue) {
      const target = await resolver.writable(requiredString(argumentsValue, "path"));
      const content = requiredString(argumentsValue, "content", true);
      if (Buffer.byteLength(content, "utf8") > MAX_TOOL_FILE_BYTES) {
        throw new ToolExecutionError("File content exceeds the 1 MB workspace tool limit.", {
          code: "FILE_TOO_LARGE",
          retryable: true,
          suggestion: "Reduce the file size or split the content into smaller files.",
        });
      }
      let original: string | null = null;
      try {
        original = await readUtf8FileWithinLimit(target.absolutePath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      tracker.capture(target.relativePath, original);
      await mkdir(path.dirname(target.absolutePath), { recursive: true });
      await writeFile(target.absolutePath, content, "utf8");
      return {
        content: JSON.stringify({
          path: target.relativePath,
          created: original === null,
          characters: content.length,
          beforeHash: original === null ? null : hashText(original),
          afterHash: hashText(content),
        }),
      };
    },
  };
}

function createRunCommandTool(rootPath: string, timeoutMs: number, maxOutputChars: number): AgentTool {
  return {
    schema: {
      type: "function",
      function: {
        name: "run_command",
        description: "经用户单独批准后，在项目根目录运行一条本地 shell 命令。用于构建、测试、格式化或必要诊断；不要用它代替已有文件工具。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", minLength: 1, description: "要在项目根目录执行的完整命令。避免交互式或长期驻留命令。" },
            reason: { type: "string", minLength: 1, description: "展示给用户的简短中文说明：为什么需要执行、将验证什么。" },
          },
          required: ["command", "reason"],
          additionalProperties: false,
        },
      },
    },
    async execute(argumentsValue, context) {
      const command = requiredString(argumentsValue, "command");
      const reason = requiredString(argumentsValue, "reason");
      const approvalId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const approvalStartedAt = Date.now();
      const approved = await context.requestCommandApproval({
        id: approvalId,
        command,
        reason,
        cwd: rootPath,
      });
      const approvalDurationMs = Date.now() - approvalStartedAt;
      if (!approved) {
        return {
          content: JSON.stringify({
            approved: false,
            approvalDurationMs,
            error: "User rejected the command.",
            code: "COMMAND_REJECTED",
            retryable: false,
            suggestion: "Do not retry the same command. Continue without it or explain what remains unverified.",
          }),
          isError: true,
        };
      }
      return runCommand(
        command,
        rootPath,
        timeoutMs,
        maxOutputChars,
        approvalDurationMs,
        context,
      );
    },
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  approvalDurationMs: number,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (context.signal.aborted) {
    throw new DOMException("The command was aborted.", "AbortError");
  }
  return new Promise<ToolResult>((resolve, reject) => {
    const executionStartedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: commandEnvironment(),
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let stopping = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, stdoutDecoder.write(chunk), maxOutputChars);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, stderrDecoder.write(chunk), maxOutputChars);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });

    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      void terminateProcessTree(child);
    };
    const onAbort = (): void => stop();
    context.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    if (context.signal.aborted) {
      stop();
    }

    child.on("error", (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      if (settled) {
        return;
      }
      const stdoutEnd = appendBounded(stdout, stdoutDecoder.end(), maxOutputChars);
      const stderrEnd = appendBounded(stderr, stderrDecoder.end(), maxOutputChars);
      stdout = stdoutEnd.value;
      stderr = stderrEnd.value;
      stdoutTruncated ||= stdoutEnd.truncated;
      stderrTruncated ||= stderrEnd.truncated;
      settled = true;
      if (context.signal.aborted) {
        reject(new DOMException("The command was aborted.", "AbortError"));
        return;
      }
      const isError = timedOut || exitCode !== 0;
      resolve({
        content: JSON.stringify({
          approved: true,
          command,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          outputTruncated: stdoutTruncated || stderrTruncated,
          approvalDurationMs,
          executionDurationMs: Date.now() - executionStartedAt,
          ...(isError
            ? {
                error: timedOut
                  ? `Command timed out after ${timeoutMs} ms.`
                  : `Command exited with code ${exitCode}.`,
                code: timedOut ? "COMMAND_TIMEOUT" : "COMMAND_FAILED",
                retryable: true,
                suggestion: timedOut
                  ? "Choose a bounded non-interactive command or increase the configured timeout if justified."
                  : "Inspect stdout and stderr, fix the reported cause, then run the smallest relevant verification again.",
              }
            : {}),
        }),
        isError,
      });
    });

    function cleanup(): void {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    }
  });
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)),
  );
}

async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function appendBounded(
  current: string,
  next: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const combined = current + next;
  return combined.length > maximum
    ? { value: combined.slice(-maximum), truncated: true }
    : { value: combined, truncated: false };
}

async function walkFiles(
  rootPath: string,
  visit: (absolutePath: string, relativePath: string) => Promise<boolean | void>,
  signal: AbortSignal,
): Promise<void> {
  async function walk(directory: string): Promise<boolean> {
    throwIfAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !(await walk(absolutePath))) {
          return false;
        }
      } else if (entry.isFile()) {
        const shouldContinue = await visit(
          absolutePath,
          normalizeRelative(path.relative(rootPath, absolutePath)),
        );
        if (shouldContinue === false) {
          return false;
        }
      }
    }
    return true;
  }
  await walk(rootPath);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The workspace traversal was aborted.", "AbortError");
  }
}

async function readUtf8FileWithinLimit(absolutePath: string): Promise<string> {
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new ToolExecutionError("The workspace path is not a file.", {
      code: "PATH_NOT_FILE",
      retryable: true,
      suggestion: "Choose a regular file path returned by list_files.",
    });
  }
  if (info.size > MAX_TOOL_FILE_BYTES) {
    throw new ToolExecutionError("File exceeds the 1 MB workspace tool limit.", {
      code: "FILE_TOO_LARGE",
      retryable: false,
      details: { bytes: info.size, limitBytes: MAX_TOOL_FILE_BYTES },
    });
  }
  return readFile(absolutePath, "utf8");
}

function globMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = normalizeRelative(pattern.trim() || "**/*");
  const regexes = [compileGlob(normalized)];
  if (normalized.startsWith("**/")) {
    regexes.push(compileGlob(normalized.slice(3)));
  }
  return (relativePath) => regexes.some((regex) => regex.test(normalizeRelative(relativePath)));
}

function compileGlob(pattern: string): RegExp {
  let regexSource = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      regexSource += ".*";
      index += 1;
    } else if (character === "*") {
      regexSource += "[^/]*";
    } else if (character === "?") {
      regexSource += "[^/]";
    } else {
      regexSource += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regexSource}$`, process.platform === "win32" ? "i" : "");
}

async function nearestExistingParent(startPath: string): Promise<string> {
  let current = startPath;
  while (true) {
    try {
      await access(current, fsConstants.F_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`No existing parent directory for ${startPath}`);
      }
      current = parent;
    }
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const result = value[key];
  if (typeof result !== "string" || (!allowEmpty && !result.trim())) {
    throw new ToolExecutionError(
      `${key} must be ${allowEmpty ? "a string" : "a non-empty string"}.`,
      {
        code: "INVALID_TOOL_ARGUMENT",
        retryable: true,
        suggestion: `Correct the ${key} argument using the current tool schema.`,
      },
    );
  }
  return result;
}

function requiredInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
): number {
  const result = value[key];
  if (!Number.isInteger(result) || (result as number) < minimum) {
    throw new ToolExecutionError(`${key} must be an integer greater than or equal to ${minimum}.`, {
      code: "INVALID_TOOL_ARGUMENT",
      retryable: true,
      suggestion: `Correct the ${key} argument using the latest file metadata.`,
    });
  }
  return result as number;
}

function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return result;
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const result = value[key];
  if (result === undefined) {
    return undefined;
  }
  if (!Number.isInteger(result) || typeof result !== "number" || result < minimum || result > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function textResult(value: unknown, maxOutputChars: number): ToolResult {
  const content = JSON.stringify(value);
  if (content.length <= maxOutputChars) {
    return { content };
  }
  return {
    content: JSON.stringify({
      truncated: true,
      originalCharacters: content.length,
      tail: content.slice(-maxOutputChars),
    }),
  };
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
