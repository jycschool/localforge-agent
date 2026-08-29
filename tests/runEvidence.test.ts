import { describe, expect, it } from "vitest";
import {
  changeEvidence,
  detectTestEvidence,
  parseCommandEvidence,
  testEvidenceProgress,
} from "../src/renderer/features/runEvidence";

describe("run evidence presentation", () => {
  it("classifies added and modified files with trustworthy line counts", () => {
    expect(changeEvidence({
      relativePath: "src/new.ts",
      originalContent: null,
      currentContent: "one\ntwo\n",
      currentHash: "hash",
    })).toMatchObject({ kind: "added", additions: 2, deletions: 0 });

    expect(changeEvidence({
      relativePath: "src/existing.ts",
      originalContent: "one\ntwo\n",
      currentContent: "one\nthree\nfour\n",
      currentHash: "hash",
    })).toMatchObject({ kind: "modified", additions: 2, deletions: 1 });
  });

  it("parses TAP test evidence and command timing", () => {
    const evidence = parseCommandEvidence(JSON.stringify({
      approved: true,
      command: "pnpm test",
      exitCode: 1,
      stdout: "# tests 6\n# pass 2\n# fail 4",
      stderr: "",
      approvalDurationMs: 120,
      executionDurationMs: 840,
      outputTruncated: false,
    }), "", true, 1_000);

    expect(evidence).toMatchObject({
      command: "pnpm test",
      state: "error",
      exitCode: 1,
      approvalDurationMs: 120,
      executionDurationMs: 840,
      test: { passed: 2, failed: 4, total: 6 },
    });
  });

  it("handles Vitest success and rejected commands without inventing results", () => {
    expect(detectTestEvidence("pnpm test", "Tests  132 passed (132)"))
      .toEqual({ passed: 132, failed: 0, total: 132 });
    expect(testEvidenceProgress({ passed: 3, failed: 1, total: 4 })).toBe(75);

    expect(parseCommandEvidence(JSON.stringify({
      approved: false,
      approvalDurationMs: 20,
      error: "User rejected the command.",
    }), "pnpm build", true, 20)).toMatchObject({
      command: "pnpm build",
      state: "rejected",
      test: undefined,
    });
  });
});
