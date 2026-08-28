import type { AgentTool } from "../core/protocol";
import type { PermissionMode } from "../desktop/contracts";

const READ_ONLY_TOOLS = new Set(["list_files", "search_text", "read_file"]);

export function toolsForPermission(
  tools: readonly AgentTool[],
  permissionMode: PermissionMode,
): AgentTool[] {
  return permissionMode === "readOnly"
    ? tools.filter((tool) => READ_ONLY_TOOLS.has(tool.schema.function.name))
    : [...tools];
}
