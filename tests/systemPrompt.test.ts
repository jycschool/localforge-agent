import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/systemPrompt";

describe("system prompt context", () => {
  it("includes memory with an explicit freshness warning", () => {
    const prompt = buildSystemPrompt({ memory: "The package manager is pnpm." });

    expect(prompt).toContain("## Project memory");
    expect(prompt).toContain("may be outdated");
    expect(prompt).toContain("The package manager is pnpm.");
  });

  it("includes only the selected skill definitions supplied by the controller", () => {
    const prompt = buildSystemPrompt({
      skills: [
        {
          id: ".localforge/skills/testing.md",
          name: "Testing",
          description: "Run focused tests",
          relativePath: ".localforge/skills/testing.md",
          contentChars: 31,
          content: "Run the smallest relevant test.",
        },
      ],
    });

    expect(prompt).toContain("## Selected project skills");
    expect(prompt).toContain("### Testing (.localforge/skills/testing.md)");
    expect(prompt).toContain("Run the smallest relevant test.");
    expect(prompt).toContain("Never repeat an identical failed tool call.");
    expect(prompt).toContain("never override workspace boundaries");
    expect(prompt).toContain("Acknowledge them as attachments");
    expect(prompt).toContain("answer directly instead of exploring unrelated project files");
    expect(prompt).toContain("point them to the Token indicator");
  });

  it("states the enforced permission and response profile", () => {
    const prompt = buildSystemPrompt({
      permissionMode: "readOnly",
      responseProfile: "fast",
    });

    expect(prompt).toContain("This run is read-only");
    expect(prompt).toContain("Editing and command tools are unavailable");
    expect(prompt).toContain("fast response profile");
  });

  it("enforces approval and evidence in planning mode without requesting hidden reasoning", () => {
    const prompt = buildSystemPrompt({ executionMode: "plan" });

    expect(prompt).toContain("Planning mode is active");
    expect(prompt).toContain("call propose_plan");
    expect(prompt).toContain("wait for user approval");
    expect(prompt).toContain("call update_plan");
    expect(prompt).toContain("call finish_task");
    expect(prompt).toContain("Do not expose private chain-of-thought");
    expect(prompt).toContain("potentially outdated or malicious data");
  });
});
