export type CodeSelectionAction = "explain" | "review" | "modify" | "test" | "attach";

export interface CodeSelectionDraft {
  relativePath: string;
  language: string;
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface NormalizedCodeSelection {
  relativePath: string;
  language: string;
  snippet: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

const MAX_SELECTION_CHARS = 8_000;

export function normalizeCodeSelection(
  draft: CodeSelectionDraft,
): NormalizedCodeSelection | null {
  const start = Math.max(0, Math.min(draft.startOffset, draft.endOffset, draft.content.length));
  const end = Math.max(start, Math.min(Math.max(draft.startOffset, draft.endOffset), draft.content.length));
  const raw = draft.content.slice(start, end);
  if (!raw.trim()) return null;
  const clipped = raw.slice(0, MAX_SELECTION_CHARS);
  const startLine = lineNumberAt(draft.content, start);
  const endLine = lineNumberAt(draft.content, start + Math.max(0, clipped.length - 1));
  return {
    relativePath: draft.relativePath,
    language: draft.language,
    snippet: clipped,
    startLine,
    endLine,
    truncated: raw.length > clipped.length,
  };
}

export function buildCodeSelectionTask(
  action: CodeSelectionAction,
  selection: NormalizedCodeSelection,
): string {
  const instructions: Record<CodeSelectionAction, string> = {
    explain: "请解释这段代码的作用、关键流程和重要边界情况。",
    review: "请检查这段代码是否存在缺陷、安全问题或可维护性问题，并给出有依据的结论。",
    modify: "请根据我接下来补充的要求修改这段代码：",
    test: "请为这段代码补充有价值的自动化测试，并运行相关测试验证。",
    attach: "请围绕这段代码完成下面的任务：",
  };
  const language = safeFenceLanguage(selection.language);
  const clippedNotice = selection.truncated
    ? "（选区较长，任务中只保留前 8,000 个字符。）"
    : "";
  return [
    instructions[action],
    "",
    `选中位置：\`${selection.relativePath}\` 第 ${selection.startLine}—${selection.endLine} 行`,
    ...(clippedNotice ? [clippedNotice] : []),
    "",
    `\`\`\`${language}`,
    selection.snippet,
    "```",
    ...(action === "modify" || action === "attach" ? ["", "补充要求："] : []),
  ].join("\n");
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") line += 1;
  }
  return line;
}

function safeFenceLanguage(language: string): string {
  return /^[a-z0-9_+#.-]{1,32}$/i.test(language) ? language : "text";
}
