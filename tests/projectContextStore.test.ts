import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverProjectSkills,
  MAX_MEMORY_CHARS,
  ProjectContextStore,
} from "../src/desktop/projectContextStore";

describe("project context store", () => {
  let temporaryRoot: string;
  let projectPath: string;
  let storagePath: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "localforge-context-"));
    projectPath = path.join(temporaryRoot, "project");
    storagePath = path.join(temporaryRoot, "app-data");
    await mkdir(projectPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers bounded Markdown skills and derives display metadata", async () => {
    const skillsPath = path.join(projectPath, ".localforge", "skills");
    await mkdir(skillsPath, { recursive: true });
    await writeFile(
      path.join(skillsPath, "testing.md"),
      "# Test first\n\nRun the smallest relevant test before the full suite.\n",
    );
    await writeFile(path.join(skillsPath, "ignored.txt"), "not a skill");
    await writeFile(path.join(skillsPath, "too-large.md"), "x".repeat(32_001));

    const skills = await discoverProjectSkills(projectPath);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: ".localforge/skills/testing.md",
      name: "Test first",
      description: "Run the smallest relevant test before the full suite.",
    });
    expect(skills[0]?.content).toContain("smallest relevant test");
  });

  it("saves private memory outside the project and isolates it by project", async () => {
    const secondProject = path.join(temporaryRoot, "other-project");
    await mkdir(secondProject);
    const store = new ProjectContextStore(storagePath);

    await store.saveMemory(projectPath, "Use pnpm and keep UI copy in Chinese.");

    expect(await store.getMemory(projectPath)).toContain("Use pnpm");
    expect(await store.getMemory(secondProject)).toBe("");
    const context = await store.getContext(projectPath);
    expect(context.memory).toContain("Chinese");
    expect(context.maxSelectedSkills).toBe(8);
  });

  it("updates memory and rejects content above the documented limit", async () => {
    const store = new ProjectContextStore(storagePath);
    await store.saveMemory(projectPath, "first");
    await store.saveMemory(projectPath, "second");

    expect(await store.getMemory(projectPath)).toBe("second");
    await expect(store.saveMemory(projectPath, "x".repeat(MAX_MEMORY_CHARS + 1))).rejects.toThrow(
      "项目记忆最多",
    );
  });

  it("returns only skills explicitly selected by the renderer", async () => {
    const skillsPath = path.join(projectPath, ".localforge", "skills");
    await mkdir(skillsPath, { recursive: true });
    await writeFile(path.join(skillsPath, "review.md"), "# Review\nCheck the diff.\n");
    await writeFile(path.join(skillsPath, "test.md"), "# Test\nRun tests.\n");
    const store = new ProjectContextStore(storagePath);

    const selected = await store.getSelectedSkills(projectPath, [
      ".localforge/skills/test.md",
      "made-up.md",
    ]);

    expect(selected.map((skill) => skill.name)).toEqual(["Test"]);
    await expect(store.getSelectedSkills(projectPath, "not-an-array")).resolves.toEqual([]);
  });

  it("limits the number of skills injected into one model request", async () => {
    const skillsPath = path.join(projectPath, ".localforge", "skills");
    await mkdir(skillsPath, { recursive: true });
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const fileName = `skill-${index}.md`;
      ids.push(`.localforge/skills/${fileName}`);
      await writeFile(path.join(skillsPath, fileName), `# Skill ${index}\nInstruction ${index}.\n`);
    }
    const store = new ProjectContextStore(storagePath);

    const selected = await store.getSelectedSkills(projectPath, ids);

    expect(selected).toHaveLength(8);
  });
});
