import { describe, expect, it } from "vitest";
import {
  detectLineEnding,
  editorByteLength,
  isEditorDirty,
  normalizeEditorContent,
  serializeEditorContent,
} from "../src/renderer/features/manualEditor";

describe("manual editor text handling", () => {
  it("normalizes editor text while preserving the original CRLF style on save", () => {
    const original = "first\r\nsecond\r\n";

    expect(detectLineEnding(original)).toBe("\r\n");
    expect(normalizeEditorContent(original)).toBe("first\nsecond\n");
    expect(serializeEditorContent("first\nchanged\n", "\r\n")).toBe(
      "first\r\nchanged\r\n",
    );
  });

  it("detects changes without treating browser newline normalization as an edit", () => {
    expect(isEditorDirty("a\nb\n", normalizeEditorContent("a\r\nb\r\n"))).toBe(false);
    expect(isEditorDirty("a\nchanged\n", "a\nb\n")).toBe(true);
  });

  it("counts serialized UTF-8 bytes rather than JavaScript characters", () => {
    expect(editorByteLength("你好\n", "\n")).toBe(7);
    expect(editorByteLength("a\nb", "\r\n")).toBe(4);
  });
});
