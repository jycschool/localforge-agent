import { describe, expect, it } from "vitest";
import { toolsForPermission } from "../src/agent/permissions";
import type { AgentTool } from "../src/core/protocol";

describe("agent permission modes", () => {
  const tools = [
    namedTool("list_files"),
    namedTool("search_text"),
    namedTool("read_file"),
    namedTool("replace_in_file"),
    namedTool("write_file"),
    namedTool("run_command"),
  ];

  it("removes every mutating tool in read-only mode", () => {
    expect(toolNames(toolsForPermission(tools, "readOnly"))).toEqual([
      "list_files",
      "search_text",
      "read_file",
    ]);
  });

  it("keeps workspace tools available in workspace mode", () => {
    expect(toolNames(toolsForPermission(tools, "workspace"))).toEqual(toolNames(tools));
  });
});

function namedTool(name: string): AgentTool {
  return {
    schema: {
      type: "function",
      function: { name, description: name, parameters: { type: "object" } },
    },
    async execute() {
      return { content: "{}" };
    },
  };
}

function toolNames(tools: readonly AgentTool[]): string[] {
  return tools.map((tool) => tool.schema.function.name);
}
