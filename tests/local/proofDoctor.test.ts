import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockerCategoryFor,
  buildProofDoctor,
  distillProofAttempts,
  loadProofAttempts,
  NON_KILLING_NOTE,
  PROOF_ATTEMPTS_SCHEMA_VERSION,
  PROOF_DOCTOR_SCHEMA_VERSION,
  proofAttemptsPath,
  writeProofAttempts,
  type ProofAttemptsFile
} from "../../src/local/proofDoctor.js";
import { opAnalyze, opInit, opProofDoctor, opBehaviorCoverageHtml, opStart } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import type { LocalGraph } from "../../src/local/graph/ontology.js";
import type { RtmResult } from "../../src/local/rtm.js";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "oplocal-proofdoc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Minimal graph view for the pure builder: manifest anchors + workspace root. */
function fakeGraph(overrides: { commit?: string | null; generatedAt?: string; root?: string } = {}): LocalGraph {
  return {
    manifest: {
      generated_at: overrides.generatedAt ?? "2026-07-06T00:00:00Z",
      git: overrides.commit === null ? null : { commit: overrides.commit ?? "abc123", dirty: false },
      files: {}
    },
    workspace: { name: "t", root: overrides.root ?? "/nonexistent-root", root_hash: "h", source_upload_policy: "metadata_only" }
  } as unknown as LocalGraph;
}

function fakeRtm(overrides: Partial<RtmResult["summary"]> = {}, rows: Array<Partial<RtmResult["rows"][number]>> = []): RtmResult {
  return {
    summary: { total: 10, proven: 0, ...overrides },
    rows: rows.map((r) => ({ evidence_tier: "none", code_symbol: "sym:src/a.ts#a", language: "typescript", ...r }))
  } as unknown as RtmResult;
}

function attemptsFile(graph: LocalGraph, attempts: ProofAttemptsFile["attempts"]): ProofAttemptsFile {
  return {
    schema_version: PROOF_ATTEMPTS_SCHEMA_VERSION,
    generated_at: "2026-07-06T00:00:01Z",
    graph_generated_at: (graph as { manifest: { generated_at: string } }).manifest.generated_at,
    git_commit: "abc123",
    git_dirty: false,
    attempted: attempts.length,
    proven: 0,
    attempts,
    skipped: []
  };
}

describe("distillProofAttempts — sidecar is redacted metadata only", () => {
  it("re-redacts reasons at write time and derives per-target language", () => {
    const graph = fakeGraph();
    const file = distillProofAttempts(
      {
        attempted: 1,
        proven: 0,
        attempts: [
          {
            target_symbol: "sym:src/pay.go#Charge",
            test_path: "tests/pay_test.go",
            classification: "needs_setup",
            reason: "setup failed: api_key=supersecretvalue123 leaked into output",
            category: undefined
          }
        ],
        skipped: [{ title: "t", reason: "password=alsosecret9 in skip reason" }]
      },
      { generatedAt: "2026-07-06T01:00:00Z", graph }
    );
    expect(file.schema_version).toBe(PROOF_ATTEMPTS_SCHEMA_VERSION);
    expect(file.graph_generated_at).toBe("2026-07-06T00:00:00Z");
    expect(file.git_commit).toBe("abc123");
    expect(file.attempts[0].language).toBe("go");
    expect(JSON.stringify(file)).not.toContain("supersecretvalue123");
    expect(JSON.stringify(file)).not.toContain("alsosecret9");
  });
});

describe("proof-attempts sidecar round-trip", () => {
  it("writes and loads; schema drift fails closed to null", () => {
    const root = temp();
    mkdirSync(join(root, ".orangepro"), { recursive: true });
    const graph = fakeGraph();
    const file = attemptsFile(graph, []);
    writeProofAttempts(root, file);
    expect(loadProofAttempts(root)).toEqual(file);

    writeFileSync(proofAttemptsPath(root), JSON.stringify({ ...file, schema_version: "other.v9" }), "utf8");
    expect(loadProofAttempts(root)).toBeNull();
  });

  it("fails closed on malformed or misshapen sidecar content (doctor must never crash)", () => {
    const root = temp();
    mkdirSync(join(root, ".orangepro"), { recursive: true });

    writeFileSync(proofAttemptsPath(root), "{ this is not json", "utf8");
    expect(loadProofAttempts(root)).toBeNull();

    writeFileSync(proofAttemptsPath(root), "null", "utf8");
    expect(loadProofAttempts(root)).toBeNull();

    writeFileSync(
      proofAttemptsPath(root),
      JSON.stringify({ schema_version: PROOF_ATTEMPTS_SCHEMA_VERSION, attempts: "not-an-array", skipped: [] }),
      "utf8"
    );
    expect(loadProofAttempts(root)).toBeNull();
  });
});

describe("blockerCategoryFor — conservative derivation", () => {
  it("maps known reason shapes and passes through R-1 categories; unknown stays setup_failed", () => {
    expect(blockerCategoryFor({ reason: "Proof could not run: No go.mod found for Go target x under y." })).toBe("module_root_missing");
    expect(blockerCategoryFor({ reason: "runner binary not found" })).toBe("runner_missing");
    expect(blockerCategoryFor({ reason: "test title is ambiguous across the baseline" })).toBe("assertion_binding");
    expect(blockerCategoryFor({ category: "tsconfig_missing", reason: "whatever" })).toBe("tsconfig_missing");
    expect(blockerCategoryFor({ reason: "something entirely novel" })).toBe("setup_failed");
    expect(blockerCategoryFor({})).toBe("setup_failed");
  });
});

describe("buildProofDoctor", () => {
  it("dedups repeated blockers into one root cause with capped example targets", () => {
    const graph = fakeGraph();
    const attempts = attemptsFile(
      graph,
      Array.from({ length: 25 }, (_, i) => ({
        target_symbol: `sym:src/f${i}.ts#fn${i}`,
        test_path: `t${i}.test.ts`,
        classification: "needs_setup" as const,
        category: "tsconfig_missing",
        language: "typescript"
      }))
    );
    const res = buildProofDoctor(graph, fakeRtm(), attempts);
    expect(res.schema_version).toBe(PROOF_DOCTOR_SCHEMA_VERSION);
    expect(res.status).toBe("blocked");
    expect(res.blockers).toHaveLength(1);
    expect(res.blockers[0].count).toBe(25);
    expect(res.blockers[0].targets).toHaveLength(5);
    expect(res.blockers[0].category).toBe("tsconfig_missing");
    expect(res.blockers[0].next_step.length).toBeGreaterThan(0);
    expect(res.headline).toContain("one root cause blocked 25 targets");
  });

  it("reports survivors as proven negatives, never as user failures, never as Proven", () => {
    const graph = fakeGraph();
    const attempts = attemptsFile(graph, [
      {
        target_symbol: "sym:src/mode.ts#mode",
        test_path: "tests/mode.test.ts",
        classification: "non_killing",
        reason: "Mutant survived; the test does not assert on the target's real behavior.",
        language: "typescript"
      }
    ]);
    const res = buildProofDoctor(graph, fakeRtm(), attempts);
    expect(res.non_killing).toHaveLength(1);
    expect(res.non_killing[0].note).toBe(NON_KILLING_NOTE);
    expect(res.non_killing[0].note).toContain("possibly an equivalent mutation");
    expect(res.non_killing[0].note.toLowerCase()).not.toContain("bad test");
    // A survivor never inflates proven: the count comes verbatim from RTM.
    expect(res.proven).toBe(0);
    expect(res.status).toBe("blocked");
  });

  it("fails closed on stale attempt data: reasons are not presented as current", () => {
    const graph = fakeGraph({ commit: "NEWCOMMIT" });
    const attempts = attemptsFile(fakeGraph(), [
      {
        target_symbol: "sym:src/a.ts#a",
        test_path: "a.test.ts",
        classification: "needs_setup",
        category: "db_or_external",
        language: "typescript"
      }
    ]);
    const res = buildProofDoctor(graph, fakeRtm(), attempts);
    expect(res.stale).toBe(true);
    expect(res.status).toBe("stale");
    expect(res.headline).toContain("re-run");
    // The stale attempt's blocker must NOT be listed as a current attempt result.
    expect(res.blockers.filter((b) => b.source === "attempt")).toHaveLength(0);
    expect(res.attempted).toBeNull();
  });

  it("uses canonical RTM numbers verbatim when proven > 0", () => {
    const res = buildProofDoctor(fakeGraph(), fakeRtm({ proven: 3, total: 12 }), null);
    expect(res.status).toBe("proven");
    expect(res.proven).toBe(3);
    expect(res.denominator).toBe(12);
    expect(res.headline).toContain("3 of 12");
  });

  it("preflight names unsupported languages and missing module roots without running anything", () => {
    const graph = fakeGraph({ root: "/definitely/not/a/real/root" });
    const rtm = fakeRtm({}, [
      { code_symbol: "sym:src/lib.rs#parse", language: "rust" },
      { code_symbol: "sym:pkg/util.go#Sum", language: "go" }
    ]);
    const res = buildProofDoctor(graph, rtm, null, { io: { exists: () => false, nodeVersion: "v20.0.0" } });
    expect(res.status).toBe("blocked");
    const cats = res.blockers.map((b) => b.category).sort();
    expect(cats).toEqual(["module_root_missing", "unsupported_language"]);
    for (const b of res.blockers) expect(b.source).toBe("preflight");
  });

  it("returns no_data when there is nothing to report", () => {
    const res = buildProofDoctor(
      fakeGraph(),
      fakeRtm({}, []),
      null,
      { io: { exists: () => true, nodeVersion: "v20.0.0" } }
    );
    expect(res.status).toBe("no_data");
    expect(res.headline).toContain("opro start");
  });
});

describe("opProofDoctor — read-only over a real workspace", () => {
  const deps = { clock: () => "2026-06-07T00:00:00Z", env: { ORANGEPRO_ALLOW_DETERMINISTIC: "1" } as NodeJS.ProcessEnv };

  function scaffold(root: string): void {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fix", version: "1.0.0", devDependencies: { vitest: "^3.0.0" } })
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "card.ts"), "export function card(n: number) { return n > 0; }\n");
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "card.test.ts"), "import { card } from '../src/card';\nit('works', () => { expect(card(1)).toBe(true); });\n");
  }

  it("mints nothing and writes nothing; blockers come from the fresh sidecar", () => {
    const root = temp();
    scaffold(root);
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);

    const graph = loadGraph(workspacePaths(root).graphPath);
    const manifest = (graph as unknown as { manifest: { generated_at: string; git: { commit?: string } | null } }).manifest;
    const sidecar: ProofAttemptsFile = {
      schema_version: PROOF_ATTEMPTS_SCHEMA_VERSION,
      generated_at: "2026-06-07T00:00:01Z",
      graph_generated_at: manifest.generated_at,
      git_commit: manifest.git?.commit ?? null,
      git_dirty: manifest.git === null ? null : Boolean((manifest.git as { dirty?: boolean }).dirty),
      attempted: 2,
      proven: 0,
      attempts: [
        { target_symbol: "sym:src/card.ts#card", test_path: "a.test.ts", classification: "needs_setup", category: "module_not_found", language: "typescript" },
        { target_symbol: "sym:src/card.ts#card2", test_path: "b.test.ts", classification: "needs_setup", category: "module_not_found", language: "typescript" }
      ],
      skipped: []
    };
    writeProofAttempts(root, sidecar);

    const ledgerFile = join(root, ".orangepro", "ledger.json");
    const ledgerBefore = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : null;

    const res = opProofDoctor(root);
    expect(res.blockers).toHaveLength(1);
    expect(res.blockers[0].category).toBe("module_not_found");
    expect(res.blockers[0].count).toBe(2);
    expect(res.attempted).toBe(2);
    expect(res.stale).toBe(false);

    // Trust invariant: the doctor path never creates or mutates the ledger.
    const ledgerAfter = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : null;
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  it("survives a corrupt sidecar: opProofDoctor falls back instead of crashing", () => {
    const root = temp();
    scaffold(root);
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    writeFileSync(proofAttemptsPath(root), "{{{{ definitely not json", "utf8");
    const res = opProofDoctor(root);
    expect(res.schema_version).toBeTruthy();
    expect(res.stale).toBe(false);
    expect(res.attempted).toBeNull();
  });

  it("opStart persists the sidecar even on a keyless run (attempted may be 0)", async () => {
    const root = temp();
    scaffold(root);
    opInit(root, deps);
    await opStart(root, {}, deps);
    const sidecar = loadProofAttempts(root);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.schema_version).toBe(PROOF_ATTEMPTS_SCHEMA_VERSION);
    expect(typeof sidecar!.attempted).toBe("number");
  });

  it("behavior report regen consumes the fresh sidecar and drops a stale one", () => {
    const root = temp();
    scaffold(root);
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const graph = loadGraph(workspacePaths(root).graphPath);
    const manifest = (graph as unknown as { manifest: { generated_at: string; git: { commit?: string } | null } }).manifest;

    const fresh: ProofAttemptsFile = {
      schema_version: PROOF_ATTEMPTS_SCHEMA_VERSION,
      generated_at: "2026-06-07T00:00:01Z",
      graph_generated_at: manifest.generated_at,
      git_commit: manifest.git?.commit ?? null,
      git_dirty: false,
      attempted: 3,
      proven: 0,
      attempts: [
        { target_symbol: "sym:src/card.ts#card", test_path: "a.test.ts", classification: "needs_setup", category: "db_or_external", language: "typescript" }
      ],
      skipped: []
    };
    writeProofAttempts(root, fresh);
    const outFresh = join(root, "report-fresh.html");
    opBehaviorCoverageHtml(root, outFresh);
    const htmlFresh = readFileSync(outFresh, "utf8");
    expect(htmlFresh).toContain("attempted");

    // Stale sidecar (wrong commit anchor) must be ignored — fail closed.
    writeProofAttempts(root, { ...fresh, git_commit: "someothersha" });
    const outStale = join(root, "report-stale.html");
    opBehaviorCoverageHtml(root, outStale);
    const htmlStale = readFileSync(outStale, "utf8");
    // The stale run's attempted count must not surface as this-run data.
    expect(htmlStale).not.toEqual(htmlFresh);
  });
});
