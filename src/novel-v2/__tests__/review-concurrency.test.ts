import { describe, expect, it } from "vitest";
import { runReviewersConcurrently } from "../application/review-concurrency";

describe("review concurrency", () => {
  it("starts internal and independent reviewers before awaiting any result", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const resultsPromise = runReviewersConcurrently(async (role) => {
      started.push(role);
      await gate;
      return role;
    });

    await Promise.resolve();
    expect(started).toEqual(["structure-reviewer", "character-reviewer", "prose-reviewer"]);
    release();
    const results = await resultsPromise;
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  });
});
