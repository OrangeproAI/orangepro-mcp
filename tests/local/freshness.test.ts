import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildManifest, readGitInfo } from "../../src/local/freshness/manifest.js";
import { computeFreshness } from "../../src/local/freshness/status.js";
import { changedImpact } from "../../src/local/freshness/changed.js";
import { opAnalyze, opStatus, opUpdate, OperationDeps } from "../../src/local/operations.js";
import {
  LocalGraph,
  LOCAL_GRAPH_SCHEMA_VERSION,
  ManifestFileEntry
} from "../../src/local/graph/ontology.js";
import { makeNode, makeCandidateEdge } from "../../src/local/graph/factories.js";

// Deterministic, offline deps: fixed clock + opt into the offline
// DeterministicProvider (now opt-in only) so no real network/LLM calls happen.
const DETERMINISTIC_DEPS: OperationDeps = {
  clock: () => "2026-06-07T00:00:00Z",
  env: { ORANGEPRO_ALLOW_DETERMINISTIC: "1" }
};

// ── helpers ───────────────────────────────────────────────────────────

function entry(hash: string, kind = "code", size = 100): ManifestFileEntry {
  return { hash, size, kind };
}

/** Build a minimal valid LocalGraph carrying a manifest with the given files. */
function graphWithManifestFiles(files: Record<string, ManifestFileEntry>): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: {
      name: "fixture-local-proof",
      root: "/tmp/fixture",
      root_hash: "sha256:fixture",
      source_upload_policy: "metadata_only"
    },
    created_at: "2026-06-07T00:00:00Z",
    updated_at: "2026-06-07T00:00:00Z",
    sources: [],
    nodes: [],
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: {
      generated_at: "2026-06-07T00:00:00Z",
      git: null,
      files
    }
  };
}

/** A synthetic graph containing a TestCase whose properties.file is set. */
function graphWithTestCase(file: string): LocalGraph {
  const graph = graphWithManifestFiles({});
  const testCase = makeNode({
    kind: "TestCase",
    external_id: `test:${file}`,
    title: "card payment test",
    properties: { test_layer: "unit", file, test_names: ["charges a card"] },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "repo:fixture", source_ref: file, detector: "repo_analyzer" }
  });
  return { ...graph, nodes: [testCase] };
}

// ── FRESHNESS: computeFreshness ───────────────────────────────────────

describe("computeFreshness", () => {
  it("reports 'fresh' when current entries are identical to the manifest", () => {
    const files = { "src/a.ts": entry("h1"), "src/b.ts": entry("h2") };
    const graph = graphWithManifestFiles(files);

    const result = computeFreshness(graph, { "src/a.ts": entry("h1"), "src/b.ts": entry("h2") });

    expect(result.state).toBe("fresh");
    expect(result.changed_files).toEqual([]);
  });

  it("reports 'stale' and lists the changed file when a hash differs", () => {
    const graph = graphWithManifestFiles({ "src/a.ts": entry("h1"), "src/b.ts": entry("h2") });

    const result = computeFreshness(graph, { "src/a.ts": entry("h1"), "src/b.ts": entry("CHANGED") });

    expect(result.state).toBe("stale");
    expect(result.changed_files).toEqual(["src/b.ts"]);
  });

  it("detects an added file as stale", () => {
    const graph = graphWithManifestFiles({ "src/a.ts": entry("h1") });

    const result = computeFreshness(graph, { "src/a.ts": entry("h1"), "src/new.ts": entry("h9") });

    expect(result.state).toBe("stale");
    expect(result.changed_files).toContain("src/new.ts");
  });

  it("detects a removed file as stale", () => {
    const graph = graphWithManifestFiles({ "src/a.ts": entry("h1"), "src/gone.ts": entry("h2") });

    const result = computeFreshness(graph, { "src/a.ts": entry("h1") });

    expect(result.state).toBe("stale");
    expect(result.changed_files).toContain("src/gone.ts");
  });

  it("reports 'missing' when the stored manifest has no files", () => {
    const graph = graphWithManifestFiles({});

    const result = computeFreshness(graph, { "src/a.ts": entry("h1") });

    expect(result.state).toBe("missing");
  });
});

// ── FRESHNESS: buildManifest / readGitInfo ────────────────────────────

describe("buildManifest", () => {
  it("assembles a manifest and copies the file_entries map (no aliasing)", () => {
    const files = { "src/a.ts": entry("h1") };
    const manifest = buildManifest(files, null, "2026-06-07T00:00:00Z");

    expect(manifest.generated_at).toBe("2026-06-07T00:00:00Z");
    expect(manifest.git).toBeNull();
    expect(manifest.files["src/a.ts"]).toEqual(entry("h1"));
    // Mutating the source map must not affect the manifest copy.
    delete (files as Record<string, ManifestFileEntry>)["src/a.ts"];
    expect(manifest.files["src/a.ts"]).toBeDefined();
  });
});

describe("readGitInfo", () => {
  it("returns null when HEAD cannot be resolved (not a git checkout)", () => {
    expect(readGitInfo(() => null)).toBeNull();
  });

  it("reads commit/branch/dirty from an injected git runner", () => {
    const git = (args: string[]): string | null => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123def456\n";
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main\n";
      if (args[0] === "status") return "";
      return null;
    };

    const info = readGitInfo(git);

    expect(info).not.toBeNull();
    expect(info?.commit).toBe("abc123def456");
    expect(info?.branch).toBe("main");
    expect(info?.dirty).toBe(false);
  });
});

// ── FRESHNESS: changedImpact ──────────────────────────────────────────

describe("changedImpact", () => {
  it("lists an affected TestCase and returns recommended actions", () => {
    const graph = graphWithTestCase("tests/pay/card.test.ts");

    const result = changedImpact(graph, ["tests/pay/card.test.ts"], "main");

    expect(result.base_ref).toBe("main");
    expect(result.changed_files).toEqual(["tests/pay/card.test.ts"]);
    // The TestCase node's title (or external id) is surfaced as an affected test.
    expect(result.affected_tests).toContain("card payment test");
    expect(Array.isArray(result.recommended_actions)).toBe(true);
    expect(result.recommended_actions.length).toBeGreaterThan(0);
  });

  it("leaves affected_tests empty when no TestCase references a changed file", () => {
    const graph = graphWithTestCase("tests/pay/card.test.ts");

    const result = changedImpact(graph, ["src/unrelated.ts"], "main");

    expect(result.affected_tests).toEqual([]);
  });

  /** Two same-area behaviors; only one is linked to a test, plus a code sibling. */
  function graphWithLinkedAndAreaBehaviors(): LocalGraph {
    const base = graphWithManifestFiles({});
    const flow = (id: string, area = "pay") =>
      makeNode({
        kind: "UserFlow",
        external_id: id,
        title: id,
        properties: { area },
        evidence_strength: "weak",
        review_status: "inferred",
        confidence: 0.35,
        provenance: { source_scope_id: "repo:fixture", source_ref: area }
      });
    const testCase = makeNode({
      kind: "TestCase",
      external_id: "test:pay/card.test.ts",
      title: "card test",
      properties: { test_layer: "unit", file: "pay/card.test.ts", test_names: ["charges"] },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "repo:fixture", source_ref: "pay/card.test.ts" }
    });
    const edge = makeCandidateEdge({
      from_external_id: "flow:pay-card",
      to_external_id: "test:pay/card.test.ts",
      relationship_type: "MAY_BE_TESTED_BY",
      evidence_strength: "weak",
      reason: "inferred",
      confidence: 0.35,
      provenance: { source_scope_id: "repo:fixture", source_ref: "pay/card.test.ts" }
    });
    return {
      ...base,
      nodes: [flow("flow:pay-card"), flow("flow:pay-other"), flow("flow:auth-login", "auth"), testCase],
      candidate_edges: [edge]
    };
  }

  it("precise-first: a changed test maps ONLY to its linked behavior, not every same-area behavior", () => {
    const graph = graphWithLinkedAndAreaBehaviors();
    const result = changedImpact(graph, ["pay/card.test.ts"], "main");
    expect(result.affected_behaviors).toEqual(["flow:pay-card"]);
    expect(result.affected_behaviors).not.toContain("flow:pay-other");
  });

  it("area fallback (capped) only when nothing precise links: a code file with no test", () => {
    const graph = graphWithLinkedAndAreaBehaviors();
    // pay/thing.ts has no MAY_RELATE_TO / test link → coarse area match surfaces both.
    const result = changedImpact(graph, ["pay/thing.ts"], "main");
    expect(result.affected_behaviors.sort()).toEqual(["flow:pay-card", "flow:pay-other"]);
  });

  it("mixed PR: precise file keeps its precise link; an unlinked file's area still falls back (per-area)", () => {
    const graph = graphWithLinkedAndAreaBehaviors();
    // pay/card.test.ts → precise flow:pay-card (area 'pay' is covered, NOT re-expanded
    // to flow:pay-other); auth/login.ts has no test link → area 'auth' falls back.
    const result = changedImpact(graph, ["pay/card.test.ts", "auth/login.ts"], "main");
    expect(result.affected_behaviors.sort()).toEqual(["flow:auth-login", "flow:pay-card"]);
    expect(result.affected_behaviors).not.toContain("flow:pay-other");
  });
});

// ── INCREMENTAL UPDATE (end-to-end, offline + deterministic) ──────────

describe("incremental update (opAnalyze / opStatus / opUpdate)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oplocal-"));
    // A small code fixture: one source file plus a CSV template that yields a
    // hard Requirement behavior anchor (so generation can ground a test).
    writeFileSync(
      join(dir, "card.ts"),
      "export function charge(amount: number): number {\n  return amount;\n}\n",
      "utf8"
    );
    writeFileSync(
      join(dir, "requirements.csv"),
      "behavior_name,description,acceptance_criteria\n" +
        "Charge a card,Charges the given amount,Amount is captured; receipt is issued\n",
      "utf8"
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes fresh -> stale -> updated -> fresh, non-destructively", async () => {
    // 1. Analyze the fixture.
    const analyze = opAnalyze(dir, {}, DETERMINISTIC_DEPS);
    expect(analyze.entities_count).toBeGreaterThan(0);

    // Generate a deterministic offline test so we can prove it survives updates.
    const { opGenerate } = await import("../../src/local/operations.js");
    const gen = await opGenerate(dir, {}, DETERMINISTIC_DEPS);
    expect(gen.model_provider).toBe("deterministic");
    const generatedTestCountBefore = gen.generated_tests.length;

    // 2. Status right after analyze must be 'fresh'.
    expect(opStatus(dir, DETERMINISTIC_DEPS).freshness).toBe("fresh");

    // Snapshot entity count from the persisted graph.
    const graphPath = analyze.graph_path;
    const entitiesAfterAnalyze: number = (
      JSON.parse(readFileSync(graphPath, "utf8")) as LocalGraph
    ).nodes.length;
    expect(entitiesAfterAnalyze).toBeGreaterThan(0);

    // 3. Modify one source file -> status becomes 'stale'.
    writeFileSync(
      join(dir, "card.ts"),
      "export function charge(amount: number): number {\n  return amount * 2;\n}\n",
      "utf8"
    );
    const stale = opStatus(dir, DETERMINISTIC_DEPS);
    expect(stale.freshness).toBe("stale");
    expect(stale.changed_files).toBeGreaterThanOrEqual(1);

    // 4. opUpdate -> 'updated' with at least one changed file.
    const update = opUpdate(dir, {}, DETERMINISTIC_DEPS);
    expect(update.status).toBe("updated");
    expect(update.changed_files).toBeGreaterThanOrEqual(1);

    // Non-destructive: entity count must not collapse to zero, and the
    // generated test (if any was produced) must be preserved.
    const afterUpdate = JSON.parse(readFileSync(graphPath, "utf8")) as LocalGraph;
    expect(afterUpdate.nodes.length).toBeGreaterThan(0);
    if (generatedTestCountBefore > 0) {
      expect(afterUpdate.generated_tests.length).toBe(generatedTestCountBefore);
    }

    // 5. opUpdate again with no further changes -> 'fresh'.
    const updateAgain = opUpdate(dir, {}, DETERMINISTIC_DEPS);
    expect(updateAgain.status).toBe("fresh");
    expect(opStatus(dir, DETERMINISTIC_DEPS).freshness).toBe("fresh");
  });
});
