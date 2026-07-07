import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  opInit,
  opAnalyze,
  opDoctor,
  opGaps,
  opGenerate,
  opExplain,
  opChanged,
  opUpdate
} from "../../src/local/operations.js";
import { redactSecrets, containsSecret } from "../../src/local/util/redact.js";

// Generation defaults to opt-in deterministic stand-in for offline determinism.
const deps = { clock: () => "2026-06-07T00:00:00Z", env: { ORANGEPRO_ALLOW_DETERMINISTIC: "1" } as NodeJS.ProcessEnv };
const dirs: string[] = [];

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "oplocal-ops-"));
  dirs.push(d);
  return d;
}

function scaffold(root: string): void {
  mkdirSync(join(root, "src/payments"), { recursive: true });
  mkdirSync(join(root, "tests/payments"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src/payments/card.ts"), "export function saveCard(n: string) { return n; }\n");
  writeFileSync(
    join(root, "tests/payments/card.test.ts"),
    'import { it, expect } from "vitest";\nit("saves a card", () => { expect(1).toBe(1); });\n'
  );
  writeFileSync(
    join(root, "payments-template.csv"),
    [
      "behavior_name,description,acceptance_criteria,actor_or_role,priority_or_risk,source_ref",
      '"Save a card","Customer saves a card","Card is validated; Saved card appears",buyer,high,PAY-1'
    ].join("\n")
  );
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("operation-level coverage", () => {
  it("opDoctor returns prioritized recommendations and status", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const doctor = opDoctor(root);
    expect(doctor.recommendations.length).toBeGreaterThan(0);
    expect(typeof doctor.status).toBe("string");
    expect(doctor.recommendations[0].priority).toBe(1);
  });

  it("opGaps returns gaps for behaviors lacking test evidence", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const gaps = opGaps(root, { limit: 10 });
    expect(gaps.total_behaviors).toBeGreaterThan(0);
    expect(Array.isArray(gaps.gaps)).toBe(true);
    // The template REQ has acceptance criteria but no linked test -> a gap.
    expect(gaps.gaps.some((g) => g.has_acceptance_criteria && g.test_evidence !== "covered")).toBe(true);
    expect(gaps.top_risk_gaps?.length).toBeGreaterThan(0);
    expect(gaps.top_risk_gaps?.[0]).toMatchObject({
      external_id: expect.stringMatching(/^sym:/),
      risk_score: expect.any(Number),
      incoming_refs: expect.any(Number),
      git_churn: expect.any(Number),
      entry_point: expect.any(Boolean)
    });
    expect(gaps.risk_model?.note).toContain("does not change");
  });

  it("opExplain resolves a generated test's grounding", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const gen = await opGenerate(root, { limit: 1 }, deps);
    expect(gen.generated_tests.length).toBeGreaterThan(0);
    const explain = opExplain(root, gen.generated_tests[0].id);
    expect(explain.title).toBe(gen.generated_tests[0].title);
    expect(explain.grounded_by.length).toBeGreaterThan(0);
  });

  it("opGenerate refreshes behavior-coverage.html so generated tests appear from the real path", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    // Target a concrete CodeSymbol (Codex's repro shape) so the generated test
    // carries target_symbol_external_id and must surface on its risk card.
    const gen = await opGenerate(root, { limit: 1, target_ids: ["sym:src/payments/card.ts#saveCard"] }, deps);
    expect(gen.generated_tests.length).toBeGreaterThan(0);

    // The blocker bar: the report must reflect the persisted generated tests
    // WITHOUT re-running analyze (which would rebuild the graph and drop them).
    const htmlPath = join(root, ".orangepro", "behavior-coverage.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain(`"generatedTotal":${gen.generated_tests.length}`);
    // Title AND body of the targeted test appear in the embedded report data.
    expect(html).toContain(gen.generated_tests[0].title.slice(0, 20));
    const bodyFragment = gen.generated_tests[0].body.split("\n").find((l) => l.trim().length > 8) ?? "";
    expect(bodyFragment.length).toBeGreaterThan(8);
    expect(html).toContain(JSON.stringify(bodyFragment).slice(1, -1).slice(0, 30));
  });

  it("opExplain throws for an unknown test id", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    expect(() => opExplain(root, "does-not-exist")).toThrow();
  });

  it("opGenerate surfaces VALIDATED grounding evidence per test + a run-level summary", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const gen = await opGenerate(root, { limit: 1 }, deps);
    expect(gen.generated_tests.length).toBeGreaterThan(0);

    // Every test gets a matching validated-evidence record.
    expect(gen.evidence).toHaveLength(gen.generated_tests.length);
    expect(gen.evidence_summary.tests).toBe(gen.generated_tests.length);

    const ev = gen.evidence[0];
    expect(ev.generated_test_id).toBe(gen.generated_tests[0].id);
    // The template Requirement is hard evidence -> this is real proof.
    expect(ev.validated_count).toBeGreaterThan(0);
    expect(ev.has_proof).toBe(true);
    // Every cited entity in this fixture resolves to a real graph node.
    expect(ev.invalid_count).toBe(0);
    expect(ev.evidence.every((c) => c.validated)).toBe(true);
    expect(ev.evidence.some((c) => c.evidence_strength === "hard" || c.evidence_strength === "reviewed")).toBe(true);

    // Run-level roll-up agrees: proof coverage, no broken/unverifiable citations,
    // and therefore NO "provenance unverified" warning.
    expect(gen.evidence_summary.tests_with_proof).toBeGreaterThan(0);
    expect(gen.evidence_summary.invalid_citations).toBe(0);
    expect(gen.evidence_summary.tests_without_validated_evidence).toBe(0);
    expect(gen.warnings.some((w) => w.includes("provenance unverified"))).toBe(false);
  });
});

describe("raw_prompt baseline path", () => {
  it("produces a test with no grounding source refs and no weak disclosure", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const raw = await opGenerate(root, { limit: 1, input_mode: "raw_prompt" }, deps);
    expect(raw.generated_tests.length).toBeGreaterThan(0);
    const t = raw.generated_tests[0];
    expect(t.grounding.source_refs).toEqual([]);
    expect(t.grounding.weak_relationships_used).toEqual([]);
    expect(t.weak_evidence_used).toBe(false);
  });
});

describe("opChanged with git", () => {
  it("reports the changed source file and affected behaviors", () => {
    const root = temp();
    execFileSync("git", ["init", "-q"], { cwd: root });
    scaffold(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t.co", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    writeFileSync(join(root, "src/payments/card.ts"), "export function saveCard(n: string) { return n + '!'; }\n");
    const changed = opChanged(root, "HEAD");
    expect(changed.changed_files).toContain("src/payments/card.ts");
    // Tool artifacts must be filtered out.
    expect(changed.changed_files.some((f) => f.startsWith(".orangepro/"))).toBe(false);
    expect(changed.recommended_actions.length).toBeGreaterThan(0);
  });
});

describe("incremental update keeps the graph edge-consistent", () => {
  it("leaves no dangling edges after a source file is removed", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    unlinkSync(join(root, "tests/payments/card.test.ts"));
    opUpdate(root, {}, deps);
    const graphPath = join(root, ".orangepro", "graph.json");
    expect(existsSync(graphPath)).toBe(true);
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const ids = new Set(graph.nodes.map((n: { external_id: string }) => n.external_id));
    for (const e of graph.edges) {
      expect(ids.has(e.from_external_id) && ids.has(e.to_external_id)).toBe(true);
    }
    for (const e of graph.candidate_edges) {
      expect(ids.has(e.from_external_id) && ids.has(e.to_external_id)).toBe(true);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts common secret shapes and detects them", () => {
    const openai = "sk-" + "A".repeat(40);
    expect(redactSecrets(`key=${openai}`)).not.toContain(openai);
    expect(containsSecret(openai)).toBe(true);
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(redactSecrets(pem)).toContain("<redacted:private-key>");
    expect(containsSecret("nothing sensitive here")).toBe(false);
  });
});
