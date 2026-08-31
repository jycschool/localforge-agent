import { describe, expect, it } from "vitest";
import { LatestRequestGuard } from "../src/renderer/features/latestRequest";

describe("latest request guard", () => {
  it("accepts only the newest request when responses finish out of order", () => {
    const guard = new LatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("invalidates an in-flight request when the preview changes", () => {
    const guard = new LatestRequestGuard();
    const request = guard.begin();
    guard.cancel();

    expect(guard.isCurrent(request)).toBe(false);
  });
});
