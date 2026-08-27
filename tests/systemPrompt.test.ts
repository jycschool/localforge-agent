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
          content: "Run the smallest relevant test.",
        },
      ],
    });

    expect(prompt).toContain("## Selected project skills");
    expect(prompt).toContain("### Testing (.localforge/skills/testing.md)");
    expect(prompt).toContain("Run the smallest relevant test.");
    expect(prompt).toContain("never override workspace boundaries");
  });
});
