import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
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
const MAX_PREVIEW_BYTES = 1_000_000;

export async function scanProject(rootPath: string): Promise<ProjectSnapshot> {
  const rootRealPath = await realpath(rootPath);
  const files: ProjectFile[] = [];

  async function walk(directory: string): Promise<void> {
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
      files.push({
        relativePath: normalizeRelative(path.relative(rootRealPath, absolutePath)),
      });
    }
  }

  await walk(rootRealPath);
  return {
    name: path.basename(rootRealPath),
    rootPath: rootRealPath,
    files,
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
  assertTextContent(content);
  return {
    relativePath: normalizeRelative(path.relative(rootRealPath, fileRealPath)),
    content,
    size: info.size,
    language: languageFor(relativePath),
    contentHash: hashContent(content),
  };
}

export async function saveProjectFile(
  rootPath: string,
  relativePath: string,
  content: string,
  expectedHash: string,
): Promise<FileSnapshot> {
  assertWritableContent(content);
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw new Error("文件内容摘要无效，请重新打开文件。");
  }
  const current = await readProjectFile(rootPath, relativePath);
  if (current.contentHash !== expectedHash.toLowerCase()) {
    throw new Error("文件已被其他程序修改，请重新打开后再编辑。");
  }
  const rootRealPath = await realpath(rootPath);
  const fileRealPath = await realpath(path.resolve(rootRealPath, relativePath));
  await writeFile(fileRealPath, content, "utf8");
  return readProjectFile(rootRealPath, current.relativePath);
}

export async function createProjectFile(
  rootPath: string,
  relativePath: string,
  content: string,
): Promise<FileSnapshot> {
  assertWritableContent(content);
  if (!relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error("请输入项目内的有效相对路径。");
  }
  const rootRealPath = await realpath(rootPath);
  const lexicalPath = path.resolve(rootRealPath, relativePath);
  if (!isPathInside(rootRealPath, lexicalPath) || lexicalPath === rootRealPath) {
    throw new Error("不能在项目目录之外新建文件。");
  }
  const parentRealPath = await realpath(path.dirname(lexicalPath)).catch(() => {
    throw new Error("父目录不存在，请先选择项目内已有目录。");
  });
  if (!isPathInside(rootRealPath, parentRealPath)) {
    throw new Error("新文件的父目录指向项目目录之外。");
  }
  const targetPath = path.join(parentRealPath, path.basename(lexicalPath));
  try {
    await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("该文件已经存在，请更换名称。");
    }
    throw error;
  }
  return readProjectFile(rootRealPath, normalizeRelative(path.relative(rootRealPath, targetPath)));
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

function assertWritableContent(content: string): void {
  assertTextContent(content);
  if (Buffer.byteLength(content, "utf8") > MAX_PREVIEW_BYTES) {
    throw new Error("文件超过 1 MB，不能在轻量编辑器中保存。");
  }
}

function assertTextContent(content: string): void {
  if (content.includes("\0")) {
    throw new Error("该文件包含二进制内容，不能在轻量编辑器中打开。");
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}
