import { describe, expect, it } from "vitest";
import { DirectCompletionPolicy } from "../src/agent/completionPolicy";
import type { AgentEvent, ToolResult } from "../src/core/protocol";

describe("DirectCompletionPolicy", () => {
  it("blocks final completion once until a changed file is read back", () => {
    const policy = new DirectCompletionPolicy();
    observeTool(policy, "write-1", "write_file", { path: "src/app.ts" }, { content: "{}" });

    expect(policy.completionIssue()).toContain("src/app.ts");
    expect(policy.completionIssue()).toBeUndefined();

    observeTool(policy, "read-1", "read_file", { path: "src/app.ts" }, { content: "{}" });
    expect(policy.completionIssue()).toBeUndefined();
  });

  it("accepts a successful command as verification for all pending changes", () => {
    const policy = new DirectCompletionPolicy();
    observeTool(policy, "edit-1", "edit_file_lines", { path: "src/a.ts" }, { content: "{}" });
    observeTool(policy, "edit-2", "replace_in_file", { path: "src/b.ts" }, { content: "{}" });
    observeTool(policy, "test-1", "run_command", { command: "pnpm test" }, { content: "{}" });

    expect(policy.completionIssue()).toBeUndefined();
  });

  it("reports a failed verification and allows a later honest final response", () => {
    const policy = new DirectCompletionPolicy();
    observeTool(policy, "edit-1", "replace_in_file", { path: "src/a.ts" }, { content: "{}" });
    observeTool(
      policy,
      "test-1",
      "run_command",
      { command: "pnpm test" },
      { content: JSON.stringify({ error: "Tests failed." }), isError: true },
    );

    expect(policy.completionIssue()).toContain("Tests failed");
    expect(policy.completionIssue()).toBeUndefined();
  });
});

function observeTool(
  policy: DirectCompletionPolicy,
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  result: ToolResult,
): void {
  policy.observe({ type: "tool_started", id, name, arguments: argumentsValue });
  policy.observe({ type: "tool_finished", id, name, result, durationMs: 1 });
}
