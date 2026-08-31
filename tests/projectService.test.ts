import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectFile,
  readProjectFile,
  saveProjectFile,
  scanProject,
} from "../src/desktop/projectService";

describe("desktop project service", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), "localforge-project-"));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("scans source files while excluding generated dependency directories", async () => {
    await mkdir(path.join(rootPath, "src"), { recursive: true });
    await mkdir(path.join(rootPath, "node_modules", "package"), { recursive: true });
    await mkdir(path.join(rootPath, ".venv", "Lib"), { recursive: true });
    await mkdir(path.join(rootPath, "out", "production"), { recursive: true });
    await writeFile(path.join(rootPath, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(rootPath, "node_modules", "package", "index.js"), "ignored");
    await writeFile(path.join(rootPath, ".venv", "Lib", "module.py"), "ignored");
    await writeFile(path.join(rootPath, "out", "production", "Main.class"), "ignored");

    const project = await scanProject(rootPath);

    expect(project.files.map((file) => file.relativePath)).toEqual(["src/app.ts"]);
  });

  it("returns every source file instead of truncating large projects", async () => {
    const sourcePath = path.join(rootPath, "src");
    await mkdir(sourcePath, { recursive: true });
    const fileCount = 2_005;
    const batchSize = 200;
    for (let offset = 0; offset < fileCount; offset += batchSize) {
      await Promise.all(
        Array.from({ length: Math.min(batchSize, fileCount - offset) }, (_, index) =>
          writeFile(path.join(sourcePath, `file-${offset + index}.ts`), ""),
        ),
      );
    }

    const project = await scanProject(rootPath);

    expect(project.files).toHaveLength(fileCount);
    expect(project.files.some((file) => file.relativePath === "src/file-2004.ts")).toBe(true);
  });

  it("reads a UTF-8 project file and reports its preview language", async () => {
    await mkdir(path.join(rootPath, "src"), { recursive: true });
    await writeFile(path.join(rootPath, "src", "app.ts"), "const message = '你好';\n", "utf8");

    const file = await readProjectFile(rootPath, "src/app.ts");

    expect(file.relativePath).toBe("src/app.ts");
    expect(file.language).toBe("TypeScript");
    expect(file.content).toContain("你好");
    expect(file.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("saves a text file only when its opened content hash is still current", async () => {
    await writeFile(path.join(rootPath, "notes.md"), "before\r\n", "utf8");
    const opened = await readProjectFile(rootPath, "notes.md");

    const saved = await saveProjectFile(
      rootPath,
      "notes.md",
      "after\r\n",
      opened.contentHash,
    );

    expect(saved.content).toBe("after\r\n");
    expect(await readFile(path.join(rootPath, "notes.md"), "utf8")).toBe("after\r\n");

    await writeFile(path.join(rootPath, "notes.md"), "external", "utf8");
    await expect(
      saveProjectFile(rootPath, "notes.md", "stale", saved.contentHash),
    ).rejects.toThrow("文件已被其他程序修改");
    expect(await readFile(path.join(rootPath, "notes.md"), "utf8")).toBe("external");
  });

  it("creates a text file in an existing project directory without overwriting", async () => {
    await mkdir(path.join(rootPath, "docs"));

    const created = await createProjectFile(rootPath, "docs/notes.md", "hello\n");

    expect(created.relativePath).toBe("docs/notes.md");
    expect(created.content).toBe("hello\n");
    await expect(createProjectFile(rootPath, "docs/notes.md", "again")).rejects.toThrow(
      "已经存在",
    );
    expect(await readFile(path.join(rootPath, "docs", "notes.md"), "utf8")).toBe(
      "hello\n",
    );
  });

  it("rejects unsafe manual file content and missing or escaping parents", async () => {
    await expect(createProjectFile(rootPath, "missing/notes.md", "hello")).rejects.toThrow(
      "父目录不存在",
    );
    await expect(createProjectFile(rootPath, "../outside.md", "hello")).rejects.toThrow(
      "项目目录之外",
    );
    await expect(createProjectFile(rootPath, "binary.txt", "a\0b")).rejects.toThrow(
      "二进制内容",
    );
  });

  it("rejects paths that escape the opened project", async () => {
    await expect(readProjectFile(rootPath, "../outside.txt")).rejects.toThrow(
      "不能读取项目目录之外的文件",
    );
  });
});
