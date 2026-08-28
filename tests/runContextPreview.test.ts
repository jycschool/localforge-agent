import { describe, expect, it } from "vitest";
import { buildRunContextPreview } from "../src/desktop/runContextPreview";

describe("run context preview", () => {
  it("describes exactly the bounded context and tools sent to the model", () => {
    const preview = buildRunContextPreview({
      request: {
        task: "检查登录流程",
        selectedFile: "src/login.ts",
        skillIds: [".localforge/skills/review.md", "missing"],
        useMemory: true,
      },
      settings: {
        profileId: "test",
        profileName: "Test model",
        apiBaseUrl: "https://example.test/v1",
        model: "test-model",
        maxSteps: 8,
        commandTimeoutMs: 10_000,
        maxOutputChars: 20_000,
        permissionMode: "readOnly",
        responseProfile: "balanced",
        hasApiKey: true,
        apiKeySource: "saved",
      },
      memory: { memory: "Use pnpm.", updatedAt: "2026-08-28T00:00:00.000Z" },
      skills: [{
        id: ".localforge/skills/review.md",
        name: "Review",
        description: "Review changes",
        relativePath: ".localforge/skills/review.md",
        contentChars: 12,
        content: "Review diff.",
      }],
      attachments: [{ relativePath: "README.md", content: "Demo", size: 4, language: "Markdown", contentHash: "hash" }],
      previousMessages: [{ role: "user", content: "Earlier question" }],
      tools: [{
        schema: {
          type: "function",
          function: { name: "read_file", description: "Read", parameters: { type: "object" } },
        },
        execute: async () => ({ content: "ok" }),
      }],
    });

    expect(preview).toMatchObject({
      model: "test-model",
      selectedFile: "src/login.ts",
      memoryChars: 9,
      conversationMessageCount: 1,
      toolCount: 1,
    });
    expect(preview.estimatedInputTokens).toBeGreaterThan(0);
    expect(preview.skills).toHaveLength(1);
    expect(preview.attachments).toEqual([
      { relativePath: "README.md", contentChars: 4 },
    ]);
    expect(preview.warnings).toContain("1 个已选 Skill 不存在或超出注入上限。");
  });
});
