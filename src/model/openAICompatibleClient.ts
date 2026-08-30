import type {
  ChatMessage,
  FunctionToolCall,
  FunctionToolSchema,
  ModelClient,
  TokenUsage,
} from "../core/protocol";

export interface OpenAICompatibleConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
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
    onTextDelta?: (text: string) => void,
    onUsage?: (usage: TokenUsage) => void,
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
      stream: true,
      max_tokens: boundedInteger(this.config.maxTokens, 8_192, 256, 65_536),
    });

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: requestBody,
      });
      if (response.ok) {
        const parsed = await readAssistantResponse(response, onTextDelta);
        onUsage?.(parsed.usage ?? estimateUsage(messages, tools, parsed.message));
        return parsed.message;
      }

      const rawBody = await response.text();
      const detail = modelErrorDetail(rawBody, response.statusText);
      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
        throw requestFailure(response.status, detail, attempt);
      }
      await waitForRetry(retryDelayMs(response, attempt, retryBaseDelayMs), signal);
    }

    throw new Error("Model request failed without a response.");
  }
}

interface StreamingToolCall {
  id?: string;
  type?: string;
  name: string;
  arguments: string;
}

interface StreamAccumulator {
  content: string;
  reasoningContent: string;
  toolCalls: Map<number, StreamingToolCall>;
  usage?: TokenUsage;
}

interface ParsedAssistantResponse {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: TokenUsage;
}

async function readAssistantResponse(
  response: Response,
  onTextDelta?: (text: string) => void,
): Promise<ParsedAssistantResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return readEventStream(response, onTextDelta);
  }

  const rawBody = await response.text();
  if (rawBody.trimStart().startsWith("data:")) {
    return readBufferedEventStream(rawBody, onTextDelta);
  }
  return parseAssistantPayload(parsePayload(rawBody));
}

function parseAssistantPayload(
  payload: Record<string, unknown>,
): ParsedAssistantResponse {
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
    message: {
      role: "assistant",
      content,
      reasoning_content: normalizeOptionalString(message.reasoning_content),
      tool_calls: toolCalls,
    },
    usage: normalizeTokenUsage(payload.usage),
  };
}

async function readEventStream(
  response: Response,
  onTextDelta?: (text: string) => void,
): Promise<ParsedAssistantResponse> {
  if (!response.body) {
    throw protocolError("streaming response body is missing");
  }

  const accumulator = createStreamAccumulator();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let dataLines: string[] = [];
  let streamEnded = false;

  const dispatch = (): void => {
    if (dataLines.length === 0 || streamEnded) {
      dataLines = [];
      return;
    }
    streamEnded = consumeStreamEvent(dataLines.join("\n"), accumulator, onTextDelta);
    dataLines = [];
  };
  const processLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  };

  while (!streamEnded) {
    const chunk = await reader.read();
    if (chunk.done) {
      buffered += decoder.decode();
      break;
    }
    buffered += decoder.decode(chunk.value, { stream: true });
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      processLine(buffered.slice(0, newlineIndex));
      buffered = buffered.slice(newlineIndex + 1);
      if (streamEnded) {
        break;
      }
      newlineIndex = buffered.indexOf("\n");
    }
  }

  if (streamEnded) {
    await reader.cancel();
  } else {
    if (buffered) {
      processLine(buffered);
    }
    dispatch();
  }
  return finalizeStream(accumulator);
}

function readBufferedEventStream(
  rawBody: string,
  onTextDelta?: (text: string) => void,
): ParsedAssistantResponse {
  const accumulator = createStreamAccumulator();
  let dataLines: string[] = [];
  let streamEnded = false;
  const dispatch = (): void => {
    if (dataLines.length > 0 && !streamEnded) {
      streamEnded = consumeStreamEvent(dataLines.join("\n"), accumulator, onTextDelta);
    }
    dataLines = [];
  };

  for (const rawLine of rawBody.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      dispatch();
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  dispatch();
  return finalizeStream(accumulator);
}

function createStreamAccumulator(): StreamAccumulator {
  return { content: "", reasoningContent: "", toolCalls: new Map() };
}

function consumeStreamEvent(
  data: string,
  accumulator: StreamAccumulator,
  onTextDelta?: (text: string) => void,
): boolean {
  if (data.trim() === "[DONE]") {
    return true;
  }
  const payload = parsePayload(data);
  const usage = normalizeTokenUsage(payload.usage);
  if (usage) {
    accumulator.usage = usage;
  }
  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    if (isMetadataOnlyStreamPayload(payload)) {
      return false;
    }
    throw protocolError("stream chunk choices must be an array");
  }
  // Some compatible services send a final usage-only chunk with no choices.
  if (choices.length === 0) {
    return false;
  }
  const firstChoice = choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) {
    throw protocolError("stream choices[0].delta must be an object");
  }
  const delta = firstChoice.delta;
  if (!isCompatibleStreamRole(delta.role)) {
    throw protocolError(
      `stream choices[0].delta.role must be assistant or empty, received ${JSON.stringify(delta.role)}`,
    );
  }

  const contentDelta = normalizeStreamText(delta.content, "content");
  if (contentDelta) {
    accumulator.content += contentDelta;
    onTextDelta?.(contentDelta);
  }
  const reasoningDelta = normalizeStreamText(delta.reasoning_content, "reasoning_content");
  if (reasoningDelta) {
    accumulator.reasoningContent += reasoningDelta;
  }
  mergeStreamingToolCalls(delta.tool_calls, accumulator.toolCalls);
  return false;
}

function isMetadataOnlyStreamPayload(payload: Record<string, unknown>): boolean {
  return (
    (payload.choices === undefined || payload.choices === null) &&
    payload.error === undefined
  );
}

function normalizeStreamText(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw protocolError(`stream delta.${field} must be a string or null`);
  }
  return value;
}

function mergeStreamingToolCalls(
  value: unknown,
  toolCalls: Map<number, StreamingToolCall>,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!Array.isArray(value)) {
    throw protocolError("stream delta.tool_calls must be an array");
  }

  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.index) || (item.index as number) < 0) {
      throw protocolError("stream tool call index must be a non-negative integer");
    }
    const index = item.index as number;
    if (index >= MAX_TOOL_CALLS) {
      throw protocolError(`stream tool call index exceeds the ${MAX_TOOL_CALLS}-call limit`);
    }
    const hadExisting = toolCalls.has(index);
    const existing = toolCalls.get(index) ?? { name: "", arguments: "" };
    let hasMeaningfulFragment = hadExisting;
    if (item.id !== undefined && item.id !== null) {
      if (typeof item.id !== "string") {
        throw protocolError("stream tool call id must be a string or null");
      }
      if (item.id.trim()) {
        if (existing.id && existing.id !== item.id) {
          throw protocolError(`stream tool call index ${index} changed id`);
        }
        existing.id = item.id;
        hasMeaningfulFragment = true;
      }
    }
    if (item.type !== undefined && item.type !== null) {
      if (typeof item.type !== "string") {
        throw protocolError("stream tool call type must be a string or null");
      }
      if (item.type.trim() && item.type !== "function") {
        throw protocolError("stream tool call type must be function");
      }
      if (item.type === "function") {
        existing.type = item.type;
        hasMeaningfulFragment = true;
      }
    }
    if (item.function !== undefined && item.function !== null) {
      if (!isRecord(item.function)) {
        throw protocolError("stream tool call function must be an object");
      }
      if (item.function.name !== undefined && item.function.name !== null) {
        if (typeof item.function.name !== "string") {
          throw protocolError("stream tool call function name must be a string");
        }
        existing.name += item.function.name;
        hasMeaningfulFragment ||= item.function.name.length > 0;
      }
      if (item.function.arguments !== undefined && item.function.arguments !== null) {
        if (typeof item.function.arguments !== "string") {
          throw protocolError("stream tool call function arguments must be a string");
        }
        existing.arguments += item.function.arguments;
        hasMeaningfulFragment ||= item.function.arguments.length > 0;
        if (existing.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
          throw protocolError("stream tool call arguments exceed the size limit");
        }
      }
    }
    if (hasMeaningfulFragment) {
      if (!hadExisting && toolCalls.size >= MAX_TOOL_CALLS) {
        throw protocolError(`stream tool calls exceed the ${MAX_TOOL_CALLS}-call limit`);
      }
      toolCalls.set(index, existing);
    }
  }
}

function isCompatibleStreamRole(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && (value.trim() === "" || value === "assistant"))
  );
}

function finalizeStream(
  accumulator: StreamAccumulator,
): ParsedAssistantResponse {
  const rawToolCalls = [...accumulator.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    // A few compatible services serialize an empty tool-call placeholder on
    // ordinary text chunks. It is not an invocation and must not shadow text.
    .filter(([, call]) => Boolean(call.id?.trim() || call.name || call.arguments))
    .map(([, call]) => ({
      id: call.id,
      type: call.type,
      function: { name: call.name, arguments: call.arguments },
    }));
  const toolCalls = normalizeToolCalls(rawToolCalls.length > 0 ? rawToolCalls : undefined);
  const content = accumulator.content || null;
  if (!content?.trim() && !toolCalls?.length) {
    throw protocolError("assistant stream contained neither text nor tool calls");
  }
  return {
    message: {
      role: "assistant",
      content,
      reasoning_content: normalizeOptionalString(accumulator.reasoningContent),
      tool_calls: toolCalls,
    },
    usage: accumulator.usage,
  };
}

function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptTokens = nonNegativeInteger(value.prompt_tokens ?? value.input_tokens);
  const completionTokens = nonNegativeInteger(
    value.completion_tokens ?? value.output_tokens,
  );
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }
  const reportedTotal = nonNegativeInteger(value.total_tokens);
  if (promptTokens === 0 && completionTokens === 0 && (reportedTotal ?? 0) === 0) {
    // Several compatible streaming services emit an all-zero usage placeholder.
    // A non-empty prompt and assistant response cannot genuinely consume zero tokens.
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? promptTokens + completionTokens,
    estimated: false,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function estimateUsage(
  messages: readonly ChatMessage[],
  tools: readonly FunctionToolSchema[],
  assistant: Extract<ChatMessage, { role: "assistant" }>,
): TokenUsage {
  const promptTokens = estimateTokenCount(JSON.stringify({ messages, tools }));
  const completionTokens = estimateTokenCount(JSON.stringify(assistant));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

export function estimateTokenCount(text: string): number {
  let weightedCharacters = 0;
  for (const character of text) {
    if (/\s/u.test(character)) {
      continue;
    }
    weightedCharacters += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
      ? 1
      : 0.25;
  }
  return Math.max(1, Math.ceil(weightedCharacters));
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

  // Keep transport validation limited to the response envelope. Argument JSON is
  // validated by AgentLoop so a model can see the tool error and correct a
  // malformed call on its next turn instead of terminating the entire run.
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
