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
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

const MAX_TOOL_CALLS = 32;
const MAX_TOOL_ARGUMENT_CHARS = 100_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 15_000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export class OpenAICompatibleClient implements ModelClient {
  public constructor(private readonly config: OpenAICompatibleConfig) {}

  public async complete(
    messages: readonly ChatMessage[],
    tools: readonly FunctionToolSchema[],
    signal: AbortSignal,
  ): Promise<Extract<ChatMessage, { role: "assistant" }>> {
    const endpoint = `${this.config.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const maxRetries = boundedInteger(this.config.maxRetries, DEFAULT_MAX_RETRIES, 0, 4);
    const retryBaseDelayMs = boundedInteger(
      this.config.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
    );
    const requestBody = JSON.stringify({
      model: this.config.model,
      messages,
      tools,
      tool_choice: "auto",
    });
    let rawBody = "";
    let response: Response | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      response = await fetch(endpoint, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: requestBody,
      });
      rawBody = await response.text();
      if (response.ok) {
        break;
      }

      const detail = modelErrorDetail(rawBody, response.statusText);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
        throw requestFailure(response.status, detail, attempt);
      }
      await waitForRetry(retryDelayMs(response, attempt, retryBaseDelayMs), signal);
    }

    if (!response?.ok) {
      throw new Error("Model request failed without a response.");
    }

    const payload = parsePayload(rawBody);
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw protocolError("choices must be a non-empty array");
    }
    const firstChoice = choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
      throw protocolError("choices[0].message must be an object");
    }
    const message = firstChoice.message;
    if (message.role !== undefined && message.role !== "assistant") {
      throw protocolError("choices[0].message.role must be assistant");
    }
    const content = normalizeContent(message.content);
    const toolCalls = normalizeToolCalls(message.tool_calls);
    if (!content?.trim() && !toolCalls?.length) {
      throw protocolError("assistant message contained neither text nor tool calls");
    }

    return {
      role: "assistant",
      content,
      reasoning_content: normalizeOptionalString(message.reasoning_content),
      tool_calls: toolCalls,
    };
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function modelErrorDetail(rawBody: string, statusText: string): string {
  try {
    const value: unknown = JSON.parse(rawBody);
    if (isRecord(value)) {
      const detail = modelErrorMessage(value);
      if (detail) {
        return detail;
      }
    }
  } catch {
    // Error responses are not required to use the successful response schema.
  }
  return rawBody.slice(0, 500) || statusText || "Unknown model service error";
}

function requestFailure(status: number, detail: string, retries: number): Error {
  const retryNote = retries > 0 ? `，已自动重试 ${retries} 次` : "";
  if (status === 401) {
    return new Error(`模型认证失败 (401)：${detail}。请检查 API Key 与账号绑定状态。`);
  }
  if (status === 429) {
    return new Error(`模型服务限流 (429)${retryNote}：${detail}。请稍后重试或切换模型。`);
  }
  return new Error(`Model request failed (${status})${retryNote}: ${detail}`);
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAt - Date.now()));
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** attempt);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("The model request was aborted.", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("The model request was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePayload(rawBody: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error(`Model returned invalid JSON: ${rawBody.slice(0, 300)}`);
  }
  if (!isRecord(value)) {
    throw protocolError("top-level response must be an object");
  }
  return value;
}

function normalizeContent(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part, index) => {
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
          throw protocolError(`message.content[${index}] must be a text part`);
        }
        return part.text;
      })
      .join("");
  }
  throw protocolError("message.content must be a string, text-part array, or null");
}

function normalizeToolCalls(value: unknown): FunctionToolCall[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw protocolError("message.tool_calls must be an array");
  }
  if (value.length > MAX_TOOL_CALLS) {
    throw protocolError(`message.tool_calls exceeds the ${MAX_TOOL_CALLS}-call limit`);
  }

  const calls: FunctionToolCall[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isRecord(item.function)) {
      throw protocolError(`message.tool_calls[${index}] must contain a function object`);
    }
    if (item.type !== "function") {
      throw protocolError(`message.tool_calls[${index}].type must be function`);
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw protocolError(`message.tool_calls[${index}].id must be a non-empty string`);
    }
    if (ids.has(item.id)) {
      throw protocolError(`message.tool_calls contains duplicate id: ${item.id}`);
    }
    ids.add(item.id);
    if (
      typeof item.function.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.function.name)
    ) {
      throw protocolError(
        `message.tool_calls[${index}].function.name must be a valid tool name`,
      );
    }
    if (typeof item.function.arguments !== "string") {
      throw protocolError(
        `message.tool_calls[${index}].function.arguments must be a JSON string`,
      );
    }
    validateToolArguments(item.function.arguments, index);
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

function validateToolArguments(raw: string, index: number): void {
  if (raw.length > MAX_TOOL_ARGUMENT_CHARS) {
    throw protocolError(
      `message.tool_calls[${index}].function.arguments exceeds the size limit`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw protocolError(
      `message.tool_calls[${index}].function.arguments is not valid JSON`,
    );
  }
  if (!isRecord(parsed)) {
    throw protocolError(
      `message.tool_calls[${index}].function.arguments must encode an object`,
    );
  }
}

function modelErrorMessage(payload: Record<string, unknown>): string | undefined {
  return isRecord(payload.error) && typeof payload.error.message === "string"
    ? payload.error.message
    : undefined;
}

function protocolError(detail: string): Error {
  return new Error(`Model response protocol error: ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
