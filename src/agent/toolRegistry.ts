import type {
  AgentTool,
  FunctionToolSchema,
  ToolExecutionContext,
  ToolResult,
} from "../core/protocol";
import { toolErrorResult } from "./toolErrors";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  public constructor(
    tools: readonly AgentTool[],
    private readonly options: { isToolEnabled?(name: string): boolean } = {},
  ) {
    for (const tool of tools) {
      const name = tool.schema.function.name;
      if (this.tools.has(name)) {
        throw new Error(`Duplicate tool name: ${name}`);
      }
      this.tools.set(name, tool);
    }
  }

  public schemas(): FunctionToolSchema[] {
    return Array.from(this.tools.values())
      .filter((tool) => this.options.isToolEnabled?.(tool.schema.function.name) ?? true)
      .map((tool) => tool.schema);
  }

  public async execute(
    name: string,
    argumentsValue: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return toolErrorResult(new Error(`Unknown tool: ${name}`), {
        code: "UNKNOWN_TOOL",
        retryable: true,
        suggestion: "Choose one of the tool schemas currently supplied by RepoForge.",
      });
    }
    if (!(this.options.isToolEnabled?.(name) ?? true)) {
      return toolErrorResult(
        new Error(`Tool is not available in the current task phase: ${name}`),
        {
          code: "TOOL_DISABLED",
          retryable: true,
          suggestion: "Complete the required approval or planning phase before retrying this tool.",
        },
      );
    }

    try {
      return await tool.execute(argumentsValue, context);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return toolErrorResult(error);
    }
  }
}
