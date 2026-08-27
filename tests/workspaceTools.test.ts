import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeTracker } from "../src/agent/changeTracker";
import type { AgentTool, ToolExecutionContext } from "../src/core/protocol";
import { createWorkspaceTools } from "../src/tools/workspaceTools";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("workspace tools", () => {
  it("lists root and nested files for a double-star glob", async () => {
    const { tools } = await createFixture();
    const result = await tool(tools, "list_files").execute(
      { glob: "**/*.ts" },
      executionContext(),
    );
    const payload = JSON.parse(result.content) as { files: string[] };

    expect(payload.files).toEqual(["index.ts", "src/main.ts"]);
  });

  it("reads and precisely replaces one occurrence while tracking the original", async () => {
    const { tools, tracker } = await createFixture();
    const before = await tool(tools, "read_file").execute(
      { path: "src/main.ts" },
      executionContext(),
    );
    expect(before.content).toContain("export const value = 1");

    const result = await tool(tools, "replace_in_file").execute(
      { path: "src/main.ts", oldText: "value = 1", newText: "value = 2" },
      executionContext(),
    );
    expect(result.isError).not.toBe(true);
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]?.originalContent).toContain("value = 1");
  });

  it("rejects workspace traversal", async () => {
    const { tools } = await createFixture();
    await expect(
      tool(tools, "read_file").execute({ path: "../outside.txt" }, executionContext()),
    ).rejects.toThrow("outside the workspace");
  });

  it("does not run a rejected command", async () => {
    const { tools } = await createFixture();
    const result = await tool(tools, "run_command").execute(
      { command: "node --version", reason: "Verify the runtime" },
      executionContext(false),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("User rejected");
  });
});

async function createFixture(): Promise<{ tools: AgentTool[]; tracker: ChangeTracker }> {
  const root = await mkdtemp(path.join(tmpdir(), "localforge-tools-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  const tracker = new ChangeTracker();
  const tools = await createWorkspaceTools({
    rootPath: root,
    changeTracker: tracker,
    commandTimeoutMs: 2_000,
    maxOutputChars: 5_000,
  });
  return { tools, tracker };
}

function tool(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((candidate) => candidate.schema.function.name === name);
  if (!found) {
    throw new Error(`Missing test tool: ${name}`);
  }
  return found;
}

function executionContext(approved = true): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    requestCommandApproval: async () => approved,
  };
}

