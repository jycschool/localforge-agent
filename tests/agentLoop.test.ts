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
  it("completes immediately when the model returns text", async () => {
    const loop = new AgentLoop(
      new ScriptedModel([{ role: "assistant", content: "Finished." }]),
      new ToolRegistry([]),
    );
    const events: AgentEvent[] = [];
    const result = await loop.run(defaultOptions(events));

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Finished.");
    expect(events.at(-1)?.type).toBe("run_completed");
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
    expect(result.summary).toContain("2-step limit");
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
