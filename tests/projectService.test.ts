import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectFile, scanProject } from "../src/desktop/projectService";

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
    await writeFile(path.join(rootPath, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(path.join(rootPath, "node_modules", "package", "index.js"), "ignored");
    await writeFile(path.join(rootPath, ".venv", "Lib", "module.py"), "ignored");

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
  });

  it("rejects paths that escape the opened project", async () => {
    await expect(readProjectFile(rootPath, "../outside.txt")).rejects.toThrow(
      "不能读取项目目录之外的文件",
    );
  });
});
