import { describe, expect, it } from "vitest";
import { displayLocalPath } from "../src/renderer/shared/pathDisplay";

describe("displayLocalPath", () => {
  it("masks Windows user profile names", () => {
    expect(displayLocalPath("C:\\Users\\alice\\Desktop\\demo")).toBe(
      "~\\Desktop\\demo",
    );
    expect(displayLocalPath("d:\\users\\student")).toBe("~");
  });

  it("masks macOS and Linux home directories", () => {
    expect(displayLocalPath("/Users/alice/project")).toBe("~/project");
    expect(displayLocalPath("/home/student/project")).toBe("~/project");
  });

  it("keeps non-profile paths unchanged", () => {
    expect(displayLocalPath("D:\\projects\\demo")).toBe("D:\\projects\\demo");
    expect(displayLocalPath("/workspace/demo")).toBe("/workspace/demo");
    expect(displayLocalPath("relative/path")).toBe("relative/path");
  });
});
