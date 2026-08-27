export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "code"; value: string };

export type RichTextBlock =
  | { kind: "heading"; level: number; content: InlineToken[] }
  | { kind: "paragraph"; content: InlineToken[] }
  | { kind: "quote"; content: InlineToken[] }
  | { kind: "list"; ordered: boolean; items: InlineToken[][] }
  | { kind: "code"; language: string; value: string };

export function parseSafeMarkdown(input: string): RichTextBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: RichTextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ kind: "code", language: fence[1]?.trim() ?? "", value: code.join("\n") });
      continue;
    }

    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        content: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(/^\s*>\s?(.*)$/);
        if (!match) {
          break;
        }
        quoteLines.push(match[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", content: parseInline(quoteLines.join(" ")) });
      continue;
    }

    const listItem = parseListItem(line);
    if (listItem) {
      const items: InlineToken[][] = [];
      const ordered = listItem.ordered;
      while (index < lines.length) {
        const item = parseListItem(lines[index] ?? "");
        if (!item || item.ordered !== ordered) {
          break;
        }
        items.push(parseInline(item.value));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || isBlockStart(current)) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}

export function parseInline(value: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      tokens.push({ kind: "text", value: value.slice(cursor, start) });
    }
    if (match[2] !== undefined) {
      tokens.push({ kind: "strong", value: match[2] });
    } else {
      tokens.push({ kind: "code", value: match[3] ?? "" });
    }
    cursor = start + match[0].length;
  }
  if (cursor < value.length) {
    tokens.push({ kind: "text", value: value.slice(cursor) });
  }
  return tokens.length > 0 ? tokens : [{ kind: "text", value }];
}

export function compactMarkdownText(value: string, maxLength = 220): string {
  const compact = value
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/^\s{0,3}#{1,4}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}…` : compact;
}

function parseListItem(line: string): { ordered: boolean; value: string } | null {
  const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
  if (unordered) {
    return { ordered: false, value: unordered[1] ?? "" };
  }
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  return ordered ? { ordered: true, value: ordered[1] ?? "" } : null;
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```[^`]*$/.test(line) ||
    /^\s*#{1,4}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    parseListItem(line) !== null
  );
}
