import { packager } from "@electron/packager";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const outputRoot = resolve(workspaceRoot, "release");
const stagingRoot = resolve(workspaceRoot, "tmp", "windows-package-source");

if (dirname(outputRoot) !== workspaceRoot || dirname(dirname(stagingRoot)) !== workspaceRoot) {
  throw new Error("拒绝清理工作区之外的打包目录或临时目录。");
}

const rootPackage = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
const electronPackage = JSON.parse(
  await readFile(resolve(workspaceRoot, "node_modules", "electron", "package.json"), "utf8"),
);
const runtimePackage = {
  name: rootPackage.name,
  productName: rootPackage.displayName,
  version: rootPackage.version,
  description: rootPackage.description,
  license: rootPackage.license,
  private: true,
  main: "dist/main.js",
};

await rm(outputRoot, { recursive: true, force: true });
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await cp(resolve(workspaceRoot, "dist"), resolve(stagingRoot, "dist"), { recursive: true });
await writeFile(
  resolve(stagingRoot, "package.json"),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
  "utf8",
);

let outputPaths;
try {
  outputPaths = await packager({
    dir: stagingRoot,
    name: "RepoForge",
    platform: "win32",
    arch: "x64",
    electronVersion: electronPackage.version,
    out: outputRoot,
    overwrite: true,
    prune: false,
    asar: true,
    icon: resolve(workspaceRoot, "media", "repoforge-icon.ico"),
  });
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

if (outputPaths.length !== 1) {
  throw new Error(`预期生成 1 个 Windows 应用目录，实际生成 ${outputPaths.length} 个。`);
}

const executablePath = resolve(outputPaths[0], "RepoForge.exe");
const applicationArchivePath = resolve(outputPaths[0], "resources", "app.asar");
await Promise.all([access(executablePath), access(applicationArchivePath)]);

console.log(`Windows 应用已生成：${outputPaths[0]}`);
console.log(`启动文件：${executablePath}`);
console.log(`应用归档：${applicationArchivePath}`);
