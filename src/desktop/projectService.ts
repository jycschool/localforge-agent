import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FileSnapshot, ProjectFile, ProjectSnapshot } from "./contracts";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "node_modules",
  "dist",
  "coverage",
  ".vscode-test",
  "target",
  "venv",
]);
const MAX_FILES = 2_000;
const MAX_PREVIEW_BYTES = 1_000_000;

export async function scanProject(rootPath: string): Promise<ProjectSnapshot> {
  const rootRealPath = await realpath(rootPath);
  const files: ProjectFile[] = [];
  let limited = false;

  async function walk(directory: string): Promise<void> {
    if (limited) {
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (files.length >= MAX_FILES) {
        limited = true;
        return;
      }
      const info = await stat(absolutePath);
      files.push({
        relativePath: normalizeRelative(path.relative(rootRealPath, absolutePath)),
        size: info.size,
      });
    }
  }

  await walk(rootRealPath);
  return {
    name: path.basename(rootRealPath),
    rootPath: rootRealPath,
    files,
    limited,
  };
}

export async function readProjectFile(
  rootPath: string,
  relativePath: string,
): Promise<FileSnapshot> {
  if (!relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error("请选择项目内的有效文件。");
  }
  const rootRealPath = await realpath(rootPath);
  const lexicalPath = path.resolve(rootRealPath, relativePath);
  if (!isPathInside(rootRealPath, lexicalPath)) {
    throw new Error("不能读取项目目录之外的文件。");
  }
  const fileRealPath = await realpath(lexicalPath);
  if (!isPathInside(rootRealPath, fileRealPath)) {
    throw new Error("该文件指向项目目录之外的位置。");
  }
  const info = await stat(fileRealPath);
  if (!info.isFile()) {
    throw new Error("所选路径不是文件。");
  }
  if (info.size > MAX_PREVIEW_BYTES) {
    throw new Error("文件超过 1 MB，暂不在代码预览中打开。");
  }
  const content = await readFile(fileRealPath, "utf8");
  return {
    relativePath: normalizeRelative(path.relative(rootRealPath, fileRealPath)),
    content,
    size: info.size,
    language: languageFor(relativePath),
  };
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function languageFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const languages: Record<string, string> = {
    ".css": "CSS",
    ".html": "HTML",
    ".js": "JavaScript",
    ".json": "JSON",
    ".jsx": "JavaScript React",
    ".md": "Markdown",
    ".py": "Python",
    ".rs": "Rust",
    ".sh": "Shell",
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".yaml": "YAML",
    ".yml": "YAML",
  };
  return languages[extension] ?? (extension.slice(1).toUpperCase() || "Text");
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}
