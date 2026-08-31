export class LatestRequestGuard {
  private revision = 0;

  begin(): number {
    this.revision += 1;
    return this.revision;
  }

  cancel(): void {
    this.revision += 1;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
