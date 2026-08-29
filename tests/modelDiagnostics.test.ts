import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../src/core/protocol";
import { diagnoseModel } from "../src/model/modelDiagnostics";

describe("model diagnostics", () => {
  it("checks text, streaming, usage, and tool calling", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    complete.mockImplementationOnce(async (_messages, _tools, _signal, onDelta, onUsage) => {
      onDelta?.("RepoForge OK");
      onUsage?.({ promptTokens: 10, completionTokens: 3, totalTokens: 13, estimated: false });
      return { role: "assistant", content: "RepoForge OK" };
    });
    complete.mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "probe-1",
        type: "function",
        function: { name: "localforge_health_check", arguments: "{\"probe\":\"ping\"}" },
      }],
    });

    const result = await diagnoseModel({ complete }, "test-model", new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "streaming", status: "passed" }),
      expect.objectContaining({ id: "usage", status: "passed" }),
      expect.objectContaining({ id: "toolCalling", status: "passed" }),
    ]));
  });

  it("reports an ignored tool request without throwing away the connection result", async () => {
    const complete = vi.fn<ModelClient["complete"]>();
    complete.mockResolvedValue({ role: "assistant", content: "plain text" });

    const result = await diagnoseModel({ complete }, "text-only", new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "connection",
      status: "passed",
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "toolCalling",
      status: "failed",
    }));
  });
});
