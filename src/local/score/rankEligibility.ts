export const TEST_SUPPORT_RANKING_REASON_CODE = "test_support_helper" as const;

const TEST_SUPPORT_PATH_RE = /(^|\/)((?:[^/]+-)?e2e[-_]?testing|testing|testutils?|testhelpers?|fixtures?|mocks?|fakes?)(\/|$)/i;

export interface BuiltInRankExclusion {
  code: typeof TEST_SUPPORT_RANKING_REASON_CODE;
  reason: string;
}

/**
 * Built-in ranking-only exclusions. These symbols remain in the graph and keep
 * their denominator eligibility; they simply do not compete with production
 * behaviors in the primary priority worklist.
 */
export function builtInRankExclusion(file: string): BuiltInRankExclusion | undefined {
  if (!TEST_SUPPORT_PATH_RE.test(file)) return undefined;
  return {
    code: TEST_SUPPORT_RANKING_REASON_CODE,
    reason: "Test-support helper — retained in the behavior denominator, excluded from the primary production priority ranking."
  };
}
