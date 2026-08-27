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
    const client = createClient();

    const assistant = await client.complete(messages, [], new AbortController().signal);

    expect(assistant.reasoning_content).toBe("I should inspect the project first.");
    expect(assistant.tool_calls?.[0]?.function.name).toBe("list_files");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("joins compatible text content parts", async () => {
    stubPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "任务" },
              { type: "text", text: "完成。" },
            ],
          },
        },
      ],
    });

    const assistant = await createClient().complete([], [], new AbortController().signal);

    expect(assistant.content).toBe("任务完成。");
  });

  it("rejects invalid JSON before reading the response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 200 })),
    );

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("invalid JSON");
  });

  it("rejects an empty choices collection", async () => {
    stubPayload({ choices: [] });

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("choices must be a non-empty array");
  });

  it("rejects malformed tool calls instead of silently treating the task as complete", async () => {
    stubPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
              },
            ],
          },
        },
      ],
    });

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("id must be a non-empty string");
  });

  it("rejects duplicate tool call identifiers", async () => {
    stubPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("same-id", "{}"),
              toolCall("same-id", "{}"),
            ],
          },
        },
      ],
    });

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("duplicate id");
  });

  it("rejects tool arguments that do not encode an object", async () => {
    stubPayload({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [toolCall("call-1", "[]")],
          },
        },
      ],
    });

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("arguments must encode an object");
  });
});

function createClient(): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    apiBaseUrl: "https://api-inference.modelscope.cn/v1",
    apiKey: "test-token",
    model: "deepseek-ai/DeepSeek-V4-Pro",
  });
}

function stubPayload(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function toolCall(id: string, argumentsValue: string): Record<string, unknown> {
  return {
    id,
    type: "function",
    function: { name: "read_file", arguments: argumentsValue },
  };
}
