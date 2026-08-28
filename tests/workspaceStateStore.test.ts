import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStateStore } from "../src/desktop/workspaceStateStore";

describe("workspace state store", () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), "localforge-workspace-state-"));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("persists and clears the last user-selected project", async () => {
    const store = new WorkspaceStateStore(storageRoot);
    const projectPath = path.join(storageRoot, "demo");

    expect(await store.lastProjectPath()).toBeNull();
    await store.saveLastProjectPath(projectPath);
    expect(await store.lastProjectPath()).toBe(projectPath);
    await store.clearLastProjectPath();
    expect(await store.lastProjectPath()).toBeNull();
  });

  it("ignores corrupt state and rejects renderer-style relative paths", async () => {
    await writeFile(path.join(storageRoot, "workspace-state.json"), "{broken", "utf8");
    const store = new WorkspaceStateStore(storageRoot);

    expect(await store.lastProjectPath()).toBeNull();
    await expect(store.saveLastProjectPath("../not-authorized")).rejects.toThrow(
      "上次项目路径无效",
    );
    expect(await readFile(path.join(storageRoot, "workspace-state.json"), "utf8")).toBe(
      "{broken",
    );
  });
});
