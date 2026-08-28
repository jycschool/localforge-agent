import { describe, expect, it } from "vitest";
import { rankQuickOpen } from "../src/renderer/features/quickOpen";

const files = [
  { relativePath: "src/main.ts" },
  { relativePath: "src/renderer/app.ts" },
  { relativePath: "tests/mainIpc.test.ts" },
  { relativePath: "README.md" },
];

describe("quick open ranking", () => {
  it("prefers exact and file-name matches over directory-only matches", () => {
    expect(rankQuickOpen(files, "main.ts")[0]?.relativePath).toBe("src/main.ts");
    expect(rankQuickOpen(files, "main").map((match) => match.relativePath)).toEqual([
      "src/main.ts",
      "tests/mainIpc.test.ts",
    ]);
  });

  it("supports case-insensitive path and ordered-subsequence searches", () => {
    expect(rankQuickOpen(files, "RENDERER")[0]?.relativePath).toBe("src/renderer/app.ts");
    expect(rankQuickOpen(files, "rdm")[0]?.relativePath).toBe("README.md");
  });

  it("honors the result limit", () => {
    expect(rankQuickOpen(files, "", 2)).toHaveLength(2);
  });
});
