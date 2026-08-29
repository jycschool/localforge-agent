import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ProjectContextSnapshot,
  ProjectSkill,
  ProjectSkillInput,
} from "./contracts";
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

export interface ProjectMemoryRecord {
  memory: string;
  updatedAt: string | null;
}

export class ProjectContextStore {
  readonly #memoryDirectory: string;

  constructor(storageRoot: string) {
    this.#memoryDirectory = path.join(storageRoot, "project-memory");
  }

  async getContext(rootPath: string): Promise<ProjectContextSnapshot> {
    const [skills, memoryRecord] = await Promise.all([
      discoverProjectSkills(rootPath),
      this.getMemoryRecord(rootPath),
    ]);
    return {
      skills: skills.map(({ content: _content, ...skill }) => skill),
      memory: memoryRecord.memory,
      memoryUpdatedAt: memoryRecord.updatedAt,
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

  async getSkill(rootPath: string, id: string): Promise<ProjectSkillDefinition> {
    const fileName = skillFileNameFromId(id);
    const directory = await resolveSkillsDirectory(rootPath, false);
    if (!directory) {
      throw new Error("找不到这个 Skill。");
    }
    const absolutePath = path.join(directory.skillsRealPath, fileName);
    await assertRegularSkillFile(absolutePath, directory.skillsRealPath);
    const info = await stat(absolutePath);
    if (info.size > MAX_SKILL_BYTES) {
      throw new Error(`Skill 文件不能超过 ${MAX_SKILL_BYTES.toLocaleString()} 字节。`);
    }
    const content = await readFile(absolutePath, "utf8");
    const relativePath = `.localforge/skills/${fileName}`;
    const { name, description } = describeSkill(fileName, content);
    return {
      id: relativePath,
      name,
      description,
      relativePath,
      contentChars: content.length,
      content,
    };
  }

  async saveSkill(
    rootPath: string,
    input: ProjectSkillInput,
  ): Promise<ProjectContextSnapshot> {
    const fileName = validateSkillFileName(input.fileName);
    if (!input.content.trim()) {
      throw new Error("Skill 内容不能为空。");
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_BYTES) {
      throw new Error(`Skill 文件不能超过 ${MAX_SKILL_BYTES.toLocaleString()} 字节。`);
    }

    const directory = await resolveSkillsDirectory(rootPath, true);
    if (!directory) {
      throw new Error("无法创建 Skill 目录。");
    }
    const targetPath = path.join(directory.skillsRealPath, fileName);
    if (input.id) {
      const currentFileName = skillFileNameFromId(input.id);
      if (!samePath(currentFileName, fileName)) {
        throw new Error("编辑 Skill 时不能同时修改文件名，请新建另一个 Skill。");
      }
      await assertRegularSkillFile(targetPath, directory.skillsRealPath);
    } else {
      const entries = await readdir(directory.skillsRealPath, { withFileTypes: true });
      const skillCount = entries.filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"),
      ).length;
      if (skillCount >= MAX_SKILLS) {
        throw new Error(`一个项目最多创建 ${MAX_SKILLS} 个 Skill。`);
      }
      try {
        await lstat(targetPath);
        throw new Error("同名 Skill 已存在，请换一个文件名。");
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    }

    const temporaryPath = path.join(
      directory.skillsRealPath,
      `.${fileName}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(temporaryPath, input.content, "utf8");
    await rename(temporaryPath, targetPath);
    return this.getContext(directory.rootRealPath);
  }

  async deleteSkill(rootPath: string, id: string): Promise<ProjectContextSnapshot> {
    const fileName = skillFileNameFromId(id);
    const directory = await resolveSkillsDirectory(rootPath, false);
    if (!directory) {
      throw new Error("找不到这个 Skill。");
    }
    const targetPath = path.join(directory.skillsRealPath, fileName);
    await assertRegularSkillFile(targetPath, directory.skillsRealPath);
    await unlink(targetPath);
    return this.getContext(directory.rootRealPath);
  }

  async getMemory(rootPath: string): Promise<string> {
    return (await this.getMemoryRecord(rootPath)).memory;
  }

  async getMemoryRecord(rootPath: string): Promise<ProjectMemoryRecord> {
    const filePath = await this.#memoryFile(rootPath);
    try {
      const saved = JSON.parse(await readFile(filePath, "utf8")) as Partial<SavedMemory>;
      return {
        memory: typeof saved.memory === "string"
          ? saved.memory.slice(0, MAX_MEMORY_CHARS)
          : "",
        updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : null,
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { memory: "", updatedAt: null };
      }
      throw new Error("项目记忆无法读取，请检查 RepoForge 的本地数据。", { cause: error });
    }
  }

  async saveMemory(rootPath: string, memory: string): Promise<ProjectContextSnapshot> {
    if (memory.length > MAX_MEMORY_CHARS) {
      throw new Error(`项目记忆最多 ${MAX_MEMORY_CHARS.toLocaleString()} 个字符。`);
    }
    const resolvedRoot = await realpath(rootPath);
    if (!memory.trim()) {
      return this.deleteMemory(resolvedRoot);
    }
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

  async deleteMemory(rootPath: string): Promise<ProjectContextSnapshot> {
    const resolvedRoot = await realpath(rootPath);
    const filePath = await this.#memoryFile(resolvedRoot);
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error("项目记忆无法删除，请检查 RepoForge 的本地数据。", { cause: error });
      }
    }
    return this.getContext(resolvedRoot);
  }

  async #memoryFile(rootPath: string): Promise<string> {
    const resolved = await realpath(rootPath);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const key = createHash("sha256").update(normalized).digest("hex");
    return path.join(this.#memoryDirectory, `${key}.json`);
  }
}

interface SkillsDirectory {
  rootRealPath: string;
  skillsRealPath: string;
}

async function resolveSkillsDirectory(
  rootPath: string,
  create: boolean,
): Promise<SkillsDirectory | null> {
  const rootRealPath = await realpath(rootPath);
  const localForgePath = path.join(rootRealPath, ".localforge");
  if (!(await ensureDirectory(localForgePath, create))) {
    return null;
  }
  const localForgeRealPath = await realpath(localForgePath);
  if (!isPathInside(rootRealPath, localForgeRealPath)) {
    throw new Error("Skill 目录不能指向项目外部。");
  }

  const skillsPath = path.join(localForgeRealPath, "skills");
  if (!(await ensureDirectory(skillsPath, create))) {
    return null;
  }
  const skillsRealPath = await realpath(skillsPath);
  if (
    !isPathInside(rootRealPath, skillsRealPath) ||
    !isPathInside(localForgeRealPath, skillsRealPath)
  ) {
    throw new Error("Skill 目录不能指向项目外部。");
  }
  return { rootRealPath, skillsRealPath };
}

async function ensureDirectory(directoryPath: string, create: boolean): Promise<boolean> {
  try {
    const info = await lstat(directoryPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Skill 存储位置必须是项目内的普通目录。");
    }
    return true;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    if (!create) {
      return false;
    }
    await mkdir(directoryPath);
    return true;
  }
}

async function assertRegularSkillFile(
  absolutePath: string,
  skillsRealPath: string,
): Promise<void> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error("找不到这个 Skill。", { cause: error });
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Skill 必须是普通 Markdown 文件。");
  }
  const resolved = await realpath(absolutePath);
  if (!samePath(path.dirname(resolved), skillsRealPath)) {
    throw new Error("Skill 文件不能指向项目外部。");
  }
}

function skillFileNameFromId(id: string): string {
  const prefix = ".localforge/skills/";
  if (!id.startsWith(prefix)) {
    throw new Error("Skill ID 无效。");
  }
  return validateSkillFileName(id.slice(prefix.length));
}

function validateSkillFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}\.md$/i.test(trimmed)) {
    throw new Error("Skill 文件名只能包含字母、数字、短横线或下划线，并以 .md 结尾。");
  }
  return trimmed;
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
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
    skills.push({
      id: relativePath,
      name,
      description,
      relativePath,
      contentChars: content.length,
      content,
    });
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
