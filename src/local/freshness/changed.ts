import { GraphNode, LocalGraph } from "../graph/ontology.js";
import { behaviorNodes, nodesByKind } from "../graph/factories.js";
import { ChangedResult, DiffLinkKind } from "../types.js";

const AREA_SKIP = new Set(["src", "app", "lib", "packages", "tests", "test", "e2e", "__tests__", "spec"]);

/** Strength order for diff→behavior provenance: import-graph evidence beats heuristics. */
const KIND_RANK: Record<DiffLinkKind, number> = { area: 0, stem: 1, import: 2, direct: 3 };
const stronger = (a: DiffLinkKind, b: DiffLinkKind): DiffLinkKind => (KIND_RANK[a] >= KIND_RANK[b] ? a : b);

/**
 * Cap on behaviors surfaced by the coarse directory-area fallback. Precise
 * (test ↔ changed-file) links are never capped; only the area fallback is, so a
 * small PR can't match every behavior in a top-level directory (the old bug: a
 * 5-file PR matched ~794 behaviors).
 */
const MAX_AREA_FALLBACK_BEHAVIORS = 50;

/**
 * HUB damping for the precise import-derived links: a changed file linked to
 * more test files than max(floor, fraction-of-all-tests) is shared plumbing
 * (a constants module, a barrel), not behavior-specific signal — expanding it
 * would flood PR targeting (Mattermost: a one-line constants.tsx edit linked
 * 186 test files -> 393 "affected" behaviors). Hubs are excluded from precise
 * expansion and surfaced as an explanatory action instead.
 */
const HUB_FAN_IN_MIN = 20;
const HUB_FAN_IN_FRACTION = 0.02;

/** First meaningful path segment, mirroring the analyzer's topArea convention. */
function topArea(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  for (const part of parts.slice(0, Math.max(0, parts.length - 1))) {
    if (!AREA_SKIP.has(part.toLowerCase())) return part;
  }
  return parts.length > 1 ? parts[0] : "core";
}

function nodeRole(node: GraphNode): string {
  const role = node.properties.role;
  return typeof role === "string" ? role : "";
}

function nodeFile(node: GraphNode): string | undefined {
  const file = node.properties.file;
  return typeof file === "string" ? file : undefined;
}

function nodeArea(node: GraphNode): string | undefined {
  const area = node.properties.area;
  return typeof area === "string" ? area : undefined;
}

/**
 * Map a set of changed files to the behaviors and tests whose grounding may be
 * invalidated, and produce concrete follow-up actions.
 *
 * Metadata only: emits external ids / titles and human-readable guidance, never
 * source content. The graph is read but never mutated.
 */
export function changedImpact(graph: LocalGraph, changedFiles: string[], base_ref: string): ChangedResult {
  const changedSet = new Set(changedFiles);

  // ── affected_tests: TestCase nodes whose properties.file changed,
  //    plus File nodes with role 'test' that themselves changed. ──
  const affectedTestSet = new Set<string>();
  const changedTestCaseIds = new Set<string>();

  for (const tc of nodesByKind(graph, "TestCase")) {
    const file = nodeFile(tc);
    if (file && changedSet.has(file)) {
      affectedTestSet.add(tc.title ?? tc.external_id);
      changedTestCaseIds.add(tc.external_id);
    }
  }
  for (const fileNode of nodesByKind(graph, "File")) {
    if (nodeRole(fileNode) === "test" && changedSet.has(fileNode.external_id)) {
      affectedTestSet.add(fileNode.title ?? fileNode.external_id);
    }
  }

  // ── affected_behaviors: PRECISE (test ↔ changed-file) first; coarse area
  //    match only as a capped fallback when nothing precise links. ──

  // A changed CODE file relates to test files via MAY_RELATE_TO (File↔File):
  // primarily RESOLVED test->source imports from the analyzer's import graph,
  // with the name-stem heuristic as a secondary fallback — so PR-scoped impact
  // is import-precise wherever the resolver linked. Links are collected PER
  // changed file (counting only test-file endpoints, so a changed TEST file's
  // own source imports are ignored), then HUB-damped: a changed file whose test
  // fan-in exceeds the threshold is excluded from precise expansion and reported
  // as an action instead.
  const testFilePaths = new Set<string>();
  for (const tc of nodesByKind(graph, "TestCase")) {
    const file = nodeFile(tc);
    if (file) testFilePaths.add(file);
  }
  // Each MAY_RELATE_TO carries its provenance in evidence_strength: "candidate"
  // is a RESOLVED test→source import (import-graph evidence); anything else
  // (currently "weak") is the basename-stem name heuristic. Import beats stem for
  // the same pair, so a resolved link is never downgraded to a guess.
  const linksPerChangedFile = new Map<string, Map<string, DiffLinkKind>>();
  const addLink = (changedFile: string, other: string, kind: DiffLinkKind): void => {
    if (!testFilePaths.has(other)) return; // only test-file endpoints count
    let m = linksPerChangedFile.get(changedFile);
    if (!m) linksPerChangedFile.set(changedFile, (m = new Map()));
    m.set(other, stronger(m.get(other) ?? kind, kind));
  };
  for (const e of graph.candidate_edges) {
    if (e.relationship_type !== "MAY_RELATE_TO") continue;
    const kind: DiffLinkKind = e.evidence_strength === "candidate" ? "import" : "stem";
    if (changedSet.has(e.to_external_id)) addLink(e.to_external_id, e.from_external_id, kind);
    if (changedSet.has(e.from_external_id)) addLink(e.from_external_id, e.to_external_id, kind);
  }
  const hubThreshold = Math.max(HUB_FAN_IN_MIN, Math.ceil(testFilePaths.size * HUB_FAN_IN_FRACTION));
  // test file -> strongest provenance among the non-hub changed files reaching it.
  const relatedTestFileKind = new Map<string, DiffLinkKind>();
  const hubFiles: Array<{ file: string; fan_in: number }> = [];
  for (const [file, linkedTests] of linksPerChangedFile) {
    if (linkedTests.size > hubThreshold) {
      hubFiles.push({ file, fan_in: linkedTests.size });
      continue;
    }
    for (const [t, kind] of linkedTests) {
      relatedTestFileKind.set(t, stronger(relatedTestFileKind.get(t) ?? kind, kind));
    }
  }
  hubFiles.sort((a, b) => b.fan_in - a.fan_in);

  // TestCase external_id -> how the diff reached it. A test whose own file is in
  // the diff is "direct" (strongest); otherwise it inherits the import/stem kind
  // of the changed file that links it.
  const testCaseKind = new Map<string, DiffLinkKind>();
  for (const id of changedTestCaseIds) testCaseKind.set(id, "direct");
  if (relatedTestFileKind.size) {
    for (const tc of nodesByKind(graph, "TestCase")) {
      const file = nodeFile(tc);
      if (!file) continue;
      const kind = relatedTestFileKind.get(file);
      if (!kind) continue;
      const prev = testCaseKind.get(tc.external_id);
      testCaseKind.set(tc.external_id, prev ? stronger(prev, kind) : kind);
    }
  }
  const linkTestCaseIds = new Set<string>(testCaseKind.keys());

  // Behaviors linked to a changed (or import/stem-related) TestCase via coverage
  // edges, tagged with the strongest provenance among the test cases reaching them.
  const behaviorIds = new Set(behaviorNodes(graph).map((b) => b.external_id));
  const behaviorKind = new Map<string, DiffLinkKind>();
  const link = (a: string, b: string): void => {
    let tc: string | undefined;
    let beh: string | undefined;
    if (linkTestCaseIds.has(a) && behaviorIds.has(b)) (tc = a), (beh = b);
    else if (linkTestCaseIds.has(b) && behaviorIds.has(a)) (tc = b), (beh = a);
    if (!tc || !beh) return;
    const kind = testCaseKind.get(tc) ?? "stem";
    const prev = behaviorKind.get(beh);
    behaviorKind.set(beh, prev ? stronger(prev, kind) : kind);
  };
  for (const e of graph.edges) {
    if (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") link(e.from_external_id, e.to_external_id);
  }
  for (const e of graph.candidate_edges) {
    if (e.relationship_type === "MAY_BE_TESTED_BY" || e.relationship_type === "MAY_COVER") link(e.from_external_id, e.to_external_id);
  }
  const linkedBehaviors = new Set<string>(behaviorKind.keys());

  // Always include the precise set (behaviors whose tests cover the changed files).
  // Then fall back to the coarse directory area ONLY for changed-file areas that no
  // precise behavior already covers — so a mixed PR doesn't lose its un-test-linked
  // files (per-area, not all-or-nothing), while a precisely-linked area is never
  // re-expanded to every behavior in its directory (the #7 over-match).
  const affectedBehaviorSet = new Set<string>(linkedBehaviors);
  const preciseAreas = new Set<string>();
  for (const b of behaviorNodes(graph)) {
    if (!linkedBehaviors.has(b.external_id)) continue;
    const a = nodeArea(b);
    if (a) preciseAreas.add(a);
  }
  // Hub files are excluded from the area fallback too: their impact is
  // repo-wide, so re-expanding the hub's directory area would re-create the
  // very flood the damping removed (a hub-only PR must not area-match).
  const hubFileSet = new Set(hubFiles.map((h) => h.file));
  const fallbackAreas = new Set<string>();
  for (const relPath of changedFiles) {
    if (hubFileSet.has(relPath)) continue;
    const a = topArea(relPath);
    if (!preciseAreas.has(a)) fallbackAreas.add(a);
  }
  let area_truncated = 0;
  if (fallbackAreas.size > 0) {
    const areaMatched = behaviorNodes(graph)
      .filter((b) => {
        const area = nodeArea(b);
        return area !== undefined && fallbackAreas.has(area) && !affectedBehaviorSet.has(b.external_id);
      })
      .map((b) => b.external_id)
      .sort();
    area_truncated = Math.max(0, areaMatched.length - MAX_AREA_FALLBACK_BEHAVIORS);
    for (const id of areaMatched.slice(0, MAX_AREA_FALLBACK_BEHAVIORS)) {
      affectedBehaviorSet.add(id);
      // areaMatched already excludes anything precisely linked, so these are
      // area-only — never overriding a stronger import/stem/direct tag.
      if (!behaviorKind.has(id)) behaviorKind.set(id, "area");
    }
  }
  const area_fallback = fallbackAreas.size > 0;

  // ── recommended_actions, tailored by the kinds of files that changed ──
  const configIds = new Set<string>();
  for (const cfg of nodesByKind(graph, "ConfigFile")) configIds.add(cfg.external_id);
  for (const pkg of nodesByKind(graph, "Package")) configIds.add(pkg.external_id);
  for (const fileNode of nodesByKind(graph, "File")) {
    if (nodeRole(fileNode) === "config") configIds.add(fileNode.external_id);
  }

  const changedConfig = changedFiles.some((f) => configIds.has(f));
  const changedTest = affectedTestSet.size > 0;
  const changedCode = changedFiles.some((f) => {
    const node = graph.nodes.find((n) => n.external_id === f);
    return node !== undefined && node.kind === "File" && nodeRole(node) === "code";
  });

  const recommended_actions: string[] = [];
  const sortedBehaviors = [...affectedBehaviorSet].sort();
  for (const behaviorId of sortedBehaviors.slice(0, 10)) {
    recommended_actions.push(`Regenerate or review tests for ${behaviorId}`);
  }
  if (sortedBehaviors.length > 10) {
    recommended_actions.push(`… and ${sortedBehaviors.length - 10} more affected behavior(s) (see affected_behaviors).`);
  }
  const areaAdded = affectedBehaviorSet.size - linkedBehaviors.size;
  if (area_fallback && areaAdded > 0) {
    recommended_actions.push(
      `Matched ${areaAdded} behavior(s) by directory area for changed files with no test link` +
        (area_truncated ? ` (+${area_truncated} more capped — narrow the diff or add tests for precise targeting).` : ".")
    );
  }
  for (const hub of hubFiles) {
    recommended_actions.push(
      `${hub.file} is linked to ${hub.fan_in} test files (hub import; threshold ${hubThreshold}) — ` +
        `excluded from precise targeting because its impact is repo-wide, not behavior-specific. ` +
        `Target specific behaviors directly if this file's change is the point of the PR.`
    );
  }
  if (changedConfig) {
    recommended_actions.push("Config/package changed: re-check framework assumptions (run update)");
  }
  if (changedTest) {
    recommended_actions.push("Changed tests: re-verify behavior coverage confidence");
  }
  if (changedCode && affectedBehaviorSet.size === 0) {
    recommended_actions.push("Code changed: re-run analyze to refresh symbols and coverage");
  }

  // Per-behavior provenance: import-graph evidence (direct/import) vs heuristic
  // (stem/area). Defaults to "area" only if some path added a behavior without a
  // tag (shouldn't happen — every affected id is tagged at its source).
  const affected = [...affectedBehaviorSet].sort();
  const link_kinds: Record<string, DiffLinkKind> = {};
  const counts: Record<DiffLinkKind, number> = { direct: 0, import: 0, stem: 0, area: 0 };
  for (const id of affected) {
    const k = behaviorKind.get(id) ?? "area";
    link_kinds[id] = k;
    counts[k]++;
  }
  if (affected.length > 0) {
    const parts = (["direct", "import", "stem", "area"] as DiffLinkKind[])
      .filter((k) => counts[k] > 0)
      .map((k) => `${counts[k]} ${k}`);
    recommended_actions.unshift(
      `Targeting provenance: ${parts.join(", ")} (import-graph evidence is precise; stem/area are heuristic).`
    );
  }

  return {
    status: "ok",
    base_ref,
    changed_files: [...changedFiles].sort(),
    affected_behaviors: affected,
    link_kinds,
    affected_tests: [...affectedTestSet].sort(),
    recommended_actions
  };
}
