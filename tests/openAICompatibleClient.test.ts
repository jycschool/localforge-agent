import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/core/protocol";
import { OpenAICompatibleClient } from "../src/model/openAICompatibleClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleClient", () => {
  it("streams visible text while assembling reasoning and fragmented tool calls", async () => {
    const body = [
      'data: {"choices":[{"delta":{"role":null,"reasoning_content":"先读取，","content":"正在"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"再处理。","content":"处理","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"role":"","tool_calls":[{"index":0,"id":"","type":"","function":{"name":"file","arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const encoded = new TextEncoder().encode(body);
    const splitAt = Math.floor(encoded.length / 3);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.slice(0, splitAt));
            controller.enqueue(encoded.slice(splitAt, splitAt * 2));
            controller.enqueue(encoded.slice(splitAt * 2));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const assistant = await createClient().complete(
      [],
      [],
      new AbortController().signal,
      (text) => deltas.push(text),
    );

    expect(deltas).toEqual(["正在", "处理"]);
    expect(assistant).toEqual({
      role: "assistant",
      content: "正在处理",
      reasoning_content: "先读取，再处理。",
      tool_calls: [toolCall("call-1", '{"path":"README.md"}')],
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ stream: true });
  });

  it("accepts buffered SSE from a compatible service without an event-stream header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"兼容输出","tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":""}}]}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "Content-Type": "text/plain" } },
        ),
      ),
    );
    const deltas: string[] = [];

    const assistant = await createClient().complete(
      [],
      [],
      new AbortController().signal,
      (text) => deltas.push(text),
    );

    expect(assistant.content).toBe("兼容输出");
    expect(deltas).toEqual(["兼容输出"]);
  });

  it("uses exact token usage from a final usage-only stream chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    const usages: Array<{ totalTokens: number; estimated: boolean }> = [];

    await createClient().complete(
      [],
      [],
      new AbortController().signal,
      undefined,
      (usage) => usages.push(usage),
    );

    expect(usages).toEqual([
      expect.objectContaining({ totalTokens: 128, estimated: false }),
    ]);
  });

  it("clearly marks locally estimated usage and sends the selected output budget", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        successfulResponse("estimated response"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const usages: Array<{ totalTokens: number; estimated: boolean }> = [];

    await createClient({ maxTokens: 4_096 }).complete(
      [{ role: "user", content: "hello" }],
      [],
      new AbortController().signal,
      undefined,
      (usage) => usages.push(usage),
    );

    expect(usages[0]).toMatchObject({ estimated: true });
    expect(usages[0]?.totalTokens).toBeGreaterThan(0);
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 4_096 });
  });

  it("treats an all-zero server usage chunk as a placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"非空回答"}}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    const usages: Array<{ totalTokens: number; estimated: boolean }> = [];

    await createClient().complete(
      [{ role: "user", content: "请回答" }],
      [],
      new AbortController().signal,
      undefined,
      (usage) => usages.push(usage),
    );

    expect(usages[0]).toMatchObject({ estimated: true });
    expect(usages[0]?.totalTokens).toBeGreaterThan(0);
  });

  it("keeps final stream validation strict after accepting empty optional fragments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          'data: {"choices":[{"delta":{"role":"user","content":"bad"}}]}\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("must be assistant or empty");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );

    await expect(
      createClient().complete([], [], new AbortController().signal),
    ).rejects.toThrow("id must be a non-empty string");
  });

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
