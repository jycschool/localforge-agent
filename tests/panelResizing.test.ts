import { describe, expect, it } from "vitest";

import { clampSplitHeight } from "../src/renderer/features/panelResizing";

describe("panel split resizing", () => {
  it("keeps a requested height that leaves room for both panes", () => {
    expect(clampSplitHeight(420, 700, 150, 120)).toBe(420);
  });

  it("protects the minimum height of the upper pane", () => {
    expect(clampSplitHeight(40, 700, 150, 120)).toBe(150);
  });

  it("protects the minimum height of the lower pane", () => {
    expect(clampSplitHeight(690, 700, 150, 120)).toBe(580);
  });

  it("keeps the upper minimum in a temporarily undersized container", () => {
    expect(clampSplitHeight(200, 240, 150, 120)).toBe(150);
  });
});
