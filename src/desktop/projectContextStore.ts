import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectContextSnapshot, ProjectSkill } from "./contracts";
import { isPathInside } from "./projectService";

export const MAX_MEMORY_CHARS = 12_000;
const MAX_SKILLS = 24;
const MAX_SKILL_BYTES = 32_000;
export const MAX_SELECTED_SKILLS = 8;
const MAX_SELECTED_SKILL_CHARS = 64_000;

export interface ProjectSkillDefinition extends ProjectSkill {
  content: string;
}

interface SavedMemory {
  version: 1;
  projectPath: string;
  memory: string;
  updatedAt: string;
}

export class ProjectContextStore {
  readonly #memoryDirectory: string;

  constructor(storageRoot: string) {
    this.#memoryDirectory = path.join(storageRoot, "project-memory");
  }

  async getContext(rootPath: string): Promise<ProjectContextSnapshot> {
    const [skills, memory] = await Promise.all([
      discoverProjectSkills(rootPath),
      this.getMemory(rootPath),
    ]);
    return {
      skills: skills.map(({ content: _content, ...skill }) => skill),
      memory,
      maxMemoryChars: MAX_MEMORY_CHARS,
      maxSelectedSkills: MAX_SELECTED_SKILLS,
    };
  }

  async getSelectedSkills(
    rootPath: string,
    requestedIds: unknown,
  ): Promise<ProjectSkillDefinition[]> {
    if (!Array.isArray(requestedIds) || !requestedIds.length) {
      return [];
    }
    const selected = new Set(
      requestedIds
        .filter((id): id is string => typeof id === "string")
        .slice(0, MAX_SELECTED_SKILLS),
    );
    let remainingCharacters = MAX_SELECTED_SKILL_CHARS;
    return (await discoverProjectSkills(rootPath)).filter((skill) => {
      if (!selected.has(skill.id) || skill.content.length > remainingCharacters) {
        return false;
      }
      remainingCharacters -= skill.content.length;
      return true;
    });
  }

  async getMemory(rootPath: string): Promise<string> {
    const filePath = await this.#memoryFile(rootPath);
    try {
      const saved = JSON.parse(await readFile(filePath, "utf8")) as Partial<SavedMemory>;
      return typeof saved.memory === "string" ? saved.memory.slice(0, MAX_MEMORY_CHARS) : "";
    } catch (error) {
      if (isMissingFile(error)) {
        return "";
      }
      throw new Error("项目记忆无法读取，请检查 LocalForge 的本地数据。", { cause: error });
    }
  }

  async saveMemory(rootPath: string, memory: string): Promise<ProjectContextSnapshot> {
    if (memory.length > MAX_MEMORY_CHARS) {
      throw new Error(`项目记忆最多 ${MAX_MEMORY_CHARS.toLocaleString()} 个字符。`);
    }
    const resolvedRoot = await realpath(rootPath);
    const filePath = await this.#memoryFile(resolvedRoot);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const payload: SavedMemory = {
      version: 1,
      projectPath: resolvedRoot,
      memory,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.#memoryDirectory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    await rename(temporaryPath, filePath);
    return this.getContext(resolvedRoot);
  }

  async #memoryFile(rootPath: string): Promise<string> {
    const resolved = await realpath(rootPath);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const key = createHash("sha256").update(normalized).digest("hex");
    return path.join(this.#memoryDirectory, `${key}.json`);
  }
}

export async function discoverProjectSkills(rootPath: string): Promise<ProjectSkillDefinition[]> {
  const rootRealPath = await realpath(rootPath);
  const skillsDirectory = path.join(rootRealPath, ".localforge", "skills");
  let skillsRealPath: string;
  let entries;
  try {
    skillsRealPath = await realpath(skillsDirectory);
    if (!isPathInside(rootRealPath, skillsRealPath)) {
      return [];
    }
    entries = await readdir(skillsRealPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }

  const markdownFiles = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_SKILLS);
  const skills: ProjectSkillDefinition[] = [];
  for (const entry of markdownFiles) {
    const absolutePath = path.join(skillsRealPath, entry.name);
    const info = await stat(absolutePath);
    if (info.size > MAX_SKILL_BYTES) {
      continue;
    }
    const content = await readFile(absolutePath, "utf8");
    const relativePath = `.localforge/skills/${entry.name}`;
    const { name, description } = describeSkill(entry.name, content);
    skills.push({ id: relativePath, name, description, relativePath, content });
  }
  return skills;
}

function describeSkill(fileName: string, content: string): Pick<ProjectSkill, "name" | "description"> {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#\s+\S/.test(line));
  const prose = lines.find(
    (line) => line && !line.startsWith("#") && !line.startsWith("```") && !line.startsWith("---"),
  );
  const fallbackName = path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ");
  return {
    name: heading?.replace(/^#\s+/, "").slice(0, 80) || fallbackName,
    description: prose?.slice(0, 160) || "项目自定义工作方式",
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
