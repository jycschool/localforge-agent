export type LineEnding = "\n" | "\r\n";

export function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeEditorContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

export function serializeEditorContent(content: string, lineEnding: LineEnding): string {
  const normalized = normalizeEditorContent(content);
  return lineEnding === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

export function isEditorDirty(current: string, originalNormalized: string): boolean {
  return normalizeEditorContent(current) !== originalNormalized;
}

export function editorByteLength(content: string, lineEnding: LineEnding): number {
  return new TextEncoder().encode(serializeEditorContent(content, lineEnding)).length;
}
