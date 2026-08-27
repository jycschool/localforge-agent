import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/core/protocol";
import { OpenAICompatibleClient } from "../src/model/openAICompatibleClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleClient", () => {
  it("preserves DeepSeek reasoning content across tool turns", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "I should inspect the project first.",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "list_files", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Inspect this project." },
    ];
    const client = new OpenAICompatibleClient({
      apiBaseUrl: "https://api-inference.modelscope.cn/v1",
      apiKey: "test-token",
      model: "deepseek-ai/DeepSeek-V4-Pro",
    });

    const assistant = await client.complete(messages, [], new AbortController().signal);

    expect(assistant.reasoning_content).toBe("I should inspect the project first.");
    expect(assistant.tool_calls?.[0]?.function.name).toBe("list_files");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
