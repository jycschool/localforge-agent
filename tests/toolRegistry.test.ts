import { describe, expect, it } from "vitest";
import { ToolExecutionError } from "../src/agent/toolErrors";
import { ToolRegistry } from "../src/agent/toolRegistry";
import type { AgentTool, ToolExecutionContext } from "../src/core/protocol";

describe("ToolRegistry structured errors", () => {
  it("preserves recoverable error codes and suggestions", async () => {
    const failingTool: AgentTool = {
      schema: {
        type: "function",
        function: { name: "edit", description: "Edit", parameters: { type: "object" } },
      },
      async execute() {
        throw new ToolExecutionError("The file changed.", {
          code: "STALE_FILE_CONTENT",
          retryable: true,
          suggestion: "Read the file again.",
          details: { path: "src/app.ts" },
        });
      },
    };

    const result = await new ToolRegistry([failingTool]).execute(
      "edit",
      {},
      executionContext(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: "The file changed.",
      code: "STALE_FILE_CONTENT",
      retryable: true,
      suggestion: "Read the file again.",
      details: { path: "src/app.ts" },
    });
  });

  it("returns an actionable error for an unknown tool", async () => {
    const result = await new ToolRegistry([]).execute("missing", {}, executionContext());

    expect(JSON.parse(result.content)).toMatchObject({
      code: "UNKNOWN_TOOL",
      retryable: true,
    });
  });
});

function executionContext(): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    requestCommandApproval: async () => true,
  };
}
