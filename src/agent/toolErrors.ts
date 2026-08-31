import type { ToolResult } from "../core/protocol";

export interface ToolErrorDetails {
  code: string;
  retryable: boolean;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export class ToolExecutionError extends Error {
  public constructor(
    message: string,
    public readonly errorDetails: ToolErrorDetails,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export function toolErrorResult(
  error: unknown,
  fallback: Partial<ToolErrorDetails> = {},
): ToolResult {
  const message = errorMessage(error);
  const details = error instanceof ToolExecutionError
    ? error.errorDetails
    : {
        code: fallback.code ?? "TOOL_EXECUTION_FAILED",
        retryable: fallback.retryable ?? false,
        suggestion: fallback.suggestion,
        details: fallback.details,
      };
  return {
    content: JSON.stringify({
      error: message,
      code: details.code,
      retryable: details.retryable,
      ...(details.suggestion ? { suggestion: details.suggestion } : {}),
      ...(details.details ? { details: details.details } : {}),
    }),
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
