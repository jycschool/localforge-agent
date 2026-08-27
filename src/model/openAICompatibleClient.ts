import type {
  ChatMessage,
  FunctionToolCall,
  FunctionToolSchema,
  ModelClient,
} from "../core/protocol";

export interface OpenAICompatibleConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  error?: { message?: string };
}

export class OpenAICompatibleClient implements ModelClient {
  public constructor(private readonly config: OpenAICompatibleConfig) {}

  public async complete(
    messages: readonly ChatMessage[],
    tools: readonly FunctionToolSchema[],
    signal: AbortSignal,
  ): Promise<Extract<ChatMessage, { role: "assistant" }>> {
    const endpoint = `${this.config.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools,
        tool_choice: "auto",
      }),
    });

    const rawBody = await response.text();
    const payload = parsePayload(rawBody);
    if (!response.ok) {
      const detail = (payload.error?.message ?? rawBody.slice(0, 500)) || response.statusText;
      throw new Error(`Model request failed (${response.status}): ${detail}`);
    }

    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error("Model response did not contain choices[0].message.");
    }

    return {
      role: "assistant",
      content: normalizeContent(message.content),
      tool_calls: normalizeToolCalls(message.tool_calls),
    };
  }
}

function parsePayload(rawBody: string): ChatCompletionPayload {
  try {
    return JSON.parse(rawBody) as ChatCompletionPayload;
  } catch {
    throw new Error(`Model returned invalid JSON: ${rawBody.slice(0, 300)}`);
  }
}

function normalizeContent(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function normalizeToolCalls(value: unknown): FunctionToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const calls: FunctionToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) {
      continue;
    }
    if (
      typeof item.id !== "string" ||
      typeof item.function.name !== "string" ||
      typeof item.function.arguments !== "string"
    ) {
      continue;
    }
    calls.push({
      id: item.id,
      type: "function",
      function: {
        name: item.function.name,
        arguments: item.function.arguments,
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
