import type { AgentEvent, TokenUsage } from "../core/protocol";
import type { ChangedFileSnapshot, RunOutcomeMetrics } from "./contracts";

const EXACT_DIFF_CELL_LIMIT = 250_000;

export function summarizeRunOutcome(
  events: readonly AgentEvent[],
  changes: readonly ChangedFileSnapshot[],
): RunOutcomeMetrics {
  let toolCalls = 0;
  let commandCalls = 0;
  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let toolDurationMs = 0;
  let testCount: number | undefined;
  let tokenUsage: TokenUsage | undefined;

  for (const event of events) {
    if (event.type === "tool_started") {
      toolCalls += 1;
      if (event.name === "run_command") {
        commandCalls += 1;
      }
      continue;
    }
    if (event.type === "tool_finished") {
      toolDurationMs += Math.max(0, event.durationMs);
      if (event.result.isError) {
        failedToolCalls += 1;
      } else {
        successfulToolCalls += 1;
        if (event.name === "run_command") {
          const detected = detectPassedTestCount(event.result.content);
          testCount = detected === undefined
            ? testCount
            : Math.max(testCount ?? 0, detected);
        }
      }
      continue;
    }
    if (event.type === "model_usage") {
      tokenUsage = {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        estimated: event.estimated,
      };
    }
  }

  let additions = 0;
  let deletions = 0;
  let lineStatsEstimated = false;
  for (const change of changes) {
    const stats = changedLineCounts(change.originalContent ?? "", change.currentContent);
    additions += stats.additions;
    deletions += stats.deletions;
    lineStatsEstimated ||= stats.estimated;
  }

  return {
    changedFileCount: changes.length,
    additions,
    deletions,
    lineStatsEstimated,
    toolCalls,
    commandCalls,
    successfulToolCalls,
    failedToolCalls,
    toolDurationMs,
    testCount,
    tokenUsage,
  };
}

export function changedLineCounts(
  originalContent: string,
  currentContent: string,
): { additions: number; deletions: number; estimated: boolean } {
  if (originalContent === currentContent) {
    return { additions: 0, deletions: 0, estimated: false };
  }
  const original = splitLines(originalContent);
  const current = splitLines(currentContent);
  const estimated = original.length * current.length > EXACT_DIFF_CELL_LIMIT;
  const common = estimated
    ? sharedBoundaryLineCount(original, current)
    : longestCommonSubsequenceLength(original, current);
  return {
    additions: Math.max(0, current.length - common),
    deletions: Math.max(0, original.length - common),
    estimated,
  };
}

export function detectPassedTestCount(raw: string): number | undefined {
  const text = commandResultText(raw);
  const patterns = [
    /Tests?\s*:?\s*(\d+)\s+passed/gi,
    /(\d+)\s+tests?\s+passed/gi,
    /#\s*pass\s+(\d+)/gi,
  ];
  let detected: number | undefined;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value >= 0) {
        detected = Math.max(detected ?? 0, value);
      }
    }
  }
  return detected;
}

export function replayFrameDelay(eventCount: number): number {
  if (eventCount <= 0) return 0;
  return Math.max(45, Math.min(520, Math.round(6_000 / eventCount)));
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function longestCommonSubsequenceLength(left: readonly string[], right: readonly string[]): number {
  const previous = new Uint32Array(right.length + 1);
  const current = new Uint32Array(right.length + 1);
  for (const leftLine of left) {
    current.fill(0);
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftLine === right[index - 1]
        ? (previous[index - 1] ?? 0) + 1
        : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    previous.set(current);
  }
  return previous[right.length] ?? 0;
}

function sharedBoundaryLineCount(left: readonly string[], right: readonly string[]): number {
  const shorterLength = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < shorterLength && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorterLength - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return prefix + suffix;
}

function commandResultText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return [parsed.stdout, parsed.stderr, parsed.status]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  } catch {
    return raw;
  }
}
