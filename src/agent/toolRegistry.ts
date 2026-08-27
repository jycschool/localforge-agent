import type {
  AgentTool,
  FunctionToolSchema,
  ToolExecutionContext,
  ToolResult,
} from "../core/protocol";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  public constructor(tools: readonly AgentTool[]) {
    for (const tool of tools) {
      const name = tool.schema.function.name;
      if (this.tools.has(name)) {
        throw new Error(`Duplicate tool name: ${name}`);
      }
      this.tools.set(name, tool);
    }
  }

  public schemas(): FunctionToolSchema[] {
    return Array.from(this.tools.values(), (tool) => tool.schema);
  }

  public async execute(
    name: string,
    argumentsValue: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }), isError: true };
    }

    try {
      return await tool.execute(argumentsValue, context);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return {
        content: JSON.stringify({ error: errorMessage(error) }),
        isError: true,
      };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

