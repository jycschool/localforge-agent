import { describe, expect, it } from "vitest";
import { fileVisualFor } from "../src/renderer/shared/fileIcons";

describe("fileVisualFor", () => {
  it("uses distinct visuals for common source files", () => {
    expect(fileVisualFor("src/app.ts")).toEqual({ className: "icon-ts", label: "TS" });
    expect(fileVisualFor("src/app.py")).toEqual({ className: "icon-python", label: "PY" });
    expect(fileVisualFor("README.md")).toEqual({ className: "icon-markdown", label: "MD" });
    expect(fileVisualFor("demo/shipping.mjs")).toEqual({ className: "icon-js", label: "JS" });
  });

  it("marks test and configuration files before generic extensions", () => {
    expect(fileVisualFor("tests/app.test.ts").className).toBe("icon-test");
    expect(fileVisualFor("package.json").className).toBe("icon-config");
    expect(fileVisualFor(".gitignore").className).toBe("icon-config");
  });

  it("falls back to a neutral document icon", () => {
    expect(fileVisualFor("LICENSE")).toEqual({ className: "icon-default", label: "" });
    expect(fileVisualFor("assets/example.unknown")).toEqual({
      className: "icon-default",
      label: "",
    });
  });
});
