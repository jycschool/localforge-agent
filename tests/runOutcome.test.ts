import { describe, expect, it } from "vitest";
import {
  changedLineCounts,
  commandApprovalState,
  detectPassedTestCount,
  replayFrameDelay,
  summarizeRunOutcome,
} from "../src/desktop/runOutcome";

describe("run outcome presentation", () => {
  it("summarizes tools, tests, tokens and changed lines from observable evidence", () => {
    const outcome = summarizeRunOutcome([
      { type: "tool_started", id: "read", name: "read_file", arguments: { path: "a.ts" } },
      { type: "tool_finished", id: "read", name: "read_file", result: { content: "ok" }, durationMs: 4 },
      { type: "tool_started", id: "test", name: "run_command", arguments: { command: "pnpm test" } },
      {
        type: "tool_finished",
        id: "test",
        name: "run_command",
        result: { content: JSON.stringify({ approved: true, stdout: "Tests  130 passed", stderr: "" }) },
        durationMs: 96,
      },
      { type: "model_usage", step: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120, estimated: false },
    ], [{
      relativePath: "a.ts",
      originalContent: "a\nb\n",
      currentContent: "a\nc\nd\n",
      currentHash: "hash",
    }]);

    expect(outcome).toMatchObject({
      changedFileCount: 1,
      additions: 2,
      deletions: 1,
      toolCalls: 2,
      commandCalls: 1,
      rejectedCommandCalls: 0,
      successfulToolCalls: 2,
      failedToolCalls: 0,
      toolDurationMs: 100,
      testCount: 130,
      tokenUsage: { totalTokens: 120, estimated: false },
    });
  });

  it("separates rejected command requests from commands that actually ran", () => {
    const outcome = summarizeRunOutcome([
      { type: "tool_started", id: "reject", name: "run_command", arguments: { command: "pnpm test" } },
      {
        type: "tool_finished",
        id: "reject",
        name: "run_command",
        result: { content: JSON.stringify({ approved: false, error: "User rejected the command." }), isError: true },
        durationMs: 8,
      },
    ], []);

    expect(outcome.commandCalls).toBe(0);
    expect(outcome.rejectedCommandCalls).toBe(1);
    expect(commandApprovalState("not json")).toBeUndefined();
  });

  it("handles test output variants and keeps replay near six seconds", () => {
    expect(detectPassedTestCount("Tests: 12 passed, 12 total")).toBe(12);
    expect(detectPassedTestCount("# pass 6")).toBe(6);
    expect(changedLineCounts("same\n", "same\n")).toEqual({ additions: 0, deletions: 0, estimated: false });
    expect(replayFrameDelay(20)).toBe(300);
    expect(replayFrameDelay(200)).toBe(45);
  });
});
