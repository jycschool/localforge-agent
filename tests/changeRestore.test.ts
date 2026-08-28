import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTrackedChanges,
  restoreTrackedChanges,
} from "../src/agent/changeRestore";
import { ChangeTracker } from "../src/agent/changeTracker";

describe("safe change restore", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), "localforge-restore-"));
    await mkdir(path.join(rootPath, "src"));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("restores a tracked edit and removes it from the change list", async () => {
    const tracker = new ChangeTracker();
    tracker.capture("src/app.ts", "before\n");
    await writeFile(path.join(rootPath, "src", "app.ts"), "after\n");
    const [change] = await collectTrackedChanges(rootPath, tracker);

    const result = await restoreTrackedChanges(rootPath, tracker, {
      files: [{ relativePath: change!.relativePath, currentHash: change!.currentHash }],
    });

    expect(await readFile(path.join(rootPath, "src", "app.ts"), "utf8")).toBe("before\n");
    expect(result.restoredFiles).toEqual(["src/app.ts"]);
    expect(result.changes).toEqual([]);
  });

  it("deletes a newly created tracked file", async () => {
    const tracker = new ChangeTracker();
    tracker.capture("src/new.ts", null);
    await writeFile(path.join(rootPath, "src", "new.ts"), "new file\n");
    const [change] = await collectTrackedChanges(rootPath, tracker);

    await restoreTrackedChanges(rootPath, tracker, {
      files: [{ relativePath: change!.relativePath, currentHash: change!.currentHash }],
    });

    await expect(readFile(path.join(rootPath, "src", "new.ts"), "utf8")).rejects.toThrow();
  });

  it("refuses to overwrite an external edit", async () => {
    const tracker = new ChangeTracker();
    tracker.capture("src/app.ts", "before\n");
    await writeFile(path.join(rootPath, "src", "app.ts"), "agent edit\n");
    const [change] = await collectTrackedChanges(rootPath, tracker);
    await writeFile(path.join(rootPath, "src", "app.ts"), "external edit\n");

    await expect(
      restoreTrackedChanges(rootPath, tracker, {
        files: [{ relativePath: change!.relativePath, currentHash: change!.currentHash }],
      }),
    ).rejects.toThrow("又被修改");
    expect(await readFile(path.join(rootPath, "src", "app.ts"), "utf8")).toBe("external edit\n");
  });
});
