import { describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/agentLoop";
import { ToolRegistry } from "../src/agent/toolRegistry";
import type {
  AgentEvent,
  AgentTool,
  ChatMessage,
  FunctionToolSchema,
  ModelClient,
} from "../src/core/protocol";

class ScriptedModel implements ModelClient {
  public constructor(
    private readonly responses: Array<Extract<ChatMessage, { role: "assistant" }>>,
  ) {}

  public async complete(
    _messages: readonly ChatMessage[],
    _tools: readonly FunctionToolSchema[],
    _signal: AbortSignal,
  ): Promise<Extract<ChatMessage, { role: "assistant" }>> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No scripted response remains.");
    }
    return response;
  }
}

const echoTool: AgentTool = {
  schema: {
    type: "function",
    function: {
      name: "echo",
      description: "Echo a value.",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
  },
  async execute(argumentsValue) {
    return { content: JSON.stringify({ echoed: argumentsValue.value }) };
  },
};

describe("AgentLoop", () => {
  it("forwards visible model deltas before the complete assistant message", async () => {
    const model: ModelClient = {
      async complete(_messages, _tools, _signal, onTextDelta) {
        onTextDelta?.("流式");
        onTextDelta?.("完成");
        return { role: "assistant", content: "流式完成" };
      },
    };
    const events: AgentEvent[] = [];
    const result = await new AgentLoop(model, new ToolRegistry([])).run(
      defaultOptions(events),
    );

    expect(result.status).toBe("completed");
    expect(events).toContainEqual({ type: "assistant_delta", step: 1, text: "流式" });
    expect(events).toContainEqual({ type: "assistant_delta", step: 1, text: "完成" });
    expect(events.findIndex((event) => event.type === "assistant_delta")).toBeLessThan(
      events.findIndex((event) => event.type === "assistant_message"),
    );
  });

  it("reports cumulative token usage from the model client", async () => {
    const model: ModelClient = {
      async complete(_messages, _tools, _signal, _onTextDelta, onUsage) {
        onUsage?.({
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150,
          estimated: false,
        });
        return { role: "assistant", content: "Finished." };
      },
    };
    const events: AgentEvent[] = [];
    await new AgentLoop(model, new ToolRegistry([])).run(defaultOptions(events));

    expect(events).toContainEqual({
      type: "model_usage",
      step: 1,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      estimated: false,
    });
  });

  it("completes immediately when the model returns text", async () => {
    const loop = new AgentLoop(
      new ScriptedModel([{ role: "assistant", content: "Finished." }]),
      new ToolRegistry([]),
    );
    const events: AgentEvent[] = [];
    const result = await loop.run(defaultOptions(events));

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Finished.");
    expect(events[0]).toMatchObject({ type: "run_started", task: "Do a task" });
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("continues the loop when a completion gate reports unfinished work", async () => {
    const loop = new AgentLoop(
      new ScriptedModel([
        { role: "assistant", content: "看起来已经完成。" },
        { role: "assistant", content: "核验后完成。" },
      ]),
      new ToolRegistry([]),
    );
    const events: AgentEvent[] = [];
    let checks = 0;
    const result = await loop.run({
      ...defaultOptions(events),
      validateCompletion: () => (++checks === 1 ? "计划尚未通过完成核验。" : undefined),
    });

    expect(result.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(events).toContainEqual({
      type: "completion_blocked",
      step: 1,
      message: "计划尚未通过完成核验。",
    });
    expect(result.messages).toContainEqual({
      role: "system",
      content: expect.stringContaining("The task cannot finish yet"),
    });
  });

  it("can display the original user task while the model receives added context", async () => {
    const loop = new AgentLoop(
      new ScriptedModel([{ role: "assistant", content: "Finished." }]),
      new ToolRegistry([]),
    );
    const events: AgentEvent[] = [];

    await loop.run({
      ...defaultOptions(events),
      task: "Inspect.\n\nThe user has src/main.ts selected.",
      displayTask: "Inspect.",
    });

    expect(events[0]).toEqual({ type: "run_started", task: "Inspect." });
  });

  it("places a selected historical conversation before the new user message", async () => {
    let receivedMessages: readonly ChatMessage[] = [];
    const model: ModelClient = {
      async complete(messages) {
        receivedMessages = structuredClone(messages);
        return { role: "assistant", content: "Continued." };
      },
    };
    const events: AgentEvent[] = [];
    await new AgentLoop(model, new ToolRegistry([])).run({
      ...defaultOptions(events),
      task: "What should I do next?",
      previousMessages: [
        { role: "user", content: "Inspect the login flow." },
        { role: "assistant", content: "The validation is incomplete." },
      ],
    });

    expect(receivedMessages).toEqual([
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "Inspect the login flow." },
      { role: "assistant", content: "The validation is incomplete." },
      { role: "user", content: "What should I do next?" },
    ]);
  });

  it("fails instead of reporting success for an empty model response", async () => {
    const loop = new AgentLoop(
      new ScriptedModel([{ role: "assistant", content: null }]),
      new ToolRegistry([]),
    );
    const events: AgentEvent[] = [];
    const result = await loop.run(defaultOptions(events));

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Model returned neither text nor tool calls.");
    expect(events.at(-1)).toMatchObject({
      type: "run_failed",
      message: "Model returned neither text nor tool calls.",
    });
  });

  it("records a model request error as a failed run", async () => {
    const loop = new AgentLoop(new ScriptedModel([]), new ToolRegistry([]));
    const events: AgentEvent[] = [];
    const result = await loop.run(defaultOptions(events));

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("No scripted response remains.");
    expect(events.at(-1)).toMatchObject({
      type: "run_failed",
      message: "No scripted response remains.",
      steps: 1,
    });
  });

  it("feeds a tool result back into the next model turn", async () => {
    const model = new ScriptedModel([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ value: "hello" }) },
          },
        ],
      },
      { role: "assistant", content: "Used the tool and finished." },
    ]);
    const events: AgentEvent[] = [];
    const loop = new AgentLoop(model, new ToolRegistry([echoTool]));
    const result = await loop.run(defaultOptions(events));

    expect(result.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: JSON.stringify({ echoed: "hello" }),
    });
    expect(events.some((event) => event.type === "tool_finished")).toBe(true);
  });

  it("stops after the configured model step limit", async () => {
    const repeatedCalls = Array.from({ length: 3 }, (_, index) => ({
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: `call-${index}`,
          type: "function" as const,
          function: { name: "echo", arguments: JSON.stringify({ value: index }) },
        },
      ],
    }));
    const loop = new AgentLoop(new ScriptedModel(repeatedCalls), new ToolRegistry([echoTool]));
    const events: AgentEvent[] = [];
    const result = await loop.run({ ...defaultOptions(events), maxSteps: 2 });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("已达到 2 步运行上限");
    expect(events.at(-1)).toMatchObject({
      type: "run_failed",
      reason: "max_steps",
      steps: 2,
    });
  });

  it("stops an identical failing tool-call loop before exhausting all steps", async () => {
    const invalidReadCalls = Array.from({ length: 4 }, (_, index) => ({
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: `read-${index}`,
          type: "function" as const,
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    }));
    const readFileTool: AgentTool = {
      schema: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      async execute() {
        return {
          content: JSON.stringify({ error: "path must be a non-empty string." }),
          isError: true,
        };
      },
    };
    const loop = new AgentLoop(
      new ScriptedModel(invalidReadCalls),
      new ToolRegistry([readFileTool]),
    );
    const events: AgentEvent[] = [];
    const result = await loop.run({ ...defaultOptions(events), maxSteps: 12 });

    expect(result.status).toBe("failed");
    expect(result.steps).toBe(3);
    expect(result.summary).toContain("连续 3 次");
    expect(result.summary).toContain("read_file");
    expect(result.summary).toContain("path must be a non-empty string");
    expect(events.filter((event) => event.type === "tool_finished")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "run_failed", steps: 3 });
  });

  it("reports cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const loop = new AgentLoop(
      new ScriptedModel([{ role: "assistant", content: "unreachable" }]),
      new ToolRegistry([]),
    );
    const events: AgentEvent[] = [];
    const result = await loop.run({ ...defaultOptions(events), signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(events.at(-1)?.type).toBe("run_cancelled");
  });

  it("returns malformed tool arguments to the model as a tool error", async () => {
    const model = new ScriptedModel([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "bad-call",
            type: "function",
            function: { name: "echo", arguments: "{not-json" },
          },
        ],
      },
      { role: "assistant", content: "Recovered from the invalid call." },
    ]);
    const loop = new AgentLoop(model, new ToolRegistry([echoTool]));
    const events: AgentEvent[] = [];
    const result = await loop.run(defaultOptions(events));

    expect(result.status).toBe("completed");
    const toolMessage = result.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "bad-call",
    );
    expect(toolMessage?.content).toContain("not valid JSON");
  });
});

function defaultOptions(events: AgentEvent[]) {
  return {
    task: "Do a task",
    systemPrompt: "You are a test agent.",
    maxSteps: 5,
    signal: new AbortController().signal,
    onEvent: (event: AgentEvent) => events.push(event),
    requestCommandApproval: vi.fn(async () => true),
  };
}
