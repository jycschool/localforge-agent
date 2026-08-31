import type { AgentEvent } from "../core/protocol";

const MUTATING_TOOLS = new Set(["replace_in_file", "edit_file_lines", "write_file"]);

interface StartedTool {
  name: string;
  arguments: Record<string, unknown>;
}

export class DirectCompletionPolicy {
  private readonly startedTools = new Map<string, StartedTool>();
  private readonly pendingPaths = new Set<string>();
  private mutationRevision = 0;
  private warnedRevision = -1;
  private latestVerificationFailure: string | undefined;

  public observe(event: AgentEvent): void {
    if (event.type === "tool_started") {
      this.startedTools.set(event.id, { name: event.name, arguments: event.arguments });
      return;
    }
    if (event.type !== "tool_finished") {
      return;
    }

    const started = this.startedTools.get(event.id);
    this.startedTools.delete(event.id);
    if (!started) {
      return;
    }
    if (MUTATING_TOOLS.has(started.name) && !event.result.isError) {
      const path = pathArgument(started.arguments);
      if (path) {
        this.pendingPaths.add(normalizePath(path));
      }
      this.mutationRevision += 1;
      this.latestVerificationFailure = undefined;
      return;
    }
    if (started.name === "read_file" && !event.result.isError) {
      const path = pathArgument(started.arguments);
      if (path) {
        this.pendingPaths.delete(normalizePath(path));
      }
      return;
    }
    if (started.name === "run_command" && this.pendingPaths.size > 0) {
      if (event.result.isError) {
        this.latestVerificationFailure = toolErrorMessage(event.result.content);
      } else {
        this.pendingPaths.clear();
        this.latestVerificationFailure = undefined;
      }
    }
  }

  public completionIssue(): string | undefined {
    if (this.pendingPaths.size === 0 || this.warnedRevision === this.mutationRevision) {
      return undefined;
    }
    this.warnedRevision = this.mutationRevision;
    const paths = [...this.pendingPaths].slice(0, 5).join(", ");
    if (this.latestVerificationFailure) {
      return (
        `修改后的验证尚未成功：${this.latestVerificationFailure}。` +
        `请修复后重新验证 ${paths}；如果无法继续，下一次答复必须明确说明未通过的检查和剩余风险。`
      );
    }
    return (
      `修改后尚未验证最新内容：${paths}。` +
      "请重新读取这些文件，或运行最小相关检查；如果无法验证，下一次答复必须明确说明未验证事项。"
    );
  }
}

function pathArgument(argumentsValue: Record<string, unknown>): string | undefined {
  return typeof argumentsValue.path === "string" && argumentsValue.path.trim()
    ? argumentsValue.path.trim()
    : undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLocaleLowerCase();
}

function toolErrorMessage(content: string): string {
  try {
    const value: unknown = JSON.parse(content);
    if (isRecord(value) && typeof value.error === "string" && value.error.trim()) {
      return value.error.trim();
    }
  } catch {
    // Use the compact raw result below.
  }
  return content.replace(/\s+/g, " ").trim().slice(0, 200) || "验证工具返回错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
