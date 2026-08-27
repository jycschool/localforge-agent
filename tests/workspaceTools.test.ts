import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const payload = JSON.parse(result.content) as {
      approved: boolean;
      approvalDurationMs: number;
      error: string;
    };
    expect(payload).toMatchObject({
      approved: false,
      error: "User rejected the command.",
    });
    expect(payload.approvalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns successful UTF-8 stdout and stderr without corrupting Chinese text", async () => {
    const { tools } = await createFixture();
    const result = await tool(tools, "run_command").execute(
      {
        command:
          'node -e "process.stdout.write(\'\\u4e2d\\u6587\');process.stderr.write(\'\\u8b66\\u544a\')"',
        reason: "验证 UTF-8 输出",
      },
      executionContext(),
    );
    const payload = JSON.parse(result.content) as {
      exitCode: number;
      stdout: string;
      stderr: string;
      outputTruncated: boolean;
      approvalDurationMs: number;
      executionDurationMs: number;
    };

    expect(result.isError).not.toBe(true);
    expect(payload).toMatchObject({
      exitCode: 0,
      stdout: "中文",
      stderr: "警告",
      outputTruncated: false,
    });
    expect(payload.approvalDurationMs).toBeGreaterThanOrEqual(0);
    expect(payload.executionDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves a non-zero exit code and marks the result as an error", async () => {
    const { tools } = await createFixture();
    const result = await tool(tools, "run_command").execute(
      {
        command: 'node -e "process.stderr.write(\'failed\');process.exit(7)"',
        reason: "验证失败状态",
      },
      executionContext(),
    );
    const payload = JSON.parse(result.content) as { exitCode: number; stderr: string };

    expect(result.isError).toBe(true);
    expect(payload.exitCode).toBe(7);
    expect(payload.stderr).toBe("failed");
  });

  it("times out a command and terminates its descendant process", async () => {
    const { tools, root } = await createFixture({ commandTimeoutMs: 150 });
    await writeFile(
      path.join(root, "child-process.js"),
      [
        'const { writeFileSync } = require("node:fs");',
        'setTimeout(() => writeFileSync("orphan-marker.txt", "alive"), 700);',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "parent-process.js"),
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["child-process.js"], { cwd: __dirname, stdio: "ignore" });',
        'writeFileSync("child.pid", String(child.pid));',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
      "utf8",
    );

    const result = await tool(tools, "run_command").execute(
      { command: "node parent-process.js", reason: "验证超时清理" },
      executionContext(),
    );
    const payload = JSON.parse(result.content) as { timedOut: boolean };
    await delay(850);

    try {
      expect(result.isError).toBe(true);
      expect(payload.timedOut).toBe(true);
      expect(await fileExists(path.join(root, "orphan-marker.txt"))).toBe(false);
    } finally {
      await stopRecordedChild(path.join(root, "child.pid"));
    }
  });

  it("rejects with AbortError when the user cancels a running command", async () => {
    const { tools } = await createFixture({ commandTimeoutMs: 5_000 });
    const controller = new AbortController();
    const running = tool(tools, "run_command").execute(
      { command: 'node -e "setInterval(() => {}, 1_000)"', reason: "验证取消" },
      executionContext(true, controller.signal),
    );
    setTimeout(() => controller.abort(), 100);

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps only the configured output tail and reports truncation", async () => {
    const { tools } = await createFixture({ maxOutputChars: 40 });
    const result = await tool(tools, "run_command").execute(
      {
        command: 'node -e "process.stdout.write(\'x\'.repeat(120))"',
        reason: "验证输出限制",
      },
      executionContext(),
    );
    const payload = JSON.parse(result.content) as {
      stdout: string;
      outputTruncated: boolean;
    };

    expect(payload.stdout).toBe("x".repeat(40));
    expect(payload.outputTruncated).toBe(true);
  });
});

async function createFixture(
  options: { commandTimeoutMs?: number; maxOutputChars?: number } = {},
): Promise<{ tools: AgentTool[]; tracker: ChangeTracker; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "localforge-tools-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "index.ts"), "export {};\n", "utf8");
  await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  const tracker = new ChangeTracker();
  const tools = await createWorkspaceTools({
    rootPath: root,
    changeTracker: tracker,
    commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
    maxOutputChars: options.maxOutputChars ?? 5_000,
  });
  return { tools, tracker, root };
}

function tool(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((candidate) => candidate.schema.function.name === name);
  if (!found) {
    throw new Error(`Missing test tool: ${name}`);
  }
  return found;
}

function executionContext(
  approved = true,
  signal: AbortSignal = new AbortController().signal,
): ToolExecutionContext {
  return {
    signal,
    requestCommandApproval: async () => approved,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function stopRecordedChild(pidFile: string): Promise<void> {
  try {
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    if (Number.isInteger(pid)) {
      process.kill(pid);
    }
  } catch {
    // The expected path: the command tree was already terminated.
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
