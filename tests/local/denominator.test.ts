/**
 * Phase 3 — code-derived behaviors + schema v1 (Gate 3).
 *
 * The coverage denominator is only defensible over behaviors the repo can
 * witness: explicit requirements and provably-callable code exports count;
 * test-inferred flows NEVER do (a test cannot witness its own requirement).
 * These tests are the plan's verify gates for tasks 3.1–3.6.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { extractSymbols, extractSymbolsWithMeta, MAX_SYMBOLS_PER_FILE } from "../../src/local/analyze/symbols.js";
import { enrichFromCsv } from "../../src/local/enrich/csv.js";
import { enrichFromMarkdown } from "../../src/local/enrich/markdown.js";
import {
  behaviorNodes,
  denominatorBehaviors,
  denominatorComposition,
  isDenominatorEligible,
  makeCandidateEdge,
  makeNode
} from "../../src/local/graph/factories.js";
import {
  GraphNode,
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph
} from "../../src/local/graph/ontology.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { opAnalyze, opInit, opUpdate } from "../../src/local/operations.js";

const PROV = { source_scope_id: "scope:test" };

function graphWith(nodes: GraphNode[]): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "demo", root: "/demo", root_hash: "sha256:", source_upload_policy: "metadata_only" },
    created_at: "2026-06-11T00:00:00Z",
    updated_at: "2026-06-11T00:00:00Z",
    sources: [],
    nodes,
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

const flowNode = (id: string): GraphNode =>
  makeNode({
    kind: "UserFlow",
    external_id: id,
    title: id,
    properties: { area: "x" },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.35,
    provenance: PROV
  });

describe("3.2 — denominatorBehaviors is the SOLE denominator source", () => {
  it("a graph of ONLY test-inferred flows has denominator 0 but flows stay inventoried", () => {
    const g = graphWith([flowNode("flow:a"), flowNode("flow:b")]);
    expect(denominatorBehaviors(g)).toHaveLength(0);
    const comp = denominatorComposition(g);
    expect(comp.total).toBe(0);
    expect(comp.excluded_test_inferred).toBe(2);
    // Still inventoried as behavior anchors — generation targeting is unaffected.
    expect(behaviorNodes(g)).toHaveLength(2);
    // Score reports the empty denominator with an actionable message.
    const score = scoreGraph(g);
    expect(score.denominator.total).toBe(0);
    expect(score.denominator.excluded_test_inferred).toBe(2);
    expect(score.missing_evidence.join("\n")).toContain("a test can't prove its own requirement");
  });

  it("eligibility is field-driven only — kind and evidence strength do not decide", () => {
    const hardFlow = makeNode({
      kind: "UserFlow",
      external_id: "flow:hard",
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: PROV
    });
    expect(isDenominatorEligible(hardFlow)).toBe(false); // hard evidence ≠ eligible
    const req = makeNode({
      kind: "Requirement",
      external_id: "REQ-1",
      evidence_strength: "candidate",
      review_status: "inferred",
      confidence: 0.5,
      provenance: PROV
    });
    expect(isDenominatorEligible(req)).toBe(true); // requirements count even as candidates
  });
});

describe("3.3 — the four producers set behavior_source / eligibility at creation", () => {
  it("analyzer: UserFlow is test_inferred/false; exported function is code_export/true", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "card.ts"), "export function saveCard() { return 1; }\nexport const LIMIT = 10;\n");
      writeFileSync(
        join(dir, "src", "card.test.ts"),
        'describe("card", () => { it("saves a card", () => {}); });\n'
      );
      const fragment = analyzeRepo(dir);
      const flow = fragment.nodes.find((n) => n.kind === "UserFlow");
      expect(flow?.behavior_source).toBe("test_inferred");
      expect(flow?.denominator_eligible).toBe(false);
      expect(flow?.denominator_reason).toContain("cannot witness its own requirement");
      const fn = fragment.nodes.find((n) => n.kind === "CodeSymbol" && n.title === "saveCard");
      expect(fn?.behavior_source).toBe("code_export");
      expect(fn?.denominator_eligible).toBe(true);
      const constSym = fragment.nodes.find((n) => n.kind === "CodeSymbol" && n.title === "LIMIT");
      expect(constSym?.denominator_eligible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("csv: Requirement is requirement_template/true", () => {
    const csv = [
      "behavior_name,description,acceptance_criteria,actor_or_role,priority_or_risk,source_ref",
      'Login,"User logs in","Valid creds succeed",Customer,High,JIRA-1'
    ].join("\n");
    const req = enrichFromCsv("t.csv", csv).nodes.find((n) => n.kind === "Requirement");
    expect(req?.behavior_source).toBe("requirement_template");
    expect(req?.denominator_eligible).toBe(true);
    expect(req?.denominator_reason).toBeTruthy();
  });

  it("markdown: Requirement is markdown_requirement/true", () => {
    const md = "# Requirements\n\n## User can reset password\n";
    const req = enrichFromMarkdown("req.md", md).nodes.find((n) => n.kind === "Requirement");
    expect(req?.behavior_source).toBe("markdown_requirement");
    expect(req?.denominator_eligible).toBe(true);
  });
});

describe("3.4 — code_export eligibility rule (callable surface only)", () => {
  it("counts callable entry-point surfaces, not arbitrary functions/classes/consts", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden4-"));
    try {
      mkdirSync(join(dir, "src", "services"), { recursive: true });
      writeFileSync(
        join(dir, "src", "services", "lib.service.ts"),
        [
          "export function saveExport() { return 1; }",
          "export class ClassExport {}",
          "export const VALUE_EXPORT = 42;",
          "export const saveCallable = (x: number) => x + 1;"
        ].join("\n")
      );
      writeFileSync(join(dir, "src", "lib.ts"), "export function fnExport() { return 1; }\n");
      writeFileSync(join(dir, "src", "types.d.ts"), "export function typeOnlyFn(): void;\n");
      const fragment = analyzeRepo(dir);
      const byTitle = (t: string): GraphNode | undefined =>
        fragment.nodes.find((n) => n.kind === "CodeSymbol" && n.title === t);
      expect(byTitle("saveExport")?.denominator_eligible).toBe(true);
      expect(byTitle("fnExport")?.denominator_eligible).toBe(false);
      expect(byTitle("ClassExport")?.denominator_eligible).toBe(false);
      // A plain value const is excluded in v1…
      expect(byTitle("VALUE_EXPORT")?.denominator_eligible).toBe(false);
      expect(byTitle("VALUE_EXPORT")?.denominator_reason).toContain("not provably callable");
      // …but an AST-proven callable const counts, with the note recorded.
      expect(byTitle("saveCallable")?.denominator_eligible).toBe(true);
      expect(byTitle("saveCallable")?.denominator_reason).toContain("countable behavior surface");
      expect(byTitle("saveCallable")?.properties.callable_const).toBe(true);
      // .d.ts declares types, not behavior.
      expect(byTitle("typeOnlyFn")?.denominator_eligible).toBe(false);
      expect(byTitle("typeOnlyFn")?.denominator_reason).toContain(".d.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extractSymbols proves callability via the AST and splits python defs from methods", () => {
    const ts = extractSymbols(
      "export const cb = () => 1;\nexport const v = 2;\nexport function f() {}\n"
    );
    expect(ts.find((s) => s.name === "cb")?.callable).toBe(true);
    expect(ts.find((s) => s.name === "v")?.callable).toBe(false);
    expect(ts.find((s) => s.name === "f")?.callable).toBeUndefined(); // const-only flag
    const py = extractSymbols("def top():\n    pass\n\nclass C:\n    def method(self):\n        pass\n", "python");
    expect(py.find((s) => s.name === "top")?.symbol_kind).toBe("function");
    expect(py.find((s) => s.name === "method")?.symbol_kind).toBe("method");
    expect(py.find((s) => s.name === "C")?.symbol_kind).toBe("class"); // class counts once
  });

  it("(Codex re-review P1) a TS file's Go/Java patterns in comments/strings mint NO symbols", () => {
    const src = [
      "// func GhostCheckout(",
      "/* public class GhostJavaClass {} */",
      'const doc = "func FakePayment(";',
      "const tmpl = `public class FakeJava {}`;",
      "export function realCheckout() {}"
    ].join("\n");
    const names = extractSymbols(src, "typescript").map((s) => s.name);
    expect(names).not.toContain("GhostCheckout"); // Go regex never runs on a .ts file
    expect(names).not.toContain("GhostJavaClass"); // Java regex never runs on a .ts file
    expect(names).not.toContain("FakePayment");
    expect(names).not.toContain("FakeJava");
    expect(names).toContain("realCheckout"); // only the real AST export
  });

  it("(Codex re-review P1b) Python docstrings/comments/strings mint NO phantom symbols", () => {
    const py = [
      '"""Usage::',
      "",
      "    class GhostClient:",
      "        def ghost_connect(self): ...",
      "",
      "    def ghost_factory(): ...",
      '"""',
      "# def commented_out(): ...",
      'DOC = "class GhostString:"',
      "def get_user(uid): return uid",
      "class UserStore:",
      "    def save(self, u): ..."
    ].join("\n");
    const names = extractSymbols(py, "python").map((s) => s.name);
    // Real symbols only:
    expect(names.sort()).toEqual(["UserStore", "get_user", "save"].sort());
    for (const ghost of ["GhostClient", "ghost_connect", "ghost_factory", "commented_out", "GhostString"]) {
      expect(names).not.toContain(ghost);
    }
  });

  it("(Codex re-review P1b) Go/Java comments + strings mint NO phantom symbols", () => {
    const go = [
      "package payments",
      "// func GhostCheckout() {}",
      "/* func GhostBlock() {} */",
      'const doc = "func FakePayment("',
      "const raw = `func FakeRaw() {}`",
      "func RealCheckout() {}"
    ].join("\n");
    const goNames = extractSymbols(go, "go").map((s) => s.name);
    expect(goNames).toEqual(["RealCheckout"]);

    const java = [
      "// public class GhostComment {}",
      'String s = "public class GhostString {}";',
      "public class RealOrder {}"
    ].join("\n");
    const javaNames = extractSymbols(java, "java").map((s) => s.name);
    expect(javaNames).toEqual(["RealOrder"]);
  });

  it("(Codex re-review P1c) Java text blocks mint NO phantom class; annotated classes ARE kept", () => {
    // Java 15+ text block containing fake class declarations.
    const tb = [
      "public class RealOrder {",
      '  String docs = """',
      "public class GhostOrder {}",
      "public class GhostTwo {}",
      '""";',
      "}"
    ].join("\n");
    const tbNames = extractSymbols(tb, "java").map((s) => s.name);
    expect(tbNames).toContain("RealOrder");
    expect(tbNames).not.toContain("GhostOrder");
    expect(tbNames).not.toContain("GhostTwo");
    // Annotation on the SAME line must not drop the class (Spring/Lombok idiom).
    expect(extractSymbols("@Entity public class Owner {}", "java").map((s) => s.name)).toContain("Owner");
    expect(extractSymbols('@Table(name="users") public class UserRow {}', "java").map((s) => s.name)).toContain("UserRow");
    expect(extractSymbols("@Getter @Setter public class Pet {}", "java").map((s) => s.name)).toContain("Pet");
    // Annotation on its own line still works.
    expect(extractSymbols("@Entity\npublic class Account {}", "java").map((s) => s.name)).toContain("Account");
  });

  it("(panel P2) a Python escaped triple-quote inside a docstring mints NO phantom symbol", () => {
    // `\"""` does NOT close the string in real Python, so the def below it is
    // still string content, not a real symbol.
    const src = 'x = """line1 \\"""\ndef EscapedTripleGhost():\n    pass\n"""\ndef real_fn(): return 1\n';
    const names = extractSymbols(src, "python").map((s) => s.name);
    expect(names).not.toContain("EscapedTripleGhost");
    expect(names).toContain("real_fn");
  });

  it("(Codex re-review P1b) analyzeRepo: a Python docstring example inflates NO denominator node", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden-pydoc-"));
    try {
      mkdirSync(join(dir, "app"), { recursive: true });
      writeFileSync(
        join(dir, "app", "api.py"),
        '"""api.\n\n    class Example:\n        def demo(self): ...\n"""\n\ndef charge_card(n): return n\n'
      );
      const fragment = analyzeRepo(dir);
      const codeSyms = fragment.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.title);
      expect(codeSyms).toContain("charge_card");
      expect(codeSyms).not.toContain("Example");
      expect(codeSyms).not.toContain("demo");
      // The denominator counts only the real export, not the docstring example.
      expect(denominatorComposition({ nodes: fragment.nodes }).code_export).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(Codex re-review P1) language isolation: Go/Java extractors run ONLY for their language", () => {
    // The same `func Save(` text is a real Go symbol in a .go file…
    expect(extractSymbols("func Save() {}", "go").map((s) => s.name)).toContain("Save");
    // …but invisible in a .ts file (it is not TS export syntax).
    expect(extractSymbols("func Save() {}", "typescript").map((s) => s.name)).not.toContain("Save");
    // Java `public class` only in a .java file.
    expect(extractSymbols("public class Order {}", "java").map((s) => s.name)).toContain("Order");
    expect(extractSymbols("public class Order {}", "python").map((s) => s.name)).not.toContain("Order");
    // An unsupported language extracts nothing (no incidental regex match).
    expect(extractSymbols("def whatever():\n  pass", "ruby")).toHaveLength(0);
  });

  it("(Codex P1) commented-out and string-literal exports are NEVER counted (AST, not regex)", () => {
    const src = [
      "// export function legacyCheckoutFlow() {}",
      '/* export class BlockCommentService {} */',
      'const docs = "export class FakePaymentService {}";',
      "export const VALUE = 1;",
      "export function realFn() {}"
    ].join("\n");
    const names = extractSymbols(src).map((s) => s.name);
    expect(names).not.toContain("legacyCheckoutFlow"); // line comment
    expect(names).not.toContain("BlockCommentService"); // block comment
    expect(names).not.toContain("FakePaymentService"); // string literal
    expect(names).not.toContain("docs"); // non-exported const
    expect(names).toEqual(expect.arrayContaining(["VALUE", "realFn"])); // only real exports
  });

  it("export followed by tab/newline is still extracted (gate matches `export\\s`, not `export `)", () => {
    expect(extractSymbols("export\tfunction tabFn() {}").map((s) => s.name)).toContain("tabFn");
    expect(extractSymbols("export\nfunction nlFn() {}").map((s) => s.name)).toContain("nlFn");
    expect(extractSymbols("export\tclass TabClass {}").map((s) => s.name)).toContain("TabClass");
  });

  it("(Codex P1) analyzeRepo creates NO denominator node for a commented/string export", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden-cmt-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "snippets.ts"),
        '// export function ghostFn() {}\nconst doc = "export class GhostClass {}";\nexport function realCheckout() {}\n'
      );
      const fragment = analyzeRepo(dir);
      const codeSyms = fragment.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.title);
      expect(codeSyms).not.toContain("ghostFn");
      expect(codeSyms).not.toContain("GhostClass");
      expect(codeSyms).toContain("realCheckout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(Codex re-review P1) analyzeRepo: Go/Java patterns in a .ts comment/string create NO node", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden-xlang-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "src", "snippets.ts"),
        "// func GhostCheckout() {}\nconst doc = \"public class GhostJava {}\";\nexport function realCheckout() {}\n"
      );
      const fragment = analyzeRepo(dir);
      const codeSyms = fragment.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.title);
      expect(codeSyms).not.toContain("GhostCheckout"); // Go regex must not run on a .ts file
      expect(codeSyms).not.toContain("GhostJava"); // Java regex must not run on a .ts file
      expect(codeSyms).toContain("realCheckout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Codex P1 — incremental update honors ORANGEPRO_MAX_SYMBOLS", () => {
  it("opUpdate uses the same symbol cap as analyze — live exports are not dropped/added on update", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden-upd-"));
    const deps = { clock: () => "2026-06-12T00:00:00Z", env: { ORANGEPRO_MAX_SYMBOLS: "2" } };
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export function saveA() {}\n");
      writeFileSync(join(dir, "src", "b.ts"), "export function saveB() {}\n");
      writeFileSync(join(dir, "src", "c.ts"), "export function saveC() {}\n");
      opInit(dir);
      opAnalyze(dir, {}, deps);
      const afterAnalyze = loadGraph(workspacePaths(dir).graphPath).analysis;
      expect(afterAnalyze?.denominator?.code_export).toBe(2); // capped at 2
      expect(afterAnalyze?.symbol_cap_hit).toBe(true);

      // Edit one file, then update WITH THE SAME env cap.
      writeFileSync(join(dir, "src", "a.ts"), "export function saveA() { return 1; }\n");
      const res = opUpdate(dir, {}, deps);
      expect(res.status).toBe("updated");
      const afterUpdate = loadGraph(workspacePaths(dir).graphPath).analysis;
      // Pre-fix: update ignored the env and re-scanned at the default 1500 cap,
      // so code_export jumped to 3 and cap_hit went false. The cap must hold.
      expect(afterUpdate?.denominator?.code_export).toBe(2);
      expect(afterUpdate?.symbol_cap_hit).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("3.5 — DenominatorComposition is returned and persisted", () => {
  it("composition math: eligible sources add up; test_inferred contributes 0", () => {
    const nodes = [
      makeNode({ kind: "Requirement", external_id: "REQ-1", evidence_strength: "hard", review_status: "local_reviewed", confidence: 1, provenance: PROV }),
      makeNode({ kind: "Requirement", external_id: "REQ-md", evidence_strength: "candidate", review_status: "inferred", confidence: 0.5, provenance: PROV, behavior_source: "markdown_requirement", denominator_eligible: true, denominator_reason: "md" }),
      makeNode({ kind: "CodeSymbol", external_id: "sym:a#f", evidence_strength: "hard", review_status: "auto_detected", confidence: 1, provenance: PROV, behavior_source: "code_export", denominator_eligible: true, denominator_reason: "fn" }),
      makeNode({ kind: "CodeSymbol", external_id: "sym:a#c", evidence_strength: "hard", review_status: "auto_detected", confidence: 1, provenance: PROV, behavior_source: "code_export", denominator_eligible: false, denominator_reason: "const" }),
      flowNode("flow:x")
    ];
    const comp = denominatorComposition(graphWith(nodes));
    expect(comp).toEqual({
      total: 3,
      code_export: 1,
      requirement_template: 1,
      markdown_requirement: 1,
      excluded_test_inferred: 1,
      excluded_boilerplate: 0,
      excluded_infra: 0,
      excluded_generated: 0,
      code_symbols_total: 2, // sym:a#f (eligible) + sym:a#c (excluded const) — the true found total
      unattributed: 0
    });
  });

  it("an eligible node with a contradictory source is SURFACED as unattributed, never laundered", () => {
    // A producer bug could construct an eligible test_inferred node — the
    // audit artifact must flag it, not count it as a reviewed template row.
    const bad = makeNode({
      kind: "UserFlow",
      external_id: "flow:bug",
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.35,
      provenance: PROV,
      denominator_eligible: true
    });
    const comp = denominatorComposition(graphWith([bad]));
    expect(comp.requirement_template).toBe(0);
    expect(comp.unattributed).toBe(1);
    expect(comp.total).toBe(1);
  });

  it("stale nodes (deleted files kept by incremental update) NEVER count", () => {
    const ghost = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/deleted.ts#gone",
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: PROV,
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "fn"
    });
    (ghost as { stale?: boolean }).stale = true;
    const g = graphWith([ghost]);
    expect(denominatorBehaviors(g)).toHaveLength(0);
    expect(denominatorComposition(g).total).toBe(0);
    expect(denominatorComposition(g).code_export).toBe(0);
  });

  it("opAnalyze persists the composition (incl. enriched requirements) into graph.analysis", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden5-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "card.ts"), "export function saveCard() { return 1; }\n");
      writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n## User can save a card\n");
      opInit(dir);
      opAnalyze(dir, { paths: ["requirements.md"] });
      const graph = loadGraph(workspacePaths(dir).graphPath);
      const denom = graph.analysis?.denominator;
      expect(denom).toBeTruthy();
      expect(denom!.code_export).toBeGreaterThan(0);
      expect(denom!.markdown_requirement).toBeGreaterThan(0);
      expect(denom!.total).toBe(denom!.code_export + denom!.requirement_template + denom!.markdown_requirement);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("panel remediations — eligibility edges, truncation disclosure, score honesty", () => {
  const codeExport = (id: string, file: string): GraphNode =>
    makeNode({
      kind: "CodeSymbol",
      external_id: id,
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: PROV,
      properties: { file, symbol_kind: "function" },
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "fn"
    });

  it("generic arrow consts in plain .ts are proven callable (TS-grammar parse, not TSX-only)", () => {
    const syms = extractSymbols("export const identity = <T>(value: T): T => value;\n");
    expect(syms.find((s) => s.name === "identity")?.callable).toBe(true);
  });

  it("paren/as/satisfies wrappers are transparent; declaration lists keep later callable declarators", () => {
    expect(extractSymbols("export const x = (() => 1);").find((s) => s.name === "x")?.callable).toBe(true);
    expect(extractSymbols("export const y = ((n: number) => n) as unknown;").find((s) => s.name === "y")?.callable).toBe(true);
    const list = extractSymbols("export const a = 1, b = () => 2;");
    expect(list.find((s) => s.name === "a")?.callable).toBe(false);
    expect(list.find((s) => s.name === "b")?.callable).toBe(true); // AST saw what the regex missed
  });

  it("python: async defs are extracted; an 'export const' in a comment cannot flip a real def", () => {
    const py = extractSymbols("# export const run = 1\nasync def run():\n    pass\n", "python");
    expect(py.find((s) => s.name === "run")?.symbol_kind).toBe("function");
  });

  it("per-file symbol truncation is DISCLOSED (extraction meta + analyzer warning + analysis field)", () => {
    const big = Array.from({ length: MAX_SYMBOLS_PER_FILE + 1 }, (_, i) => `export function f${i}() { return ${i}; }`).join("\n");
    const meta = extractSymbolsWithMeta(big);
    expect(meta.symbols).toHaveLength(MAX_SYMBOLS_PER_FILE);
    expect(meta.truncated).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "opden7-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "big.ts"), big);
      const fragment = analyzeRepo(dir);
      expect(fragment.analysis.symbol_files_truncated).toBe(1);
      expect(fragment.warnings.join("\n")).toContain("per-file symbol cap");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".d.mts / .d.cts type declarations are excluded like .d.ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden8-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "shim.d.mts"), "export function typeOnly(): void;\n");
      const fragment = analyzeRepo(dir);
      const sym = fragment.nodes.find((n) => n.kind === "CodeSymbol" && n.title === "typeOnly");
      expect(sym?.denominator_eligible).toBe(false);
      expect(sym?.denominator_reason).toContain(".d.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes clear test-support/testdata libraries from the denominator without hiding product near-misses", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden-infra-"));
    try {
      const files: Record<string, string> = {
        "server/channels/api4/apitestlib.go": "package api4\nfunc SetupAPIHarness() {}\n",
        "server/channels/testlib/helper.go": "package testlib\nfunc NewMainHelper() {}\n",
        "tools/mattermost-govet/rawSql/testdata/src/a/a.go": "package a\nfunc VetFixtureOnly() {}\n",
        "tools/mattermost-govet/immut/testdata.go": "package immut\nfunc VetInlineFixtureOnly() {}\n",
        "server/public/pluginapi/experimental/oauther/mock_oauther/mock_oauther.go":
          "package mock_oauther\nfunc NewMockOAuther() {}\n",
        "webapp/platform/shared/src/testing/useMockSharedContext.tsx":
          "export function useMockSharedContext() { return null; }\n",
        "webapp/platform/shared/src/testing/runner.ts": "export function runTestingFeature() { return true; }\n",
        "server/channels/app/contestliberator.go": "package app\nfunc RunContestLib() {}\n"
      };
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      const fragment = analyzeRepo(dir);
      const byTitle = (t: string): GraphNode | undefined =>
        fragment.nodes.find((n) => n.kind === "CodeSymbol" && n.title === t);

      for (const name of [
        "SetupAPIHarness",
        "NewMainHelper",
        "VetFixtureOnly",
        "VetInlineFixtureOnly",
        "NewMockOAuther",
        "useMockSharedContext"
      ]) {
        expect(byTitle(name)?.denominator_eligible).toBe(false);
        expect(byTitle(name)?.denominator_reason).toContain("test-infra");
      }
      expect(byTitle("runTestingFeature")?.denominator_eligible).toBe(true);
      expect(byTitle("RunContestLib")?.denominator_eligible).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("score: the add-a-template nudge fires on code-only repos; code exports cannot peg anchors", () => {
    const score = scoreGraph(graphWith([codeExport("sym:src/a.ts#f", "src/a.ts")]));
    expect(score.missing_evidence.join("\n")).toContain("written requirements");
    expect(score.breakdown.behavior_anchors).toBeLessThanOrEqual(0.5);
  });

  it("two incidental requirements cannot peg behavior_anchors (the cap scales, not vanishes)", () => {
    // Live Mattermost knife-edge: 2 stray markdown headings on a 1,464-export
    // repo flipped anchors from 0.5-capped to 1.00 and killed the nudge.
    const exports100 = Array.from({ length: 100 }, (_, i) => codeExport(`sym:src/f${i}.ts#f`, `src/f${i}.ts`));
    const mdReq = (id: string): GraphNode =>
      makeNode({
        kind: "Requirement",
        external_id: id,
        evidence_strength: "candidate",
        review_status: "inferred",
        confidence: 0.5,
        provenance: PROV,
        behavior_source: "markdown_requirement",
        denominator_eligible: true,
        denominator_reason: "md"
      });
    const score = scoreGraph(graphWith([...exports100, mdReq("REQ-md-1"), mdReq("REQ-md-2")]));
    expect(score.breakdown.behavior_anchors).toBeLessThan(1);
    expect(score.missing_evidence.join("\n")).toContain("Only 2 written requirement(s)");
  });

  it("a cap-truncated denominator is disclosed in missing_evidence", () => {
    const g = graphWith([codeExport("sym:src/a.ts#f", "src/a.ts")]);
    g.analysis = { test_files: 0, inferred_flows: 0, flows_truncated: 0, max_inferred_flows: 1, symbol_cap_hit: true };
    expect(scoreGraph(g).missing_evidence.join("\n")).toContain("coverage looks lower than it really is");
  });

  it("the symbol cap is tunable per run (ORANGEPRO_MAX_SYMBOLS → analyzeRepo opts.maxSymbols)", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden9-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "a.ts"), "export function f1() {}\nexport function f2() {}\nexport function f3() {}\n");
      const fragment = analyzeRepo(dir, { maxSymbols: 2 });
      expect(fragment.nodes.filter((n) => n.kind === "CodeSymbol")).toHaveLength(2);
      expect(fragment.analysis.symbol_cap_hit).toBe(true);
      expect(fragment.warnings.join("\n")).toContain("ORANGEPRO_MAX_SYMBOLS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("score: code exports get WEAK credit when a test resolved-imports their file", () => {
    const sym = codeExport("sym:src/a.ts#f", "src/a.ts");
    const linked = graphWith([sym]);
    linked.candidate_edges.push(
      makeCandidateEdge({
        from_external_id: "tests/a.test.ts",
        to_external_id: "src/a.ts",
        relationship_type: "MAY_RELATE_TO",
        evidence_strength: "candidate",
        reason: "resolved import",
        confidence: 0.75
      })
    );
    const withLink = scoreGraph(linked).breakdown.validation_evidence;
    const withoutLink = scoreGraph(graphWith([codeExport("sym:src/a.ts#f", "src/a.ts")])).breakdown.validation_evidence;
    expect(withLink).toBeGreaterThan(withoutLink);
  });
});

describe("3.6 — v0 graphs force-rebuild; viz and score agree on behaviors", () => {
  it("loading a v0 graph throws the actionable rebuild message", () => {
    const dir = mkdtempSync(join(tmpdir(), "opden6-"));
    try {
      opInit(dir);
      const graphPath = workspacePaths(dir).graphPath;
      const v0 = { ...graphWith([]), schema_version: "orangepro.local_graph.v0" };
      writeFileSync(graphPath, JSON.stringify(v0), "utf8");
      expect(() => loadGraph(graphPath)).toThrow(/run `opro analyze \.` to rebuild — no data loss/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("viz and score derive behaviors from the same canonical definition", () => {
    const req = makeNode({ kind: "Requirement", external_id: "REQ-1", title: "R", properties: { area: "x" }, evidence_strength: "hard", review_status: "local_reviewed", confidence: 1, provenance: PROV });
    const rule = makeNode({ kind: "BusinessRule", external_id: "BR-1", title: "B", properties: { area: "x" }, evidence_strength: "hard", review_status: "local_reviewed", confidence: 1, provenance: PROV });
    const g = graphWith([req, rule, flowNode("flow:x")]);
    const payload = buildVizPayload(g, scoreGraph(g));
    // The viz gap counter walks the SAME canonical behavior inventory score
    // uses (all three behaviors lack AC/coverage, so all three are gaps)…
    expect(payload.meta.gaps).toBe(behaviorNodes(g).length);
    // …while the denominator stays field-driven (the flow is excluded).
    expect(scoreGraph(g).denominator.total).toBe(2);
  });
});
