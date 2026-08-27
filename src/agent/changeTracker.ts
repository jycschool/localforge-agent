export interface ChangedFile {
  relativePath: string;
  originalContent: string | null;
}

export class ChangeTracker {
  private readonly originals = new Map<string, string | null>();

  public capture(relativePath: string, originalContent: string | null): void {
    if (!this.originals.has(relativePath)) {
      this.originals.set(relativePath, originalContent);
    }
  }

  public list(): ChangedFile[] {
    return Array.from(this.originals, ([relativePath, originalContent]) => ({
      relativePath,
      originalContent,
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  public clear(): void {
    this.originals.clear();
  }
}

