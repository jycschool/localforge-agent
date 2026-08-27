import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside } from "../src/tools/workspaceTools";

describe("isPathInside", () => {
  it("accepts the workspace and descendants", () => {
    const root = path.resolve("workspace");
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, "src", "index.ts"))).toBe(true);
  });

  it("rejects parents and similar-prefix siblings", () => {
    const root = path.resolve("workspace");
    expect(isPathInside(root, path.dirname(root))).toBe(false);
    expect(isPathInside(root, `${root}-other`)).toBe(false);
  });
});

