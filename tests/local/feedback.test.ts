import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimOutcomeInvitation,
  DEFAULT_FEEDBACK_URL,
  feedbackBaseUrl,
  feedbackUrl,
  readFeedbackPrefs,
  reportFeedback,
  runOutcomeOf,
  runnerFamilyOf,
  setInvitations
} from "../../src/local/feedback.js";

const dirs: string[] = [];
function prefsEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "opro-fb-"));
  dirs.push(dir);
  return { ORANGEPRO_FEEDBACK_PREFS: join(dir, "feedback-prefs.json"), ...extra };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("feedback links (FB01, FB08)", () => {
  it("puts everything after # so loading the form sends nothing, and carries no project data", () => {
    const url = feedbackUrl({ entry: "result", answer: "partly", patch: true, context: { toolVersion: "0.2.57", runnerFamily: "pytest", runOutcome: "complete" } }, {})!;
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(DEFAULT_FEEDBACK_URL);
    expect(parsed.search).toBe("");
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    expect(Object.fromEntries(fragment)).toEqual({ sv: "1", entry: "result", answer: "partly", patch: "1", ctx_v: "0.2.57", ctx_runner: "pytest", ctx_outcome: "complete" });
  });

  it("drops anything outside the allowlist and invalid context values", () => {
    const url = feedbackUrl(
      { entry: "finding", answer: "yes", patch: true, variant: "empty", context: { toolVersion: "not a version /etc/passwd", runnerFamily: "rspec" as never } },
      {}
    )!;
    expect(Object.fromEntries(new URLSearchParams(new URL(url).hash.slice(1)))).toEqual({ sv: "1", entry: "finding" });
  });

  it("can point at another form or be turned off entirely", () => {
    expect(feedbackBaseUrl({ ORANGEPRO_FEEDBACK_URL: "https://forms.example.com/opro?x=1#y" })).toBe("https://forms.example.com/opro");
    expect(feedbackBaseUrl({ ORANGEPRO_FEEDBACK_URL: "off" })).toBeNull();
    expect(feedbackUrl({ entry: "result" }, { ORANGEPRO_FEEDBACK_URL: "off" })).toBeNull();
    expect(feedbackBaseUrl({ ORANGEPRO_FEEDBACK_URL: "javascript:alert(1)" })).toBe(DEFAULT_FEEDBACK_URL);
  });

  it("reduces the framework label to a coarse runner family", () => {
    expect(runnerFamilyOf("pytest")).toBe("pytest");
    expect(runnerFamilyOf("@testing-library/react, Next.js, vitest")).toBe("vitest");
    expect(runnerFamilyOf("@testing-library/react, jest, playwright, pytest")).toBe("mixed");
    expect(runnerFamilyOf("Unknown framework")).toBe("other");
  });
});

describe("blocked runs vs completed runs (FB03)", () => {
  it("treats a partial or empty analysis as incomplete", () => {
    expect(runOutcomeOf({ files_cap_hit: true }, 10)).toBe("incomplete");
    expect(runOutcomeOf({ not_analyzed_due_to_budget: { files_not_analyzed: 3, elapsed_ms: 1, budget_ms: 1 } }, 10)).toBe("incomplete");
    expect(runOutcomeOf({ tree_sitter: { loaded: [], failed: ["python"], downgraded: ["python"] } }, 10)).toBe("incomplete");
    expect(runOutcomeOf({}, 0)).toBe("incomplete");
    expect(runOutcomeOf({ files_scanned: 40 }, 10)).toBe("complete");
  });

  it("an incomplete run asks what stopped it and never uses the completed-empty question or the invitation", () => {
    let claimed = false;
    const fb = reportFeedback({ analysis: { files_cap_hit: true }, behaviorTotal: 12, findings: 0, hasPatch: false, invite: () => (claimed = true) }, {})!;
    expect(fb.prompt.kind).toBe("blocked");
    expect(fb.prompt.question).not.toMatch(/gap we didn't find/i);
    expect(new URLSearchParams(new URL(fb.general).hash.slice(1)).get("entry")).toBe("blocked");
    expect(claimed).toBe(false);
  });

  it("a completed run with no findings asks about a missed gap, without failure wording", () => {
    const fb = reportFeedback({ behaviorTotal: 12, findings: 0, hasPatch: false, invite: true }, {})!;
    expect(fb.prompt.kind).toBe("empty");
    expect(fb.prompt.question).toBe("Expected a gap we didn't find?");
    expect(fb.prompt.answers.map((a) => a.label)).toEqual(["Yes", "No", "Not sure"]);
    expect(fb.prompt.question).not.toMatch(/stop|fail|block/i);
    for (const a of fb.prompt.answers) expect(new URLSearchParams(new URL(a.url).hash.slice(1)).get("variant")).toBe("empty");
  });

  it("a completed run with findings asks whether it helped; patch-use choices only when a test was generated", () => {
    const withPatch = reportFeedback({ behaviorTotal: 12, findings: 5, hasPatch: true, invite: true }, {})!;
    expect(withPatch.prompt.question).toBe("Did this help you decide what to test?");
    expect(withPatch.prompt.answers.map((a) => a.label)).toEqual(["Yes", "Partly", "No"]);
    expect(new URLSearchParams(new URL(withPatch.prompt.answers[0].url).hash.slice(1)).get("patch")).toBe("1");
    const noPatch = reportFeedback({ behaviorTotal: 12, findings: 5, hasPatch: false, invite: true }, {})!;
    expect(new URLSearchParams(new URL(noPatch.prompt.answers[0].url).hash.slice(1)).get("patch")).toBeNull();
    expect(new URLSearchParams(new URL(noPatch.finding).hash.slice(1)).get("entry")).toBe("finding");
  });
});

describe("quiet invitations (FB07)", () => {
  it("shows the invitation once per cooldown window, then again after it", () => {
    const env = prefsEnv();
    const t0 = new Date("2026-10-01T00:00:00Z");
    expect(claimOutcomeInvitation(t0, env)).toBe(true);
    expect(claimOutcomeInvitation(new Date("2026-10-01T00:05:00Z"), env)).toBe(false);
    expect(claimOutcomeInvitation(new Date("2026-10-14T23:00:00Z"), env)).toBe(false);
    expect(claimOutcomeInvitation(new Date("2026-10-15T00:00:01Z"), env)).toBe(true);
  });

  it("honours a configured cooldown", () => {
    const env = prefsEnv({ ORANGEPRO_FEEDBACK_COOLDOWN_DAYS: "1" });
    expect(claimOutcomeInvitation(new Date("2026-10-01T00:00:00Z"), env)).toBe(true);
    expect(claimOutcomeInvitation(new Date("2026-10-02T00:00:01Z"), env)).toBe(true);
  });

  it("'off' stops the invitation until turned back on, and stores only local preference and timing", () => {
    const env = prefsEnv();
    expect(setInvitations("off", env)).toBe(true);
    expect(claimOutcomeInvitation(new Date(), env)).toBe(false);
    expect(setInvitations("on", env)).toBe(true);
    expect(claimOutcomeInvitation(new Date(), env)).toBe(true);
    const stored = JSON.parse(readFileSync(env.ORANGEPRO_FEEDBACK_PREFS, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["invitations", "last_invited_at"]);
    expect(readFeedbackPrefs(env).invitations).toBe("on");
  });

  it("stays silent when the preference cannot be saved, rather than asking every time", () => {
    const env = prefsEnv();
    // A regular file where the preferences folder should be makes every write fail.
    const blocker = join(env.ORANGEPRO_FEEDBACK_PREFS, "..", "blocker");
    writeFileSync(blocker, "");
    env.ORANGEPRO_FEEDBACK_PREFS = join(blocker, "x", "feedback-prefs.json");
    expect(claimOutcomeInvitation(new Date(), env)).toBe(false);
  });

  it("with links turned off there is no invitation and no preference write", () => {
    const env = prefsEnv({ ORANGEPRO_FEEDBACK_URL: "off" });
    expect(claimOutcomeInvitation(new Date(), env)).toBe(false);
    expect(reportFeedback({ behaviorTotal: 3, findings: 1, hasPatch: false, invite: true }, env)).toBeUndefined();
  });
});
