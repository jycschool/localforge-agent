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

  it("stops listing and searching when their configured result limit is reached", async () => {
    const { tools } = await createFixture();
    const listResult = await tool(tools, "list_files").execute(
      { glob: "**/*.ts", limit: 1 },
      executionContext(),
    );
    const searchResult = await tool(tools, "search_text").execute(
      { query: "export", include: "**/*.ts", limit: 1 },
      executionContext(),
    );

    expect(JSON.parse(listResult.content)).toMatchObject({
      files: ["index.ts"],
      count: 1,
      limited: true,
    });
    expect(JSON.parse(searchResult.content)).toMatchObject({ count: 1, limited: true });
  });

  it("aborts workspace traversal instead of scanning the remaining tree", async () => {
    const { tools } = await createFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool(tools, "list_files").execute({}, executionContext(true, controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      tool(tools, "search_text").execute(
        { query: "export" },
        executionContext(true, controller.signal),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reads and precisely replaces one occurrence while tracking the original", async () => {
    const { tools, tracker } = await createFixture();
    const before = await tool(tools, "read_file").execute(
      { path: "src/main.ts" },
      executionContext(),
    );
    expect(before.content).toContain("export const value = 1");
    expect(JSON.parse(before.content)).toMatchObject({
      path: "src/main.ts",
      totalLines: 2,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const result = await tool(tools, "replace_in_file").execute(
      { path: "src/main.ts", oldText: "value = 1", newText: "value = 2" },
      executionContext(),
    );
    expect(result.isError).not.toBe(true);
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]?.originalContent).toContain("value = 1");
  });

  it("edits a line range only when the latest file hash matches", async () => {
    const { tools, tracker, root } = await createFixture();
    const readResult = await tool(tools, "read_file").execute(
      { path: "src/main.ts" },
      executionContext(),
    );
    const snapshot = JSON.parse(readResult.content) as { hash: string };
    const editResult = await tool(tools, "edit_file_lines").execute(
      {
        path: "src/main.ts",
        startLine: 1,
        endLine: 1,
        expectedHash: snapshot.hash,
        replacement: "export const value = 3;",
      },
      executionContext(),
    );

    expect(editResult.isError).not.toBe(true);
    expect(await readFile(path.join(root, "src", "main.ts"), "utf8")).toBe(
      "export const value = 3;\n",
    );
    expect(tracker.list()[0]?.originalContent).toBe("export const value = 1;\n");
    expect(JSON.parse(editResult.content)).toMatchObject({
      path: "src/main.ts",
      startLine: 1,
      endLine: 1,
      insertedLines: 1,
      beforeHash: snapshot.hash,
      afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects a stale line edit with a recoverable structured error", async () => {
    const { tools, root } = await createFixture();
    const readResult = await tool(tools, "read_file").execute(
      { path: "src/main.ts" },
      executionContext(),
    );
    const snapshot = JSON.parse(readResult.content) as { hash: string };
    await writeFile(path.join(root, "src", "main.ts"), "export const value = 9;\n", "utf8");

    await expect(
      tool(tools, "edit_file_lines").execute(
        {
          path: "src/main.ts",
          startLine: 1,
          endLine: 1,
          expectedHash: snapshot.hash,
          replacement: "export const value = 3;",
        },
        executionContext(),
      ),
    ).rejects.toMatchObject({
      errorDetails: {
        code: "STALE_FILE_CONTENT",
        retryable: true,
      },
    });
  });

  it("rejects oversized file reads, replacements, and writes", async () => {
    const { tools, root } = await createFixture();
    await writeFile(path.join(root, "large.txt"), "x".repeat(1_000_001), "utf8");

    await expect(
      tool(tools, "read_file").execute({ path: "large.txt" }, executionContext()),
    ).rejects.toThrow("exceeds the 1 MB");
    await expect(
      tool(tools, "replace_in_file").execute(
        { path: "large.txt", oldText: "x", newText: "y" },
        executionContext(),
      ),
    ).rejects.toThrow("exceeds the 1 MB");
    await expect(
      tool(tools, "write_file").execute(
        { path: "new-large.txt", content: "界".repeat(400_000) },
        executionContext(),
      ),
    ).rejects.toThrow("exceeds the 1 MB");
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
      code: "COMMAND_REJECTED",
      retryable: false,
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

  it("does not expose sensitive parent environment variables to commands", async () => {
    const previousKey = process.env.LOCALFORGE_API_KEY;
    const previousFlag = process.env.LOCALFORGE_TEST_FLAG;
    process.env.LOCALFORGE_API_KEY = "hidden-value";
    process.env.LOCALFORGE_TEST_FLAG = "visible-test-value";
    try {
      const { tools } = await createFixture();
      const result = await tool(tools, "run_command").execute(
        {
          command:
            'node -e "process.stdout.write(String(process.env.LOCALFORGE_API_KEY || \'\') + \'|\' + String(process.env.LOCALFORGE_TEST_FLAG || \'\'))"',
          reason: "验证子进程环境隔离",
        },
        executionContext(),
      );
      const payload = JSON.parse(result.content) as { stdout: string };

      expect(payload.stdout).toBe("|visible-test-value");
      expect(payload.stdout).not.toContain("hidden-value");
    } finally {
      restoreEnvironment("LOCALFORGE_API_KEY", previousKey);
      restoreEnvironment("LOCALFORGE_TEST_FLAG", previousFlag);
    }
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
    const payload = JSON.parse(result.content) as {
      exitCode: number;
      stderr: string;
      code: string;
      retryable: boolean;
    };

    expect(result.isError).toBe(true);
    expect(payload.exitCode).toBe(7);
    expect(payload.stderr).toBe("failed");
    expect(payload.code).toBe("COMMAND_FAILED");
    expect(payload.retryable).toBe(true);
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
