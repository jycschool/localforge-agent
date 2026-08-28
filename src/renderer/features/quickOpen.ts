import type { ProjectFile } from "../../desktop/contracts";

export interface QuickOpenMatch {
  relativePath: string;
  fileName: string;
}

export function rankQuickOpen(
  files: readonly ProjectFile[],
  rawQuery: string,
  limit = 60,
): QuickOpenMatch[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  return files
    .map((file) => {
      const relativePath = file.relativePath;
      const lowerPath = relativePath.toLocaleLowerCase();
      const fileName = relativePath.split("/").pop() ?? relativePath;
      const lowerName = fileName.toLocaleLowerCase();
      return {
        relativePath,
        fileName,
        score: quickOpenScore(lowerName, lowerPath, query),
      };
    })
    .filter((match) => match.score !== null)
    .sort((left, right) =>
      (left.score ?? 0) - (right.score ?? 0) ||
      left.relativePath.localeCompare(right.relativePath),
    )
    .slice(0, Math.max(0, limit))
    .map(({ relativePath, fileName }) => ({ relativePath, fileName }));
}

function quickOpenScore(fileName: string, relativePath: string, query: string): number | null {
  if (!query) {
    return relativePath.split("/").length * 10 + relativePath.length;
  }
  if (fileName === query) {
    return 0;
  }
  if (fileName.startsWith(query)) {
    return 100 + fileName.length;
  }
  const nameIndex = fileName.indexOf(query);
  if (nameIndex >= 0) {
    return 300 + nameIndex * 10 + fileName.length;
  }
  const pathIndex = relativePath.indexOf(query);
  if (pathIndex >= 0) {
    return 600 + pathIndex + relativePath.length;
  }
  if (isOrderedSubsequence(query, relativePath)) {
    return 1_000 + relativePath.length;
  }
  return null;
}

function isOrderedSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === query.length) {
        return true;
      }
    }
  }
  return queryIndex === query.length;
}
