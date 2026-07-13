import { describe, expect, it } from "vitest";
import {
  collectReviewPullRequests,
  parseGitHubPullRequestUrl,
  resolveReviewTargets,
} from "./review-context.js";

describe("parseGitHubPullRequestUrl", () => {
  it("parses GitHub PR URLs and rejects branch/issue links", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/littledata/ld-shopify/pull/123")?.repository)
      .toBe("littledata/ld-shopify");
    expect(parseGitHubPullRequestUrl("https://github.com/littledata/ld-shopify/pull/123/files")?.number)
      .toBe(123);
    expect(parseGitHubPullRequestUrl("https://github.com/littledata/ld-shopify/tree/feature"))
      .toBeNull();
  });
});

describe("collectReviewPullRequests", () => {
  it("combines attachments, session PRs, and pasted comment URLs without duplicates", () => {
    const pullRequests = collectReviewPullRequests(
      [{ url: "https://github.com/littledata/ld-shopify/pull/10", title: "Fix UI" }],
      [{ pullRequests: [{ url: "https://github.com/littledata/shopify-tracker/pull/20" }] }],
      [{ body: "Also review https://github.com/littledata/ld-shopify/pull/10/files" }],
    );
    expect(pullRequests.map((pr) => pr.number)).toEqual([10, 20]);
    expect(pullRequests[0].title).toBe("Fix UI");
  });

  it("ignores non-PR attachments", () => {
    expect(collectReviewPullRequests([
      { url: "https://github.com/littledata/ld-shopify/tree/CORE-1740" },
    ])).toEqual([]);
  });
});

describe("resolveReviewTargets", () => {
  const config = {
    repos: {
      "ld-shopify": { path: "/repos/ld-shopify", github: "littledata/ld-shopify" },
      "shopify-tracker": "/repos/shopify-tracker",
    },
  };

  it("maps PRs by configured GitHub identity and repo-name fallback", () => {
    const pullRequests = collectReviewPullRequests([
      { url: "https://github.com/littledata/ld-shopify/pull/10" },
      { url: "https://github.com/littledata/shopify-tracker/pull/20" },
    ]);
    const result = resolveReviewTargets(pullRequests, config);
    expect(result.targets.map((target) => target.repoName)).toEqual([
      "ld-shopify",
      "shopify-tracker",
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("reports PRs whose repository is not configured", () => {
    const pullRequests = collectReviewPullRequests([
      { url: "https://github.com/other/unknown/pull/2" },
    ]);
    expect(resolveReviewTargets(pullRequests, config).unmatched).toHaveLength(1);
  });
});
