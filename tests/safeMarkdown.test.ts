import { describe, expect, it } from "vitest";
import {
  compactMarkdownText,
  parseInline,
  parseSafeMarkdown,
} from "../src/renderer/shared/safeMarkdown";

describe("safe Markdown parser", () => {
  it("parses headings, emphasis, code and ordered lists", () => {
    expect(
      parseSafeMarkdown("## 结果\n\n修复了 **边界条件** 和 `membership`。\n\n1. 首测失败\n2. 复测通过"),
    ).toEqual([
      { kind: "heading", level: 2, content: [{ kind: "text", value: "结果" }] },
      {
        kind: "paragraph",
        content: [
          { kind: "text", value: "修复了 " },
          { kind: "strong", value: "边界条件" },
          { kind: "text", value: " 和 " },
          { kind: "code", value: "membership" },
          { kind: "text", value: "。" },
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [
          [{ kind: "text", value: "首测失败" }],
          [{ kind: "text", value: "复测通过" }],
        ],
      },
    ]);
  });

  it("keeps fenced code as one literal block", () => {
    expect(parseSafeMarkdown("```js\nconst value = 1 < 2;\n```"))
      .toEqual([{ kind: "code", language: "js", value: "const value = 1 < 2;" }]);
  });

  it("treats HTML-looking model output as plain text", () => {
    expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([
      { kind: "text", value: '<img src=x onerror="alert(1)">' },
    ]);
  });

  it("supports block quotes and unterminated code fences", () => {
    expect(parseSafeMarkdown("> 安全边界\n> 不可覆盖\n\n```\nraw"))
      .toEqual([
        {
          kind: "quote",
          content: [{ kind: "text", value: "安全边界 不可覆盖" }],
        },
        { kind: "code", language: "", value: "raw" },
      ]);
  });

  it("compacts formatting without deleting comparison operators", () => {
    expect(
      compactMarkdownText("## 结果\n\n**判断**：`subtotal` > threshold，修复后 >= threshold。"),
    ).toBe("结果 判断：subtotal > threshold，修复后 >= threshold。");
    expect(compactMarkdownText("123456", 5)).toBe("1234…");
  });
});
