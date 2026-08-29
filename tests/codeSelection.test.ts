import { describe, expect, it } from "vitest";
import {
  buildCodeSelectionTask,
  normalizeCodeSelection,
} from "../src/renderer/features/codeSelection";

describe("code selection task", () => {
  it("turns a bounded selection into an inspectable task draft with line numbers", () => {
    const content = "const one = 1;\nconst two = 2;\nreturn one + two;\n";
    const selection = normalizeCodeSelection({
      relativePath: "src/sum.ts",
      language: "typescript",
      content,
      startOffset: content.indexOf("const two"),
      endOffset: content.indexOf("return") + "return one + two;".length,
    });

    expect(selection).toMatchObject({ startLine: 2, endLine: 3 });
    const task = buildCodeSelectionTask("test", selection!);
    expect(task).toContain("`src/sum.ts` 第 2—3 行");
    expect(task).toContain("补充有价值的自动化测试");
    expect(task).toContain("\n\n选中位置：");
  });

  it("rejects empty selections and caps content sent through the task field", () => {
    expect(normalizeCodeSelection({
      relativePath: "a.ts",
      language: "typescript",
      content: "  ",
      startOffset: 0,
      endOffset: 2,
    })).toBeNull();

    const selection = normalizeCodeSelection({
      relativePath: "large.txt",
      language: "unknown language",
      content: "x".repeat(9_000),
      startOffset: 0,
      endOffset: 9_000,
    });
    expect(selection?.snippet).toHaveLength(8_000);
    expect(selection?.truncated).toBe(true);
    expect(buildCodeSelectionTask("attach", selection!)).toContain("只保留前 8,000 个字符");
    expect(buildCodeSelectionTask("attach", selection!)).toContain("```text");
  });

  it("does not report a phantom line when the selection ends after a newline", () => {
    const content = "one\ntwo\nthree\n";
    const selection = normalizeCodeSelection({
      relativePath: "notes.txt",
      language: "text",
      content,
      startOffset: 0,
      endOffset: "one\ntwo\n".length,
    });

    expect(selection).toMatchObject({ startLine: 1, endLine: 2, truncated: false });
  });
});
