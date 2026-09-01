import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const htmlPath = path.resolve("src", "renderer", "index.html");

async function rendererHtml(): Promise<string> {
  return readFile(htmlPath, "utf8");
}

describe("desktop renderer contracts", () => {
  it("keeps every element id unique", async () => {
    const html = await rendererHtml();
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);

    expect(duplicateIds).toEqual([]);
  });

  it("keeps labels and accessibility references connected to existing elements", async () => {
    const html = await rendererHtml();
    const ids = new Set(
      [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
    );
    const references = [...html.matchAll(/\b(?:for|aria-controls|aria-labelledby|aria-describedby)="([^"]+)"/g)]
      .flatMap((match) => match[1]?.trim().split(/\s+/) ?? []);
    const missing = references.filter((reference) => !ids.has(reference));

    expect(missing).toEqual([]);
  });

  it("gives every button an explicit type so forms cannot submit accidentally", async () => {
    const html = await rendererHtml();
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    const missingType = buttons.filter((button) => !/\btype="(?:button|submit|reset)"/.test(button));

    expect(buttons.length).toBeGreaterThan(0);
    expect(missingType).toEqual([]);
  });

  it("gives every native dialog an accessible title", async () => {
    const html = await rendererHtml();
    const dialogs = [...html.matchAll(/<dialog\b[^>]*>/g)].map((match) => match[0]);
    const unnamed = dialogs.filter((dialog) => !/\baria-labelledby="[^"]+"/.test(dialog));

    expect(dialogs.length).toBeGreaterThan(0);
    expect(unnamed).toEqual([]);
  });

  it("retains the resizable panes and live status surfaces used by desktop QA", async () => {
    const html = await rendererHtml();
    for (const id of [
      "left-resizer",
      "right-resizer",
      "project-row-resizer",
      "preview-row-resizer",
      "timeline",
      "plan-panel",
      "plan-toggle",
      "approval-dialog",
      "validation-progress",
      "toast",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
