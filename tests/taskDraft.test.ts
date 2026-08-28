import { describe, expect, it } from "vitest";
import {
  clearTaskDraft,
  draftKey,
  loadTaskDraft,
  saveTaskDraft,
} from "../src/renderer/taskDraft";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("task draft persistence", () => {
  it("keeps independent drafts for each project and clears submitted text", () => {
    const storage = new MemoryStorage();
    saveTaskDraft(storage, "C:\\projects\\one", "继续检查登录逻辑");
    saveTaskDraft(storage, "C:\\projects\\two", "补充测试");

    expect(loadTaskDraft(storage, "C:\\projects\\one")).toBe("继续检查登录逻辑");
    expect(loadTaskDraft(storage, "C:\\projects\\two")).toBe("补充测试");
    clearTaskDraft(storage, "C:\\projects\\one");
    expect(loadTaskDraft(storage, "C:\\projects\\one")).toBe("");
  });

  it("validates the project path stored inside a hashed draft slot", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      draftKey("C:\\projects\\one"),
      JSON.stringify({ projectPath: "C:\\projects\\other", text: "wrong project" }),
    );

    expect(loadTaskDraft(storage, "C:\\projects\\one")).toBe("");
  });
});
