import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import { opAnalyze, opInit } from "../../src/local/operations.js";
import { buildArtifactIdentity, comparisonCompatibility, repositorySnapshot } from "../../src/local/provenance.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function graph(files: LocalGraph["manifest"]["files"]): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "identity", root: "", root_hash: "sha256:legacy", source_upload_policy: "metadata_only" },
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
    sources: [], nodes: [], edges: [], candidate_edges: [], generation_runs: [], generated_tests: [],
    manifest: { generated_at: "2026-09-13T00:00:00Z", git: { commit: "abc", dirty: false }, files },
    analysis: { test_files: 0, inferred_flows: 0, flows_truncated: 0, max_inferred_flows: 100, symbol_cap_hit: false, max_files: 100, max_symbols: 100 }
  };
}

const inputs = {
  configHash: "config-a",
  history: { state: "full" as const, churnWindow: "180 days", churnAvailable: true, commitDate: "2026-09-12T00:00:00Z" }
};

describe("artifact identity", () => {
  it("hashes included paths and bytes deterministically, independent of manifest order", () => {
    const a = graph({ "src/a.ts": { hash: "sha256:a", size: 1, kind: "code" }, "src/b.ts": { hash: "sha256:b", size: 1, kind: "code" } });
    const reordered = graph({ "src/b.ts": { hash: "sha256:b", size: 1, kind: "code" }, "src/a.ts": { hash: "sha256:a", size: 1, kind: "code" } });
    const renamed = graph({ "src/c.ts": { hash: "sha256:a", size: 1, kind: "code" }, "src/b.ts": { hash: "sha256:b", size: 1, kind: "code" } });
    expect(repositorySnapshot(a)).toBe(repositorySnapshot(reordered));
    expect(repositorySnapshot(renamed)).not.toBe(repositorySnapshot(a));
  });

  it("changes only the expected downstream identities for analyzer, config and oracle inputs", () => {
    const g = graph({ "src/a.ts": { hash: "sha256:a", size: 1, kind: "code" } });
    const base = buildArtifactIdentity(g, inputs);
    const analyzer = buildArtifactIdentity(g, { ...inputs, analyzerVersion: "orangepro.analyzer.v2" });
    const config = buildArtifactIdentity(g, { ...inputs, configHash: "config-b" });
    const oracle = buildArtifactIdentity(g, { ...inputs, oracleVersion: "oracle-v2" });
    expect(analyzer.repository_snapshot).toBe(base.repository_snapshot);
    expect(analyzer.analysis_fingerprint).not.toBe(base.analysis_fingerprint);
    expect(config.analysis_fingerprint).toBe(base.analysis_fingerprint);
    expect(config.ranking_fingerprint).not.toBe(base.ranking_fingerprint);
    expect(oracle.ranking_fingerprint).toBe(base.ranking_fingerprint);
    expect(oracle.run_fingerprint).not.toBe(base.run_fingerprint);
    expect(comparisonCompatibility(base, analyzer)).toBe("analysis_changed");
    expect(comparisonCompatibility(base, config)).toBe("ranking_changed");
    expect(comparisonCompatibility(base, oracle)).toBe("experiment_changed");
    expect(comparisonCompatibility(null, base)).toBe("provenance_incomplete");
  });

  it("keeps Git commit and dirty state as metadata, not material identity", () => {
    const clean = graph({ "src/a.ts": { hash: "sha256:a", size: 1, kind: "code" } });
    const dirty = graph(clean.manifest.files);
    dirty.manifest.git = { commit: "different", dirty: true };
    const a = buildArtifactIdentity(clean, inputs);
    const b = buildArtifactIdentity(dirty, inputs);
    expect(b.run_fingerprint).toBe(a.run_fingerprint);
    expect(b.git_commit).toBe("different");
    expect(b.git_dirty).toBe(true);
  });

  it("changes repository_snapshot for a scanned untracked file even when HEAD is unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-identity-"));
    dirs.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "a.ts"), "export function a() { return 1; }\n");
    execFileSync("git", ["add", "a.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    opInit(root);
    opAnalyze(root, { source: root });
    const first = loadGraph(workspacePaths(root).graphPath).artifact_identity!;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "untracked.ts"), "export function b() { return 2; }\n");
    opAnalyze(root, { source: root });
    const second = loadGraph(workspacePaths(root).graphPath).artifact_identity!;
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).toBe(head);
    expect(second.repository_snapshot).not.toBe(first.repository_snapshot);
  });
});
