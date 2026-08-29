import { changedLineCounts, detectPassedTestCount } from "../../desktop/runOutcome";
import type { ChangedFileSnapshot } from "../../desktop/contracts";

export interface ChangeEvidence {
  kind: "added" | "modified";
  additions: number;
  deletions: number;
  estimated: boolean;
}

export interface TestEvidence {
  passed: number;
  failed: number;
  total: number;
}

export interface CommandEvidence {
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  state: "success" | "error" | "rejected";
  timedOut: boolean;
  outputTruncated: boolean;
  approvalDurationMs: number;
  executionDurationMs: number;
  test?: TestEvidence;
}

export function changeEvidence(change: ChangedFileSnapshot): ChangeEvidence {
  const stats = changedLineCounts(change.originalContent ?? "", change.currentContent);
  return {
    kind: change.originalContent === null ? "added" : "modified",
    additions: stats.additions,
    deletions: stats.deletions,
    estimated: stats.estimated,
  };
}

export function parseCommandEvidence(
  raw: string,
  fallbackCommand: string,
  isError: boolean,
  fallbackDurationMs: number,
): CommandEvidence {
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) value = parsed;
  } catch {
    // A compatible tool may return plain text; preserve it as stdout.
  }

  const command = stringValue(value?.command) || fallbackCommand;
  const stdout = stringValue(value?.stdout) || (value ? "" : raw);
  const stderr = stringValue(value?.stderr);
  const exitCode = finiteInteger(value?.exitCode);
  const rejected = value?.approved === false;
  const timedOut = value?.timedOut === true;
  const state = rejected ? "rejected" : isError || timedOut || (exitCode !== undefined && exitCode !== 0)
    ? "error"
    : "success";
  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n");

  return {
    command,
    stdout,
    stderr,
    exitCode,
    state,
    timedOut,
    outputTruncated: value?.outputTruncated === true,
    approvalDurationMs: nonNegativeNumber(value?.approvalDurationMs),
    executionDurationMs: nonNegativeNumber(value?.executionDurationMs) || Math.max(0, fallbackDurationMs),
    test: detectTestEvidence(command, combinedOutput),
  };
}

export function detectTestEvidence(command: string, output: string): TestEvidence | undefined {
  const passed = detectPassedTestCount(output);
  const failed = largestMatch(output, [
    /#\s*fail\s+(\d+)/gi,
    /Tests?\s*:?[\s\S]{0,80}?(\d+)\s+failed/gi,
    /(\d+)\s+tests?\s+failed/gi,
    /(\d+)\s+failing\b/gi,
  ]);
  const reportedTotal = largestMatch(output, [
    /#\s*tests\s+(\d+)/gi,
    /Tests?\s*:?[\s\S]{0,100}?(\d+)\s+total/gi,
  ]);
  const looksLikeTest = /(?:^|\s)(?:pnpm\s+test|npm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|$)/i.test(command);

  if (passed === undefined && failed === undefined) return undefined;
  if (!looksLikeTest && reportedTotal === undefined) return undefined;

  const normalizedPassed = passed ?? 0;
  const normalizedFailed = failed ?? 0;
  return {
    passed: normalizedPassed,
    failed: normalizedFailed,
    total: Math.max(reportedTotal ?? 0, normalizedPassed + normalizedFailed),
  };
}

export function testEvidenceProgress(test: TestEvidence): number {
  return test.total > 0 ? Math.max(0, Math.min(100, (test.passed / test.total) * 100)) : 0;
}

function largestMatch(text: string, patterns: readonly RegExp[]): number | undefined {
  let found: number | undefined;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value >= 0) found = Math.max(found ?? 0, value);
    }
  }
  return found;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
