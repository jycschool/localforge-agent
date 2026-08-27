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

  it("retries a transient rate limit and honors Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(successfulResponse("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const assistant = await createClient({ maxRetries: 1 }).complete(
      [],
      [],
      new AbortController().signal,
    );

    expect(assistant.content).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a persistent rate limit with actionable guidance", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "hourly quota reached" } }), {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createClient({ maxRetries: 1 }).complete([], [], new AbortController().signal),
    ).rejects.toThrow("请稍后重试或切换模型");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an HTTP error when the error body is not JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("bad gateway", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("Model request failed (400): bad gateway");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("can be cancelled while waiting to retry", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "try later" } }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const running = createClient({ maxRetries: 2, retryBaseDelayMs: 100 }).complete(
      [],
      [],
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function createClient(
  overrides: Partial<ConstructorParameters<typeof OpenAICompatibleClient>[0]> = {},
): OpenAICompatibleClient {
  return new OpenAICompatibleClient({
    apiBaseUrl: "https://api-inference.modelscope.cn/v1",
    apiKey: "test-token",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    ...overrides,
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

function successfulResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
