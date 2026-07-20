import ts from "typescript";
import path from "node:path";
import { isBuiltin } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GeneratedTest, GenerationRun, GraphNode, ImportProvenance, LocalBucket, LocalGraph, TestLayer } from "../graph/ontology.js";
import { extractImports, type ImportBinding } from "../resolve/importGraph.js";
import { deriveSubjectImport } from "./deriveImports.js";
import { resolveImport, loadTsConfigFor } from "../resolve/resolver.js";
import { GENERATED_DIR } from "./runHints.js";
import { behaviorNodes, findNode, nodesByKind, priorityRank } from "../graph/factories.js";
import { structurallyUnconfirmable } from "../graph/confirmable.js";
import { shortHash } from "../util/hash.js";
import { reportProgress } from "../util/progress.js";
import { redactSecrets, redactSecretsPreservingLineCount } from "../util/redact.js";
import { Clock, systemClock } from "../util/time.js";
import { FileReader, GenerateOptions, GenerateResult, MissingEvidenceItem, ModelProvider } from "../types.js";
import { languageOf } from "../analyze/classify.js";
import {
  buildGroundedUserPrompt,
  buildRawUserPrompt,
  buildSystemPrompt,
  GenerationContext,
  PROMPT_VERSION
} from "./prompt.js";
import {
  buildBatchGenerationSystemPromptV5,
  buildBatchGenerationUserPromptV5,
  buildPlanningRepairSystemPromptV5,
  buildPlanningRepairUserPromptV5,
  buildPlanningSystemPromptV5,
  buildPlanningUserPromptV5,
  hasRepairableScenarioStructure,
  parseBatchGeneratedTests,
  parsePlannedScenariosStrict,
  scenarioTiesBackToRaw,
  PROMPT_VERSION_V5,
  type FlowStep,
  type PlannedScenario,
  type PlanningContext
} from "./promptV5.js";
import { BUCKET_LABEL, BucketEvidence, deriveBucketSignals, selectLocalBuckets } from "./buckets.js";

const MAX_LIMIT = 5;
const DEFAULT_LIMIT = 3;
const MAX_RELATED_FILES = 4;
const SYMBOL_EXCERPT_CONTEXT_LINES = 3;
const MAX_EXCERPT_CHARS = 8000;
const MAX_TARGET_TYPE_EXCERPT_CHARS = 5000;
const STATIC_CHECK_TIMEOUT_MS = 3000;
const GO_COMPILE_CHECK_TIMEOUT_MS = 20000;
/** A source ref that names a test file (used to place a generated test next to it). */
const TEST_REF_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)test\.[cm]?[jt]sx?$)|(_test\.[a-z]+$)|(_spec\.[a-z]+$)|((^|\/)test_[^/]+\.[a-z]+$)/i;

function areaOf(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  const skip = new Set(["src", "app", "lib", "packages", "tests", "test", "e2e", "__tests__", "spec"]);
  for (const part of parts.slice(0, parts.length - 1)) {
    if (!skip.has(part.toLowerCase())) return part;
  }
  return parts.length > 1 ? parts[0] : "core";
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((s) => s && s.trim()))];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function isTsJsLanguage(language: string | null): boolean {
  return language === "typescript" || language === "javascript";
}

function testFilesForSourceFile(graph: LocalGraph, sourceFile: string): string[] {
  const out = new Set<string>();
  for (const ce of graph.candidate_edges) {
    if (ce.relationship_type !== "MAY_RELATE_TO") continue;
    if (ce.to_external_id !== sourceFile) continue;
    const testFile = ce.from_external_id;
    const testNode = findNode(graph, `test:${testFile}`);
    const fileNode = findNode(graph, testFile);
    if (testNode?.kind === "TestCase" || fileNode?.properties.role === "test" || TEST_REF_RE.test(testFile)) out.add(testFile);
  }
  return [...out];
}

/**
 * Strip a Markdown code fence (and any prose around it) from a model body. Real
 * BYOK models frequently wrap the test in ```ts … ``` with a prose preamble/suffix;
 * the fenced content is the runnable code. With no fence, return the body as-is so
 * the deterministic stand-in and already-clean models are untouched.
 */
export function stripCodeFence(body: string): string {
  const m = body.match(/```[a-zA-Z0-9]*\s*\n?([\s\S]*?)```/);
  return (m ? m[1] : body).trim();
}

function acceptanceCriteriaFor(graph: LocalGraph, behavior: GraphNode): string[] {
  const out = asStringArray(behavior.properties.acceptance_criteria);
  for (const e of graph.edges) {
    if (e.relationship_type === "HAS_ACCEPTANCE_CRITERION" && e.from_external_id === behavior.external_id) {
      const ac = findNode(graph, e.to_external_id);
      if (ac) out.push(ac.title || String(ac.properties.text ?? ac.external_id));
    }
  }
  return dedupe(out);
}

function relatedFilePaths(graph: LocalGraph, behavior: GraphNode): { files: string[]; testFiles: string[] } {
  const files = new Set<string>();
  const testFiles = new Set<string>();
  const area = String(behavior.properties.area ?? "");

  if (behavior.kind === "CodeSymbol" && typeof behavior.properties.file === "string") {
    const sourceFile = behavior.properties.file;
    files.add(sourceFile);
    for (const testFile of testFilesForSourceFile(graph, sourceFile)) {
      files.add(testFile);
      testFiles.add(testFile);
    }
  }

  for (const ce of graph.candidate_edges) {
    if (
      ce.from_external_id === behavior.external_id &&
      (ce.relationship_type === "MAY_BE_TESTED_BY" || ce.relationship_type === "MAY_COVER")
    ) {
      const t = findNode(graph, ce.to_external_id);
      if (t?.properties.file) {
        files.add(String(t.properties.file));
        testFiles.add(String(t.properties.file));
      }
    }
  }
  // Resolved test->source linkage (import graph): the source modules the
  // behavior's test files actually IMPORT are the strongest code grounding —
  // added before the same-area filler so they are never displaced by
  // unrelated config-ish files in the same directory area.
  if (testFiles.size) {
    for (const ce of graph.candidate_edges) {
      if (ce.relationship_type !== "MAY_RELATE_TO") continue;
      if (testFiles.has(ce.from_external_id)) files.add(ce.to_external_id);
      else if (testFiles.has(ce.to_external_id)) files.add(ce.from_external_id);
    }
  }
  for (const e of graph.edges) {
    if (
      (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS" || e.relationship_type === "IMPLEMENTED_IN") &&
      (e.from_external_id === behavior.external_id || e.to_external_id === behavior.external_id)
    ) {
      const other = e.from_external_id === behavior.external_id ? e.to_external_id : e.from_external_id;
      const t = findNode(graph, other);
      if (t?.properties.file) files.add(String(t.properties.file));
      else if (t?.kind === "File") files.add(t.external_id);
    }
  }
  if (area) {
    for (const n of graph.nodes) {
      if (files.size >= MAX_RELATED_FILES) break;
      if (n.kind === "File" && n.properties.role === "code" && areaOf(n.external_id) === area) files.add(n.external_id);
    }
  }
  return { files: [...files].slice(0, MAX_RELATED_FILES), testFiles: [...testFiles] };
}

const MAX_SUBJECT_IMPORTS = 10;

/** Rebuild one import line from parse metadata (specifier + binding names — never source text). */
function reconstructImportLine(specifier: string, bindings: ImportBinding[]): string | null {
  if (!bindings.length) return null; // side-effect/dynamic imports are not reconstructable subjects
  const def = bindings.find((b) => b.imported === "default");
  const ns = bindings.find((b) => b.imported === "*");
  const named = bindings.filter((b) => b.imported !== "default" && b.imported !== "*");
  const parts: string[] = [];
  if (def) parts.push(def.local);
  if (ns) parts.push(`* as ${ns.local}`);
  if (named.length) {
    parts.push(`{${named.map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`)).join(", ")}}`);
  }
  // JSON.stringify escapes quotes/backslashes in the specifier (an unescaped
  // quote would emit an invalid import line).
  return `import ${parts.join(", ")} from ${JSON.stringify(specifier)};`;
}

/**
 * Working import lines for a NEW sibling test, reconstructed from the linked
 * EXISTING test file's own imports (the repo already proves these specifiers
 * resolve under its tsconfig/jest config). Reconstruction uses parse METADATA
 * only — specifier strings and binding names, never copied source text.
 */
const TS_JS_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

function subjectImportsFor(graph: LocalGraph, testFiles: string[]): string[] {
  for (const rel of testFiles) {
    if (!TS_JS_FILE_RE.test(rel)) continue; // parse metadata is TS/JS-only
    const collected: Array<{ line: string; internal: boolean }> = [];
    for (const imp of extractImports(path.join(graph.workspace.root, rel))) {
      if (imp.kind !== "runtime" || !imp.bindings.length) continue;
      const line = reconstructImportLine(imp.specifier, imp.bindings);
      if (line && !collected.some((c) => c.line === line)) {
        collected.push({ line, internal: imp.specifier.startsWith(".") });
      }
    }
    if (collected.length) {
      // Relative (internal) imports first so the SUBJECT module — usually the
      // last import in a long test file — always survives the cap. Stable sort
      // keeps the original order within each group.
      collected.sort((a, b) => Number(b.internal) - Number(a.internal));
      return collected.slice(0, MAX_SUBJECT_IMPORTS).map((c) => c.line);
    }
  }
  return [];
}

interface SourceExcerptCandidate {
  key: string;
  file: string;
  label: string;
  text: string;
  snippet: string;
}

function stringProp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberProp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function symbolFile(node: GraphNode): string | null {
  return stringProp(node.properties.file);
}

function symbolStart(node: GraphNode): number | null {
  return numberProp(node.properties.start_line);
}

function symbolEnd(node: GraphNode): number | null {
  return numberProp(node.properties.end_line);
}

function symbolKind(node: GraphNode): string {
  return String(node.properties.symbol_kind ?? "");
}

function isTypeLikeSymbol(node: GraphNode): boolean {
  return /^(class|struct|type|interface|enum|record|trait)$/.test(symbolKind(node));
}

function symbolHasSpan(node: GraphNode): boolean {
  return node.kind === "CodeSymbol" && !!symbolFile(node) && symbolStart(node) !== null && symbolEnd(node) !== null;
}

function sliceLines(content: string, startLine: number, endLine: number, contextLines = 0): { text: string; start: number; end: number } {
  const lines = redactSecretsPreservingLineCount(content).split(/\r?\n/);
  const start = Math.max(1, startLine - contextLines);
  const end = Math.min(lines.length, endLine + contextLines);
  return { text: lines.slice(start - 1, end).join("\n").trim(), start, end };
}

function sourceExcerptForSymbol(node: GraphNode, fileReader: FileReader, label: string): SourceExcerptCandidate | null {
  const file = symbolFile(node);
  const start = symbolStart(node);
  const end = symbolEnd(node);
  if (!file || start === null || end === null) return null;
  const raw = fileReader(file);
  if (!raw) return null;
  let slice = sliceLines(raw, start, end, isTypeLikeSymbol(node) ? 0 : SYMBOL_EXCERPT_CONTEXT_LINES);
  const exact = sliceLines(raw, start, end, 0);
  if (!slice.text) return null;
  if (label === "target symbol" && isTypeLikeSymbol(node) && slice.text.length > MAX_TARGET_TYPE_EXCERPT_CHARS) {
    slice = {
      ...slice,
      text: `${slice.text.slice(0, MAX_TARGET_TYPE_EXCERPT_CHARS - 58)}\n// [orangepro: target excerpt truncated to reserve type budget]`
    };
  }
  const title = node.title || node.external_id.replace(/^sym:[^#]+#/, "");
  return {
    key: `${file}:${slice.start}-${slice.end}:${label}:${title}`,
    file,
    label,
    text: `// file: ${file} lines ${slice.start}-${slice.end} (${label}: ${title})\n${slice.text}`,
    snippet: exact.text || slice.text
  };
}

function sourceExcerptForFileHead(file: string, fileReader: FileReader, label: string, maxLines = 30): SourceExcerptCandidate | null {
  const raw = fileReader(file);
  if (!raw) return null;
  const text = redactSecrets(raw)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, maxLines)
    .join("\n");
  if (!text) return null;
  return { key: `${file}:head:${label}`, file, label, text: `// file: ${file} (${label})\n${text}`, snippet: text };
}

function sourceExcerptForImports(file: string, fileReader: FileReader): SourceExcerptCandidate | null {
  const raw = fileReader(file);
  if (!raw) return null;
  const lines = redactSecrets(raw).split(/\r?\n/);
  const out: string[] = [];
  let inGoImportBlock = false;
  for (const line of lines.slice(0, 80)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inGoImportBlock) out.push(line);
      continue;
    }
    if (/^(package|import|from\s+\S+\s+import|using\s+)/.test(trimmed)) out.push(line);
    if (/^import\s*\($/.test(trimmed)) inGoImportBlock = true;
    else if (inGoImportBlock) {
      out.push(line);
      if (trimmed === ")") inGoImportBlock = false;
    }
  }
  const text = out.join("\n").trim();
  if (!text) return null;
  return { key: `${file}:imports`, file, label: "imports", text: `// file: ${file} (imports)\n${text}`, snippet: text };
}

function sourceExcerptForSymbolSignature(node: GraphNode, fileReader: FileReader, label: string): SourceExcerptCandidate | null {
  const file = symbolFile(node);
  const start = symbolStart(node);
  const end = symbolEnd(node);
  if (!file || start === null || end === null) return null;
  const raw = fileReader(file);
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const picked: string[] = [];
  for (let i = start - 1; i < Math.min(lines.length, end, start + 3); i++) {
    picked.push(lines[i]);
    if (lines[i]?.includes("{")) break;
  }
  const text = redactSecrets(picked.join("\n")).trim();
  if (!text) return null;
  const title = node.title || node.external_id.replace(/^sym:[^#]+#/, "");
  return {
    key: `${file}:${start}:signature:${label}:${title}`,
    file,
    label,
    text: `// file: ${file} line ${start} (${label}: ${title})\n${text}`,
    snippet: text
  };
}

function symbolTitleSet(graph: LocalGraph): Map<string, GraphNode[]> {
  const out = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (n.kind !== "CodeSymbol") continue;
    const name = n.title || n.external_id.replace(/^sym:[^#]+#/, "");
    const list = out.get(name);
    if (list) list.push(n);
    else out.set(name, [n]);
  }
  return out;
}

const COMMON_IDENTIFIER_WORDS = new Set([
  "true",
  "false",
  "nil",
  "null",
  "undefined",
  "return",
  "func",
  "type",
  "struct",
  "interface",
  "const",
  "var",
  "let",
  "string",
  "number",
  "boolean",
  "error",
  "Error"
]);

function identifiersIn(text: string): string[] {
  return dedupe([...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((m) => m[0])).filter(
    (name) => name.length > 1 && !COMMON_IDENTIFIER_WORDS.has(name)
  );
}

function directReferencedSymbols(graph: LocalGraph, behavior: GraphNode): GraphNode[] {
  const out: GraphNode[] = [];
  const add = (id: string): void => {
    if (id === behavior.external_id) return;
    const n = findNode(graph, id);
    if (n?.kind === "CodeSymbol" && symbolHasSpan(n)) out.push(n);
  };
  for (const e of graph.edges) {
    if (e.from_external_id === behavior.external_id && ["CALLS", "IMPORTS", "MAY_CALL", "USES"].includes(e.relationship_type)) add(e.to_external_id);
    else if (e.to_external_id === behavior.external_id && ["CALLS", "IMPORTS", "MAY_CALL", "USES"].includes(e.relationship_type)) add(e.from_external_id);
  }
  for (const ce of graph.candidate_edges) {
    if (ce.from_external_id === behavior.external_id && ["MAY_RELATE_TO", "MAY_COVER", "MAY_CALL"].includes(ce.relationship_type)) add(ce.to_external_id);
    else if (ce.to_external_id === behavior.external_id && ["MAY_RELATE_TO", "MAY_COVER", "MAY_CALL"].includes(ce.relationship_type)) add(ce.from_external_id);
  }
  return out;
}

function referencedSymbolsByName(graph: LocalGraph, targetBody: string, behavior: GraphNode): GraphNode[] {
  const byName = symbolTitleSet(graph);
  const out: GraphNode[] = [];
  for (const ident of identifiersIn(targetBody)) {
    for (const candidate of byName.get(ident) ?? []) {
      if (candidate.external_id !== behavior.external_id && symbolHasSpan(candidate)) out.push(candidate);
    }
  }
  return out;
}

function symbolDir(node: GraphNode): string {
  const file = symbolFile(node) ?? "";
  return file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
}

function rankedReferencedSymbols(graph: LocalGraph, behavior: GraphNode, targetBody: string): GraphNode[] {
  const direct = directReferencedSymbols(graph, behavior);
  const directIds = new Set(direct.map((n) => n.external_id));
  const behaviorDir = behavior.kind === "CodeSymbol" ? symbolDir(behavior) : "";
  const fallback = referencedSymbolsByName(graph, targetBody, behavior);
  return dedupe([...direct, ...fallback].map((n) => n.external_id))
    .map((id) => findNode(graph, id))
    .filter((n): n is GraphNode => !!n && n.kind === "CodeSymbol" && symbolHasSpan(n))
    .sort((a, b) => {
      const directRank = Number(directIds.has(b.external_id)) - Number(directIds.has(a.external_id));
      if (directRank !== 0) return directRank;
      const samePackageRank = Number(symbolDir(b) === behaviorDir) - Number(symbolDir(a) === behaviorDir);
      if (samePackageRank !== 0) return samePackageRank;
      return Number(isTypeLikeSymbol(b)) - Number(isTypeLikeSymbol(a)) || String(a.title ?? "").localeCompare(String(b.title ?? ""));
    })
    .slice(0, 8);
}

function associatedSymbolsForTypeTarget(graph: LocalGraph, behavior: GraphNode): GraphNode[] {
  const file = symbolFile(behavior);
  if (behavior.kind !== "CodeSymbol" || !file || !isTypeLikeSymbol(behavior)) return [];
  return graph.nodes
    .filter(
      (n) =>
        n.kind === "CodeSymbol" &&
        n.external_id !== behavior.external_id &&
        symbolHasSpan(n) &&
        symbolFile(n) === file &&
        !isTypeLikeSymbol(n)
    )
    .sort((a, b) => (symbolStart(a) ?? 0) - (symbolStart(b) ?? 0))
    .slice(0, 4);
}

function addExcerpt(excerpts: string[], candidate: SourceExcerptCandidate, seen: Set<string>, budget: { chars: number }): void {
  if (seen.has(candidate.key)) return;
  let text = candidate.text;
  const remaining = MAX_EXCERPT_CHARS - budget.chars;
  if (remaining <= 0) return;
  if (text.length > remaining) {
    if (!excerpts.length && remaining > 240) text = `${text.slice(0, remaining - 56)}\n// [orangepro: excerpt truncated to budget]`;
    else return;
  }
  excerpts.push(text);
  seen.add(candidate.key);
  budget.chars += text.length;
}

function buildSourceExcerpts(graph: LocalGraph, behavior: GraphNode, relatedFiles: string[], testFiles: string[], fileReader: FileReader): string[] {
  const excerpts: string[] = [];
  const seen = new Set<string>();
  const budget = { chars: 0 };
  const target = behavior.kind === "CodeSymbol" && symbolHasSpan(behavior) ? sourceExcerptForSymbol(behavior, fileReader, "target symbol") : null;
  let hasBodyExcerpt = false;
  if (target) {
    addExcerpt(excerpts, target, seen, budget);
    hasBodyExcerpt = true;
  }
  const targetBody = target?.snippet ?? "";
  for (const sym of rankedReferencedSymbols(graph, behavior, targetBody)) {
    const label = isTypeLikeSymbol(sym) ? "referenced type" : "referenced symbol";
    const excerpt = sourceExcerptForSymbol(sym, fileReader, label);
    if (excerpt) {
      addExcerpt(excerpts, excerpt, seen, budget);
      hasBodyExcerpt = true;
    }
  }
  for (const sym of associatedSymbolsForTypeTarget(graph, behavior)) {
    const label = symbolKind(sym) === "method" ? "associated method" : "associated symbol";
    const excerpt = sourceExcerptForSymbolSignature(sym, fileReader, label);
    if (excerpt) {
      addExcerpt(excerpts, excerpt, seen, budget);
      hasBodyExcerpt = true;
    }
  }
  for (const file of testFiles) {
    const excerpt = sourceExcerptForFileHead(file, fileReader, "existing test", 40);
    if (excerpt) {
      addExcerpt(excerpts, excerpt, seen, budget);
      hasBodyExcerpt = true;
    }
  }
  if (!hasBodyExcerpt) {
    for (const file of relatedFiles) {
      const excerpt = sourceExcerptForFileHead(file, fileReader, "related file", 30);
      if (excerpt) {
        addExcerpt(excerpts, excerpt, seen, budget);
        hasBodyExcerpt = true;
      }
    }
  }
  for (const file of relatedFiles) {
    const excerpt = sourceExcerptForImports(file, fileReader);
    if (excerpt) addExcerpt(excerpts, excerpt, seen, budget);
  }
  if (!excerpts.length) {
    for (const file of relatedFiles) {
      const excerpt = sourceExcerptForFileHead(file, fileReader, "related file", 30);
      if (excerpt) addExcerpt(excerpts, excerpt, seen, budget);
    }
  }
  return excerpts;
}

/**
 * Assemble the grounded generation context (behavior, acceptance criteria, code
 * context, redacted source excerpts, weak/candidate disclosure) for one behavior.
 * Exported so local comparison tools can reuse the same evidence-gathering path
 * as normal graph-grounded generation.
 */
export function gatherContext(
  graph: LocalGraph,
  behavior: GraphNode,
  framework: string,
  fileReader: FileReader
): { ctx: PlanningContext; entityIds: string[]; sourceRefs: string[]; weakUsed: string[] } {
  const acceptance = acceptanceCriteriaFor(graph, behavior);
  const workflow = asStringArray(behavior.properties.workflow_steps);
  const actors = asStringArray(behavior.properties.actors);
  const examples = asStringArray(behavior.properties.example_behaviors);
  const { files: relatedFiles, testFiles } = relatedFilePaths(graph, behavior);
  // Subject imports are TS/JS lines — feeding them to a pytest/go target would
  // produce an unparseable test in the other language.
  const fwLower = framework.toLowerCase();
  const subjectImports =
    fwLower.includes("pytest") || fwLower.includes("python") || fwLower.includes("go") || fwLower.includes("junit") || fwLower.includes("java")
      ? []
      : subjectImportsFor(graph, testFiles);

  const codeContext: string[] = [...relatedFiles];
  for (const file of relatedFiles) {
    const syms = graph.nodes
      .filter((n) => n.kind === "CodeSymbol" && n.properties.file === file)
      .slice(0, 5)
      .map((n) => `${file}:${n.title}`);
    codeContext.push(...syms);
  }

  // In-process, redacted source excerpts — used for the prompt only, never stored.
  const excerpts = buildSourceExcerpts(graph, behavior, relatedFiles, testFiles, fileReader);

  const weakContext: string[] = [];
  const weakUsed: string[] = [];
  if (behavior.evidence_strength === "weak" || behavior.evidence_strength === "candidate") {
    weakContext.push(`Behavior anchor "${behavior.title}" is inferred (${behavior.review_status}).`);
    weakUsed.push(`inferred_anchor:${behavior.external_id}`);
  }
  for (const ce of graph.candidate_edges) {
    if (ce.from_external_id === behavior.external_id) {
      weakContext.push(`${ce.relationship_type}: ${ce.reason} (confidence ${ce.confidence}).`);
      weakUsed.push(`${ce.relationship_type}:${ce.from_external_id}->${ce.to_external_id}`);
    }
  }

  const flowChain = flowChainFor(graph, behavior);

  const ctx: PlanningContext = {
    behavior_external_id: behavior.external_id,
    behavior_title: behavior.title || behavior.external_id,
    description: behavior.properties.description ? String(behavior.properties.description) : undefined,
    actors,
    priority: behavior.properties.priority ? String(behavior.properties.priority) : undefined,
    acceptance_criteria: acceptance,
    workflow_steps: workflow,
    framework,
    test_layer: inferTestLayer(behavior, framework, graph),
    code_context: dedupe(codeContext),
    source_excerpts: excerpts,
    weak_context: dedupe(weakContext),
    // Existing coverage (observed test names): shown so the model generates what is
    // MISSING, never a re-derivation of a test that already exists.
    existing_tests: examples.slice(0, 10),
    subject_imports: subjectImports,
    ...(flowChain ? { flow_chain: flowChain } : {})
  };

  // entity_ids are graph external_ids: the behavior plus related file paths. A
  // File node's external_id IS its workspace-relative path (analyzer), so these
  // resolve in the citation index (graph/citations.ts). A path with no scanned
  // File node would surface as an unresolved citation rather than fabricated proof.
  const entityIds = dedupe([behavior.external_id, ...relatedFiles]);
  const sourceRefs = dedupe([
    behavior.provenance?.source_ref ?? "",
    ...relatedFiles
  ]);
  return { ctx, entityIds, sourceRefs, weakUsed: dedupe(weakUsed) };
}

/**
 * FLOW CHAIN context for the v5 planning prompt, fed ONLY from deterministic
 * `analysis.flows` (hard/framework-derived). AI candidate flows
 * (`analysis.candidate_flows`) are NEVER prompt input — no AI-feeds-AI.
 * Undefined when no deterministic flow contains the target behavior.
 */
function flowChainFor(graph: LocalGraph, behavior: GraphNode): FlowStep[] | undefined {
  const flows = graph.analysis?.flows?.flows ?? [];
  const id = behavior.external_id;
  const flow = flows.find(
    (f) => f.hops.length > 0 && (f.entry_point.external_id === id || f.hops.some((h) => h.from === id || h.to === id))
  );
  if (!flow) return undefined;
  const nodesById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const chain = [flow.hops[0].from, ...flow.hops.map((h) => h.to)];
  return chain.map((symbolId, index) => {
    const node = nodesById.get(symbolId);
    const title = node?.title || symbolId.replace(/^sym:/, "").split("#").pop() || symbolId;
    const dot = title.indexOf(".");
    const file = typeof node?.properties.file === "string" ? node.properties.file : "";
    const fileStem = file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    return {
      behavior_id: symbolId,
      behavior_title: title,
      service: dot > 0 ? title.slice(0, dot) : fileStem || title,
      method: dot > 0 ? title.slice(dot + 1) : title,
      position: index + 1
    };
  });
}

export function inferTestLayer(behavior: GraphNode, framework: string, graph?: LocalGraph): TestLayer {
  const fw = framework.toLowerCase();
  if (fw.includes("playwright") || fw.includes("cypress")) return "e2e";
  if (fw.includes("supertest")) return "api";
  if (fw.includes("testing-library")) return "component";
  const hint = String(behavior.properties.test_layer ?? "");
  if (hint) return hint as TestLayer;
  // Infer a layer only from evidence that actually distinguishes it. A CALLS
  // edge alone says nothing about the intended test boundary: libraries and
  // ordinary unit subjects call helpers too. External handlers are API targets;
  // they become integration targets only when their reachable path crosses a
  // source-file boundary. Ambiguous cases stay unknown instead of being tuned
  // to a server application's topology.
  if (graph) {
    const id = behavior.external_id;
    const isEntryHandler = graph.edges.some((e) => e.relationship_type === "IMPLEMENTED_IN" && e.to_external_id === id);
    const fileById = new Map(
      graph.nodes
        .filter((node) => node.kind === "CodeSymbol")
        .map((node) => [node.external_id, String(node.properties.file ?? "")])
    );
    const behaviorFile = fileById.get(id) ?? "";
    const crossesFile = (from: string, to: string): boolean => {
      const fromFile = fileById.get(from) ?? "";
      const toFile = fileById.get(to) ?? "";
      return fromFile !== "" && toFile !== "" && fromFile !== toFile;
    };
    const directCrossBoundary = graph.edges.some(
      (e) => e.relationship_type === "CALLS" && e.from_external_id === id && crossesFile(e.from_external_id, e.to_external_id)
    );
    const triggeredCrossBoundary = (graph.analysis?.flows?.flows ?? []).some((flow) => {
      if (flow.entry_point.kind !== "Endpoint") return false;
      const chain = flow.hops.length > 0 ? [flow.hops[0].from, ...flow.hops.map((hop) => hop.to)] : [];
      if (!chain.includes(id)) return false;
      const files = new Set(chain.map((symbolId) => fileById.get(symbolId) ?? "").filter(Boolean));
      return files.size > 1;
    });
    if (isEntryHandler) return directCrossBoundary || triggeredCrossBoundary ? "integration" : "api";
    if (behaviorFile && triggeredCrossBoundary) return "integration";
  }
  return "unknown";
}

function tooThin(ctx: GenerationContext): { thin: boolean; needed: string[] } {
  const needed: string[] = [];
  if (ctx.acceptance_criteria.length === 0) needed.push("acceptance criteria or expected outcomes");
  if (!ctx.description && ctx.workflow_steps.length === 0) needed.push("a behavior description or workflow steps");
  if (ctx.code_context.length === 0) needed.push("linked code, tests, or interface mapping");
  // Too thin only when there is essentially nothing to ground a specific assertion.
  // existing_tests counts: observed test names are real behavioral evidence (they
  // used to ride in weak_context; moving them to their own section must not flip
  // example-behaviors-only anchors to "too thin").
  const hasAnyAnchor =
    ctx.acceptance_criteria.length > 0 ||
    Boolean(ctx.description) ||
    ctx.workflow_steps.length > 0 ||
    ctx.code_context.length > 0 ||
    ctx.weak_context.length > 0 ||
    ctx.existing_tests.length > 0;
  return { thin: !hasAnyAnchor, needed };
}

function frameworkForLanguage(language: string): string | null {
  if (language === "python") return "pytest";
  if (language === "go") return "go";
  if (language === "java") return "junit";
  return null;
}

function javaFrameworkFromGraph(graph: LocalGraph): string | null {
  const names = nodesByKind(graph, "Framework")
    .filter((n) => n.properties.category === "test")
    .map((n) => String(n.title ?? "").toLowerCase());
  if (names.some((n) => n.includes("junit4"))) return "junit4";
  if (names.some((n) => n.includes("junit5") || n.includes("junit-jupiter"))) return "junit5";
  return null;
}

function frameworkLanguageGroup(framework: string): "tsjs" | "python" | "go" | "java" | null {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) return "python";
  if (fw.includes("go")) return "go";
  if (fw.includes("junit") || fw.includes("java")) return "java";
  if (
    fw.includes("vitest") ||
    fw.includes("jest") ||
    fw.includes("ava") ||
    fw.includes("playwright") ||
    fw.includes("cypress") ||
    fw.includes("mocha")
  ) {
    return "tsjs";
  }
  return null;
}

function languageMatchesFramework(language: string | null, framework: string): boolean {
  const group = frameworkLanguageGroup(framework);
  if (!group || !language) return true;
  if (group === "tsjs") return isTsJsLanguage(language);
  return language === group;
}

function languageOfRelatedFile(graph: LocalGraph, rel: string): string {
  const fileNode = findNode(graph, rel);
  const fromNode = fileNode?.kind === "File" && typeof fileNode.properties.language === "string" ? fileNode.properties.language : "";
  return fromNode || languageOf(rel);
}

function canGenerateForLanguage(language: string): boolean {
  return ["typescript", "javascript", "python", "go", "java"].includes(language);
}

function primaryTargetLanguage(graph: LocalGraph, target: GraphNode): string | null {
  const files = relatedFilePaths(graph, target).files;
  const firstCode = files.find((rel) => {
    const fileNode = findNode(graph, rel);
    return fileNode?.kind === "File" && fileNode.properties.role === "code";
  });
  const rel = firstCode ?? files[0];
  return rel ? languageOfRelatedFile(graph, rel) : null;
}

function canGenerateForTarget(graph: LocalGraph, target: GraphNode): boolean {
  const language = primaryTargetLanguage(graph, target);
  if (!language) {
    const hasEligibleCodeSymbols = graph.nodes.some((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && n.stale !== true);
    return target.behavior_source !== "test_inferred" || !hasEligibleCodeSymbols;
  }
  return canGenerateForLanguage(language);
}

function isWeakTestNameBehavior(n: GraphNode): boolean {
  return n.behavior_source === "test_inferred" || n.properties.inferred_from === "test_describe";
}

function hasLinkedTestEvidence(graph: LocalGraph, n: GraphNode): boolean {
  if (n.kind !== "CodeSymbol" || n.denominator_eligible !== true || n.stale === true) return false;
  const file = typeof n.properties.file === "string" ? n.properties.file : "";
  const language = file ? languageOfRelatedFile(graph, file) : "";
  // Real-model smoke shows concrete code symbols help TS/JS and Go, but currently
  // reduce pass rate for Python/Java versus their test-name behavior anchors.
  if (!file || (!isTsJsLanguage(language) && language !== "go")) return false;
  return testFilesForSourceFile(graph, file).length > 0;
}

function inferTsJsFrameworkFromTest(content: string): string | null {
  if (/from\s+["']ava["']|require\(["']ava["']\)/.test(content)) return "ava";
  if (/@playwright\/test|from\s+["']playwright["']|require\(["']@playwright\/test["']\)/.test(content)) return "playwright";
  if (/from\s+["']vitest["']|require\(["']vitest["']\)|\bvi\./.test(content)) return "vitest";
  if (/from\s+["']@jest\/globals["']|require\(["']@jest\/globals["']\)|\bjest\./.test(content)) return "jest";
  if (/from\s+["']cypress["']|require\(["']cypress["']\)|\bcy\./.test(content)) return "cypress";
  if (/from\s+["']mocha["']|require\(["']mocha["']\)|from\s+["']chai["']|require\(["']chai["']\)/.test(content)) return "mocha";
  return null;
}

function pickTsJsFrameworkFromRelatedTests(graph: LocalGraph, targets: GraphNode[], fileReader: FileReader): string | null {
  const counts = new Map<string, number>();
  const priority = ["vitest", "jest", "ava", "playwright", "cypress", "mocha"];
  for (const target of targets) {
    if (!languageMatchesFramework(primaryTargetLanguage(graph, target), "vitest")) continue;
    const related = relatedFilePaths(graph, target);
    const testRefs = [...related.testFiles, ...related.files.filter((r) => TEST_REF_RE.test(r))];
    for (const rel of dedupe(testRefs)) {
      const fw = inferTsJsFrameworkFromTest(fileReader(rel) ?? "");
      if (fw) counts.set(fw, (counts.get(fw) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || priority.indexOf(a[0]) - priority.indexOf(b[0]))[0]?.[0] ?? null;
}

function pickFramework(graph: LocalGraph, opts: GenerateOptions, targets: GraphNode[] = [], fileReader?: FileReader): string {
  if (opts.framework) return opts.framework;
  for (const target of targets) {
    const language = primaryTargetLanguage(graph, target);
    const inferred = language === "java" ? javaFrameworkFromGraph(graph) ?? "junit" : language ? frameworkForLanguage(language) : null;
    if (inferred) return inferred;
  }
  const relatedTsJs = fileReader ? pickTsJsFrameworkFromRelatedTests(graph, targets, fileReader) : null;
  if (relatedTsJs) return relatedTsJs;
  const fw = nodesByKind(graph, "Framework").find((n) => n.properties.category === "test");
  return fw?.title || "vitest";
}

function targetsForFramework(graph: LocalGraph, targets: GraphNode[], framework: string): { targets: GraphNode[]; warnings: string[] } {
  const group = frameworkLanguageGroup(framework);
  if (!group) return { targets, warnings: [] };
  const kept = targets.filter((target) => languageMatchesFramework(primaryTargetLanguage(graph, target), framework));
  const skipped = targets.length - kept.length;
  return {
    targets: kept,
    warnings: skipped
      ? [
          `${skipped} supported target(s) in other languages skipped for ${framework} generation; rerun those targets separately so every runnable test matches its language.`
        ]
      : []
  };
}

export interface SelectedTargets {
  targets: GraphNode[];
  warnings: string[];
  /**
   * Behaviors that are not_structurally_confirmable (e2e/api-only): still offered
   * as generation targets, but ranked last and excluded from the confirmed
   * denominator — a generated test for them cannot be structurally confirmed (Phase 4.7).
   */
  nsc_ids: string[];
}

export function selectTargets(graph: LocalGraph, opts: GenerateOptions): SelectedTargets {
  const warnings: string[] = [];
  const behaviors = behaviorNodes(graph);
  const codeSymbols = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && n.stale !== true);
  const explicitGenerationTargets = [...behaviors, ...codeSymbols];
  const concreteLinkedTargets =
    behaviors.length > 0 && behaviors.every(isWeakTestNameBehavior) ? codeSymbols.filter((n) => hasLinkedTestEvidence(graph, n)) : [];
  const concreteLinkedIds = new Set(concreteLinkedTargets.map((n) => n.external_id));
  const rawDefaultTargets = behaviors.length ? [...concreteLinkedTargets, ...behaviors] : codeSymbols;
  const defaultGenerationTargets = rawDefaultTargets.filter((n) => canGenerateForTarget(graph, n));
  const nsc = structurallyUnconfirmable(graph);
  const isNsc = (n: GraphNode): boolean => nsc.has(n.external_id);
  if (opts.target_ids && opts.target_ids.length) {
    const targets: GraphNode[] = [];
    for (const id of opts.target_ids) {
      const node = findNode(graph, id);
      if (!node) {
        warnings.push(`Target ${id} not found in graph.`);
        continue;
      }
      if (explicitGenerationTargets.includes(node) && canGenerateForTarget(graph, node)) targets.push(node);
      else warnings.push(`Target ${id} is a ${node.kind}, not a supported generation target; skipped.`);
    }
    return { targets, warnings, nsc_ids: targets.filter(isNsc).map((n) => n.external_id) };
  }
  const ranked = [...defaultGenerationTargets].sort((a, b) => {
    const ca = concreteLinkedIds.has(a.external_id) ? 0 : 1;
    const cb = concreteLinkedIds.has(b.external_id) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    // not_structurally_confirmable behaviors rank BELOW every structurally-
    // confirmable gap (Phase 4.7): a generated test for an e2e/api-only behavior
    // cannot be structurally confirmed, so it is a lower-value target.
    const na = isNsc(a) ? 1 : 0;
    const nb = isNsc(b) ? 1 : 0;
    if (na !== nb) return na - nb; // non-nsc (0) first
    const pr = priorityRank(b.properties.priority) - priorityRank(a.properties.priority);
    if (pr !== 0) return pr;
    const strengthOrder = (n: GraphNode) => (n.evidence_strength === "hard" || n.evidence_strength === "reviewed" ? 1 : 0);
    return strengthOrder(b) - strengthOrder(a);
  });
  const nsc_ids = ranked.filter(isNsc).map((n) => n.external_id);
  if (nsc_ids.length > 0) {
    warnings.push(
      `${nsc_ids.length} behavior(s) are only covered by e2e/api tests (not structurally confirmable) — offered as targets but ranked last and excluded from the confirmed denominator.`
    );
  }
  if (!behaviors.length && codeSymbols.length) {
    warnings.push("No requirement/user-flow anchors found; targeting eligible code symbols instead.");
  }
  if (concreteLinkedTargets.length > 0) {
    warnings.push(
      `Generation prioritized ${concreteLinkedTargets.length} concrete code symbol target(s) with linked test evidence over weak test-name-only behavior labels.`
    );
  }
  const skippedUnsupported = rawDefaultTargets.length - defaultGenerationTargets.length;
  if (skippedUnsupported > 0) {
    warnings.push(
      `${skippedUnsupported} target(s) use languages without runnable local templates yet; graph evidence is kept, but generation is skipped.`
    );
  }
  return { targets: ranked, warnings, nsc_ids };
}

/**
 * Post-generation guard. A strict pack schema cannot stop a model from echoing
 * proprietary source inside the one free-text field (`body`), so we sanitize the
 * output BEFORE it is stored or exported: blanket-redact secrets, then strip any
 * line that overlaps a source excerpt we fed into the prompt.
 */
export function sanitizeGeneratedBody(
  body: string,
  sourceExcerpts: string[],
  commentPrefix = "//"
): { body: string; redactedLines: number } {
  const cleaned = redactSecrets(body);
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const secretLines = new Set<string>();
  const protectedLines = new Set<string>();
  const protectedBlocks: string[][] = [];
  for (const block of sourceExcerpts) {
    const blockLines = block.split(/\r?\n/);
    const header = blockLines[0] ?? "";
    const protectVerbatim = !/\(existing test\)/.test(header);
    const currentBlock: string[] = [];
    let inImportBlock = false;
    for (const line of blockLines) {
      if (line.startsWith("// file:")) continue;
      const trimmed = line.trim();
      if (/^import\s*\($/.test(trimmed)) {
        if (currentBlock.length >= 2) protectedBlocks.push([...currentBlock]);
        currentBlock.length = 0;
        inImportBlock = true;
        continue;
      }
      if (inImportBlock) {
        if (trimmed === ")") inImportBlock = false;
        continue;
      }
      const n = norm(line);
      if (n.length < 20 || isPureImportLine(line) || isApiSurfaceLine(line)) {
        if (currentBlock.length >= 2) protectedBlocks.push([...currentBlock]);
        currentBlock.length = 0;
        continue;
      }
      if (n.includes("<redacted:")) secretLines.add(n);
      else if (!protectVerbatim) continue;
      else {
        protectedLines.add(n);
        currentBlock.push(n);
      }
    }
    if (currentBlock.length >= 2) protectedBlocks.push([...currentBlock]);
  }
  if (secretLines.size === 0 && protectedLines.size === 0 && protectedBlocks.length === 0) return { body: cleaned, redactedLines: 0 };

  let redactedLines = 0;
  const lines = cleaned.split(/\r?\n/);
  const normalizedLines = lines.map(norm);
  const redactedIndexes = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (isPureImportLine(lines[i])) continue;
    if (isGoImportSpecLine(lines[i])) continue;
    if (isApiSurfaceLine(lines[i])) continue;
    const n = normalizedLines[i];
    if (n.length < 20) continue;
    for (const p of [...secretLines, ...protectedLines]) {
      if (n.includes(p) || p.includes(n)) redactedIndexes.add(i);
    }
  }
  for (const block of protectedBlocks) {
    for (let i = 0; i <= normalizedLines.length - block.length; i++) {
      let matched = true;
      for (let j = 0; j < block.length; j++) {
        const n = normalizedLines[i + j];
        const p = block[j];
        if (
          n.length < 20 ||
          isPureImportLine(lines[i + j]) ||
          isGoImportSpecLine(lines[i + j]) ||
          isApiSurfaceLine(lines[i + j]) ||
          !(n.includes(p) || p.includes(n))
        ) {
          matched = false;
          break;
        }
      }
      if (matched) {
        for (let j = 0; j < block.length; j++) redactedIndexes.add(i + j);
      }
    }
  }
  const out = lines
    .map((line, i) => {
      if (!redactedIndexes.has(i)) return line;
      redactedLines++;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return `${indent}${commentPrefix} ${REDACTION_MARKER_TEXT}`;
    })
    .join("\n");
  return { body: cleanRedactionMarkersInGoImportBlocks(out), redactedLines };
}

function isApiSurfaceLine(line: string): boolean {
  const t = line.trim();
  if (!t || /^(\/\/|#|\/\*|\*|\*\/)/.test(t)) return true;
  if (/^(package|namespace|using)\b/.test(t)) return true;
  if (/^(export\s+)?(type|interface|enum|class|struct|record|trait)\b/.test(t)) return true;
  if (/^(public|private|protected)?\s*(static\s+)?(final\s+)?(class|interface|enum|record)\b/.test(t)) return true;
  if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*([A-Z0-9_.'"`-]+|\[[^\]]*\]|\{[^{}]*\})\s*;?$/.test(t)) return true;
  if (/^const\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(\"[^\"]*\"|'[^']*'|`[^`]*`|[0-9_.-]+|true|false)\s*$/.test(t)) return true;
  return false;
}

function isGoImportSpecLine(line: string): boolean {
  const t = line.trim();
  return /^([A-Za-z_][A-Za-z0-9_]*|[._])?\s*"(?:[^"\\]|\\.)+"$/.test(t);
}

function cleanRedactionMarkersInGoImportBlocks(body: string): string {
  if (!body.includes(REDACTION_MARKER_TEXT)) return body;
  const out: string[] = [];
  let inBlock = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inBlock) {
      out.push(line);
      if (/^import\s*\($/.test(trimmed)) inBlock = true;
      continue;
    }
    if (line.includes(REDACTION_MARKER_TEXT)) continue;
    if (trimmed === ")") {
      out.push(line);
      inBlock = false;
      continue;
    }
    if (trimmed && !isGoImportSpecLine(line) && !trimmed.startsWith("//")) {
      out.push(")");
      inBlock = false;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  if (inBlock) out.push(")");
  return out.join("\n");
}

/**
 * Import/from lines are module paths + exported names — metadata the kit already
 * discloses in source_refs — so they are exempt from source-excerpt redaction
 * (redacting them only breaks runnability; the model is EXPECTED to reproduce the
 * repo's import lines). Exemption requires the line to be a PURE import statement:
 * a prefix check alone would let `import x from "./m"; secretCode()` smuggle an
 * echoed source line through on its tail, so the line must parse as exactly one
 * import/export-from declaration with NOTHING after it (no second statement, no
 * trailing comment riding along).
 */
function isPureImportLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Python: `from x import a, b` / `import x, y` — char classes exclude `;`, `(`,
  // and `#`, so one-liners (`import os; os.system(...)`) and comment tails fail.
  if (/^(from\s+[\w.]+\s+import\s+[\w*,\s]+|import\s+[\w.,\s]+)$/.test(t)) return true;
  if (/^import\s+(static\s+)?[A-Za-z_][A-Za-z0-9_.*]*(\.[A-Za-z_][A-Za-z0-9_*]*)*\s*;$/.test(t)) return true;
  if (!/^(import\b|export\b)/.test(t)) return false;
  const sf = ts.createSourceFile("line.ts", t, ts.ScriptTarget.Latest, /*setParentNodes*/ false);
  if (sf.statements.length !== 1) return false; // a second statement = smuggled code
  const s = sf.statements[0];
  const pure = ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined);
  if (!pure) return false;
  // Nothing may trail the statement (s.end excludes trailing trivia, so an
  // appended comment — `import x from "./m"; // secret` — is rejected here).
  return t.slice(s.end).replace(/[;\s]/g, "") === "";
}

const REDACTION_MARKER_TEXT = "[orangepro: source excerpt redacted]";

/**
 * Post-redaction AST cleanup: a statement whose head or body was redacted leaves
 * dangling fragments (e.g. an orphaned `}));` from a half-redacted `jest.mock`
 * block) that break the whole file. Drop every statement that CONTAINS a
 * redaction marker between its real start and end (a marker comment sitting
 * ABOVE a statement is leading trivia and never condemns it), so the emitted
 * test always parses. Parse-only (`ts.createSourceFile`), TS/JS frameworks only.
 */
export function stripRedactedStatements(body: string): { body: string; dropped: number } {
  if (!body.includes(REDACTION_MARKER_TEXT)) return { body, dropped: 0 };
  const sf = ts.createSourceFile("generated.tsx", body, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const ranges: Array<[number, number]> = [];
  for (const stmt of sf.statements) {
    const start = stmt.getStart(sf); // excludes leading trivia
    if (body.slice(start, stmt.getEnd()).includes(REDACTION_MARKER_TEXT)) ranges.push([start, stmt.getEnd()]);
  }
  if (!ranges.length) return { body, dropped: 0 };
  let out = body;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i];
    out = out.slice(0, start) + "// [orangepro: statement removed — it echoed redacted source]" + out.slice(end);
  }
  return { body: out, dropped: ranges.length };
}

function firstGoPackage(files: string[], fileReader: FileReader): string | null {
  for (const rel of files) {
    if (!/\.go$/i.test(rel)) continue;
    const content = fileReader(rel);
    const m = content?.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)\b/m);
    if (m) return m[1];
  }
  return null;
}

function applyGoPackage(body: string, packageName: string | null): string {
  if (!packageName) return body;
  if (/^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\b/m.test(body)) {
    return body.replace(/^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\b/m, `package ${packageName}`);
  }
  return `package ${packageName}\n\n${body}`;
}

function firstJavaPackage(files: string[], fileReader: FileReader): string | null {
  for (const rel of files) {
    if (!/\.java$/i.test(rel)) continue;
    const content = fileReader(rel);
    const m = content?.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m);
    if (m) return m[1];
  }
  return null;
}

function applyJavaPackage(body: string, packageName: string | null): string {
  if (!packageName) return body;
  if (/^\s*package\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/m.test(body)) {
    return body.replace(/^\s*package\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/m, `package ${packageName};`);
  }
  return `package ${packageName};\n\n${body}`;
}

function leadingLicenseHeader(content: string): string | null {
  const text = content.replace(/^\uFEFF/, "");
  const block = text.match(/^\s*(\/\*[\s\S]*?\*\/)/);
  const line = text.match(/^\s*((?:\/\/[^\n]*(?:\n|$))+)/);
  const header = (block?.[1] ?? line?.[1] ?? "").trimEnd();
  if (!header) return null;
  if (!/(SPDX-License-Identifier|Licensed under|Copyright|\blicense\b)/i.test(header)) return null;
  return header;
}

function firstJavaLicenseHeader(files: string[], fileReader: FileReader): string | null {
  for (const rel of files) {
    if (!/\.java$/i.test(rel)) continue;
    const header = leadingLicenseHeader(fileReader(rel) ?? "");
    if (header) return header;
  }
  return null;
}

function applyJavaLicenseHeader(body: string, header: string | null): string {
  if (!header || body.trimStart().startsWith(header)) return body;
  return `${header}\n\n${body}`;
}

function ensureGoTestingImport(body: string): string {
  if (!/\bfunc\s+Test[A-Za-z0-9_]*\s*\(\s*t\s+\*testing\.T\s*\)/m.test(body)) return body;
  if (goImportSpecs(body).includes("testing")) return body;
  const lines = body.split(/\r?\n/);
  const singleImport = lines.findIndex((l) => /^\s*import\s+"[^"]+"\s*$/.test(l));
  if (singleImport >= 0) {
    const existing = lines[singleImport].trim().replace(/^import\s+/, "");
    lines.splice(singleImport, 1, "import (", `\t${existing}`, '\t"testing"', ")");
    return lines.join("\n");
  }
  const blockImport = lines.findIndex((l) => /^\s*import\s*\(\s*$/.test(l));
  if (blockImport >= 0) {
    lines.splice(blockImport + 1, 0, '\t"testing"');
    return lines.join("\n");
  }
  const pkg = lines.findIndex((l) => /^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(l));
  if (pkg >= 0) {
    lines.splice(pkg + 1, 0, "", 'import "testing"');
    return lines.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  return body;
}

function javaJUnitFlavor(framework: string): "junit4" | "junit5" {
  return framework.toLowerCase().includes("junit4") ? "junit4" : "junit5";
}

function ensureJavaJUnitImports(body: string, framework: string): string {
  if (!/@Test\b/.test(body) && !/\bassert(?:True|False|Equals|NotNull|Null|Throws)\s*\(|\bAssertions\./.test(body)) return body;
  const imports: string[] = [];
  const flavor = javaJUnitFlavor(framework);
  const hasAnyTestImport = /\bimport\s+org\.junit(?:\.jupiter\.api)?\.Test\s*;/.test(body);
  const hasAnyStaticAssertImport = /\bimport\s+static\s+org\.junit\.(?:jupiter\.api\.Assertions|Assert)\./.test(body);
  if (/@Test\b/.test(body) && !hasAnyTestImport) {
    imports.push(flavor === "junit4" ? "import org.junit.Test;" : "import org.junit.jupiter.api.Test;");
  }
  if (
    /\bassert(?:True|False|Equals|NotNull|Null|Throws)\s*\(/.test(body) &&
    !hasAnyStaticAssertImport
  ) {
    imports.push(flavor === "junit4" ? "import static org.junit.Assert.*;" : "import static org.junit.jupiter.api.Assertions.*;");
  }
  if (flavor === "junit4" && /\bAssert\./.test(body) && !/\bimport\s+org\.junit\.Assert\s*;/.test(body)) {
    imports.push("import org.junit.Assert;");
  }
  if (flavor === "junit5" && /\bAssertions\./.test(body) && !/\bimport\s+org\.junit\.jupiter\.api\.Assertions\s*;/.test(body)) {
    imports.push("import org.junit.jupiter.api.Assertions;");
  }
  if (!imports.length) return body;
  const lines = body.split(/\r?\n/);
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*package\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/.test(lines[i]) || /^\s*import\s+/.test(lines[i])) insertAt = i;
  }
  lines.splice(insertAt + 1, 0, ...imports);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function ensureFrameworkScaffold(body: string, framework: string): string {
  const fw = framework.toLowerCase();
  if (fw.includes("go")) return ensureGoTestingImport(body);
  if (fw.includes("junit") || fw.includes("java")) return ensureJavaJUnitImports(body, framework);
  if (isResolverFramework(framework)) return ensureTsJsFrameworkBindings(body, framework);
  return body;
}

function commentPrefixForFramework(framework: string): string {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) return "#";
  return "//";
}

/**
 * True when the body still contains EXECUTABLE content. A body reduced to
 * comments/markers by redaction+strip must not ship as a "generated test" —
 * it would look like a test while asserting nothing. Import/export-only bodies
 * count as empty too: redaction can strip the only real test statement and
 * leave just the import lines behind, and an import-only "test" proves nothing.
 */
export function hasExecutableContent(body: string, framework: string): boolean {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python") || fw.includes("go") || fw.includes("junit") || fw.includes("java")) {
    // Tracks multi-line import groups (Go's `import ( ... )`, Python's
    // `from x import (a, b)` spread across lines) and Python docstrings.
    // Parens are counted on the line with any trailing #/// comment stripped:
    // a comment like `# fallback(legacy` must not open a phantom group that
    // swallows the next real line, and a Go in-group comment containing `)`
    // must not close the group early.
    let inImportBlock = false;
    let docDelim: string | null = null;
    return body.split(/\r?\n/).some((l) => {
      const t = l.trim();
      if (docDelim) {
        // Python closes a string only on the delimiter that OPENED it — a
        // """ inside a '''-docstring is prose, not a close.
        if (t.includes(docDelim)) docDelim = null;
        return false;
      }
      if (t.length === 0 || t.startsWith("#") || t.startsWith("//")) return false;
      const doc = t.match(/^("""|''')/);
      if (doc) {
        const rest = t.slice(3);
        const close = rest.indexOf(doc[1]);
        if (close === -1) {
          docDelim = doc[1];
          return false;
        }
        // Self-closing one-liner: anything after the close is real code.
        return rest.slice(close + 3).replace(/(#|\/\/).*$/, "").trim().length > 0;
      }
      const code = t.replace(/(#|\/\/).*$/, "").trimEnd();
      if (inImportBlock) {
        if (code.includes(")")) inImportBlock = false;
        return false;
      }
      if (/^(import|from|package)\b/.test(code)) {
        if ((code.match(/\(/g) ?? []).length > (code.match(/\)/g) ?? []).length) inImportBlock = true;
        return false;
      }
      return true;
    });
  }
  const sf = ts.createSourceFile("check.tsx", body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  return sf.statements.some(
    (s) => !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s) && !ts.isImportEqualsDeclaration(s) && !ts.isExportAssignment(s)
  );
}

/** Body already carries its own imports (the prompt demands complete imports). */
const BODY_HAS_IMPORTS_RE = /^\s*(import\b|from\s+\S+\s+import\b)/m;

function frameworkImport(framework: string): string {
  const fw = framework.toLowerCase();
  if (fw.includes("ava")) return 'import test from "ava";';
  if (fw.includes("playwright")) return 'import { test, expect } from "@playwright/test";';
  if (fw.includes("cypress")) return "// Cypress globals (describe/it/cy) are ambient — no import needed.";
  if (fw.includes("jest")) return 'import { describe, it, expect, jest } from "@jest/globals";';
  if (fw.includes("mocha")) return 'import { describe, it } from "mocha";\nimport { expect } from "chai";';
  if (fw.includes("pytest")) return "import pytest";
  if (fw.includes("junit4")) return "import org.junit.Test;\nimport static org.junit.Assert.*;";
  if (fw.includes("junit") || fw.includes("java")) return "import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;";
  return 'import { describe, it, expect, vi } from "vitest";';
}

/**
 * RUNTIME local names + module specifiers bound by a set of TS/JS import lines
 * (parse-only). Type-only clauses and elements are skipped: they bind no value
 * at runtime, so they must neither satisfy nor filter a framework import.
 */
function importBindings(lines: string[]): { names: Set<string>; modules: Set<string> } {
  const names = new Set<string>();
  const modules = new Set<string>();
  const sf = ts.createSourceFile("imports.ts", lines.join("\n"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) continue;
    if (ts.isStringLiteral(s.moduleSpecifier)) modules.add(s.moduleSpecifier.text);
    const c = s.importClause;
    if (!c || c.isTypeOnly) continue;
    if (c.name) names.add(c.name.text);
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) names.add(c.namedBindings.name.text);
      else for (const el of c.namedBindings.elements) if (!el.isTypeOnly) names.add(el.name.text);
    }
  }
  return { names, modules };
}

function usedIdentifiers(body: string, names: string[]): string[] {
  return names.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
}

function insertImportLines(body: string, imports: string[]): string {
  if (!imports.length) return body;
  const lines = body.split(/\r?\n/);
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s+/.test(lines[i])) insertAt = i;
  }
  lines.splice(insertAt + 1, 0, ...imports);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function addNamedImportBindings(body: string, moduleName: string, names: string[]): { body: string; added: boolean } {
  if (!names.length) return { body, added: false };
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["'];?`);
  const m = body.match(re);
  if (!m) return { body, added: false };
  const existing = m[1].split(",").map((part) => part.trim()).filter(Boolean);
  const merged = [...existing, ...names.filter((name) => !existing.some((part) => part.split(/\s+as\s+/i).pop() === name))];
  return { body: body.replace(re, `import { ${merged.join(", ")} } from "${moduleName}";`), added: true };
}

function frameworkRuntimeNeeds(framework: string, body: string): Array<{ module: string; names: string[] }> {
  const fw = framework.toLowerCase();
  if (fw.includes("cypress")) return [];
  if (fw.includes("playwright")) return [{ module: "@playwright/test", names: usedIdentifiers(body, ["test", "expect"]) }];
  if (fw.includes("jest")) {
    return [
      {
        module: "@jest/globals",
        names: usedIdentifiers(body, ["describe", "it", "test", "expect", "jest", "beforeEach", "afterEach", "beforeAll", "afterAll"])
      }
    ];
  }
  if (fw.includes("mocha")) {
    return [
      { module: "mocha", names: usedIdentifiers(body, ["describe", "it", "before", "after", "beforeEach", "afterEach"]) },
      { module: "chai", names: usedIdentifiers(body, ["expect"]) }
    ];
  }
  if (fw.includes("vitest")) {
    return [
      {
        module: "vitest",
        names: usedIdentifiers(body, ["describe", "it", "test", "expect", "vi", "beforeEach", "afterEach", "beforeAll", "afterAll"])
      }
    ];
  }
  return [];
}

function ensureTsJsFrameworkBindings(body: string, framework: string): string {
  if (!BODY_HAS_IMPORTS_RE.test(body)) return body;
  const bound = importBindings([body]).names;
  let out = body;
  const importsToAdd: string[] = [];
  if (framework.toLowerCase().includes("ava") && /\btest\s*\(/.test(body) && !bound.has("test")) {
    importsToAdd.push('import test from "ava";');
    bound.add("test");
  }
  for (const need of frameworkRuntimeNeeds(framework, body)) {
    const missing = need.names.filter((name) => !bound.has(name));
    if (!missing.length) continue;
    const amended = addNamedImportBindings(out, need.module, missing);
    if (amended.added) {
      out = amended.body;
    } else {
      importsToAdd.push(`import { ${missing.join(", ")} } from "${need.module}";`);
    }
    for (const name of missing) bound.add(name);
  }
  return insertImportLines(out, importsToAdd);
}

/**
 * The framework import lines still needed once the subject imports are in
 * place. Name-aware per line: names a subject import already binds are filtered
 * out — subject lines like `import { expect } from "chai"` must not collide
 * with our `expect` into a duplicate declaration — and only the still-missing
 * names are emitted. Importing the same MODULE twice is deliberately allowed
 * (valid ESM; only duplicate local names collide): a subject line importing
 * `test`/`expect` from vitest must not suppress the `describe`/`it` the body
 * needs. mocha's two-line bundle (mocha + chai) is decided per line.
 */
function frameworkImportsNeeded(framework: string, subjectImports: string[]): string[] {
  const fw = framework.toLowerCase();
  if (fw.includes("cypress")) return []; // ambient globals — nothing to add
  if (fw.includes("pytest")) {
    // Product runs pass no subject imports for pytest/go/java (see gatherContext);
    // kept correct for direct callers.
    return subjectImports.some((l) => /\bpytest\b/.test(l)) ? [] : [frameworkImport(framework)];
  }
  const bound = importBindings(subjectImports);
  const out: string[] = [];
  for (const line of frameworkImport(framework).split("\n")) {
    const fwLine = importBindings([line]);
    const mod = [...fwLine.modules][0];
    if (!mod) continue;
    const missing = [...fwLine.names].filter((n) => !bound.names.has(n));
    if (missing.length === 0) continue;
    out.push(missing.length === fwLine.names.size ? line : `import { ${missing.join(", ")} } from "${mod}";`);
  }
  return out;
}

/**
 * Build usable imports from graph METADATA (never from the redacted source
 * excerpts). This keeps a grounded test runnable without copying proprietary
 * code: the framework import plus a best-effort subject import derived from the
 * inferred feature/module name.
 */
export function synthesizeImports(framework: string, subjectImports: string[]): string[] {
  // The repo itself proves these import lines work (they come from the linked
  // existing test file's parse metadata) — used instead of guessing. The framework
  // import is still ours to add: this path runs only when the model body has NO
  // imports, so dropping it would leave the test unrunnable. There is NO module-
  // name guess fallback — a subject with no derivable import is handled by the
  // caller (resolver-derivation, else a non-runnable grounded draft).
  return [
    "// Imports reconstructed by OrangePro from the repo's own test for this area (metadata only):",
    ...frameworkImportsNeeded(framework, subjectImports),
    ...subjectImports
  ];
}

/** Frameworks whose imports the kit does not synthesize (non-TS/JS import systems). */
function isResolverFramework(framework: string): boolean {
  const fw = framework.toLowerCase();
  return !(fw.includes("pytest") || fw.includes("python") || fw.includes("go") || fw.includes("junit") || fw.includes("java"));
}

/**
 * A generated test needs SOME subject import to run. For TS/JS that means provenance
 * other than "none" (the kit refuses to fabricate one). Python/Go/Java tests are never
 * kit-synthesized, so their runnability does not hinge on our import layer.
 */
function importsOk(framework: string, provenance: ImportProvenance): boolean {
  return isResolverFramework(framework) ? provenance !== "none" : true;
}

/** Static parse check (TS/JS): the body has no syntax errors. */
function bodyParses(body: string): boolean {
  const sf = ts.createSourceFile("__generated__.tsx", body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const diags = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  return !diags || diags.length === 0;
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore", timeout: STATIC_CHECK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function shortStaticDiag(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pythonModuleFromSrcLayout(relPath: string): string | null {
  const parts = relPath.replace(/\\/g, "/").split("/");
  if (parts.length < 3 || parts[0] !== "src" || !parts.at(-1)?.endsWith(".py")) return null;
  const packageName = parts[1];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(packageName)) return null;
  const moduleParts = parts.slice(2);
  moduleParts[moduleParts.length - 1] = moduleParts[moduleParts.length - 1].replace(/\.py$/, "");
  if (moduleParts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) return null;
  if (moduleParts.length === 1 && moduleParts[0] === "__init__") return packageName;
  return [packageName, ...moduleParts.filter((part) => part !== "__init__")].join(".");
}

function applyPythonSrcLayoutImports(body: string, relatedFiles: string[]): string {
  const modules = dedupe(relatedFiles.map(pythonModuleFromSrcLayout).filter((m): m is string => Boolean(m)));
  let next = body;
  for (const moduleName of modules.sort((a, b) => b.length - a.length)) {
    const escaped = escapeRegExp(moduleName);
    next = next.replace(new RegExp(`\\bfrom\\s+src\\.${escaped}\\s+import\\b`, "g"), `from ${moduleName} import`);
    next = next.replace(new RegExp(`\\bimport\\s+src\\.${escaped}(?=\\s|$|,|\\))`, "g"), `import ${moduleName}`);
  }
  return next;
}

function writeTempStaticFile(ext: string, body: string): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "op-gen-static-"));
  const file = path.join(dir, `generated.${ext}`);
  writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return { dir, file };
}

function pythonStaticIssue(body: string): string | null {
  if (!commandAvailable("python3")) return "python3 not found; cannot verify pytest syntax.";
  const { dir, file } = writeTempStaticFile("py", body);
  const pytestEntrypointCheck = [
    "import ast, sys",
    "path = sys.argv[1]",
    "tree = ast.parse(open(path, encoding='utf8').read(), filename=path)",
    "def is_test_func(n):",
    "    return isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith('test_')",
    "ok = any(is_test_func(n) for n in tree.body)",
    "ok = ok or any(isinstance(c, ast.ClassDef) and c.name.startswith('Test') and any(is_test_func(m) for m in c.body) for c in tree.body)",
    "if not ok:",
    "    raise SystemExit('pytest test entrypoint not found; expected def test_... or Test*.test_...')"
  ].join("\n");
  try {
    execFileSync("python3", ["-m", "py_compile", file], { stdio: "pipe", timeout: STATIC_CHECK_TIMEOUT_MS });
    execFileSync("python3", ["-c", pytestEntrypointCheck, file], { stdio: "pipe", timeout: STATIC_CHECK_TIMEOUT_MS });
    return null;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    return `Python syntax check failed: ${shortStaticDiag(output || err.message || "unknown error")}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function goStaticIssue(body: string): string | null {
  if (!/^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\b/m.test(body)) return "Go test is missing a package declaration.";
  const imports = goImportSpecs(body);
  if (!imports.includes("testing")) return 'Go test is missing import "testing".';
  if (!/\bfunc\s+Test[A-Za-z0-9_]*\s*\(\s*t\s+\*testing\.T\s*\)/m.test(body)) {
    return "Go test is missing a func Test...(t *testing.T) entrypoint.";
  }
  const external = imports.filter((spec) => spec.split("/")[0].includes("."));
  if (external.length) {
    return `Go test imports module-path package(s) ${external.join(", ")}; OrangePro cannot verify module imports resolve from the generated file. Prefer same-package or stdlib-only code.`;
  }
  if (!commandAvailable("gofmt")) return "gofmt not found; cannot verify Go syntax.";
  const { dir, file } = writeTempStaticFile("go", body);
  try {
    execFileSync("gofmt", [file], { stdio: "pipe", timeout: STATIC_CHECK_TIMEOUT_MS });
    return null;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    return `Go syntax check failed: ${shortStaticDiag(output || err.message || "unknown error")}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function findGoModuleRoot(startDir: string, workspaceRoot: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.resolve(workspaceRoot);
  while (dir.startsWith(root)) {
    if (existsSync(path.join(dir, "go.mod"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function goCompileIssue(body: string, workspaceRoot: string, relatedFiles: string[]): string | null {
  const sourceFile = relatedFiles.find((rel) => /\.go$/i.test(rel) && !TEST_REF_RE.test(rel));
  if (!sourceFile) return null;
  const packageDir = path.resolve(workspaceRoot, path.dirname(sourceFile));
  if (!existsSync(packageDir) || !findGoModuleRoot(packageDir, workspaceRoot)) return null;
  if (!commandAvailable("go")) return "go not found; cannot verify generated Go test compiles.";

  const tempRel = `orangepro_compile_${process.pid}_${shortHash(body)}_test.go`;
  const tempFile = path.join(packageDir, tempRel);
  try {
    writeFileSync(tempFile, body);
    execFileSync("go", ["test", "-run", "^$", "."], { cwd: packageDir, stdio: "pipe", timeout: GO_COMPILE_CHECK_TIMEOUT_MS });
    return null;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    return `Go compile check failed: ${shortStaticDiag(output || err.message || "unknown error")}`;
  } finally {
    rmSync(tempFile, { force: true });
  }
}

function goImportSpecs(body: string): string[] {
  const specs: string[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const single = trimmed.match(/^import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+|\.\s+|_\s+)?"([^"]+)"/);
    if (single) {
      specs.push(single[1]);
      continue;
    }
    if (/^import\s*\($/.test(trimmed)) {
      for (i++; i < lines.length; i++) {
        const inBlock = lines[i].trim();
        if (inBlock === ")") break;
        const block = inBlock.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\s+|\.\s+|_\s+)?"([^"]+)"/);
        if (block) specs.push(block[1]);
      }
    }
  }
  return specs;
}

function hasBalancedBraces(body: string): boolean {
  let depth = 0;
  let stringQuote: '"' | "'" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (stringQuote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === stringQuote) stringQuote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      stringQuote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !stringQuote && !blockComment;
}

function javaStaticIssue(body: string): string | null {
  if (!/\bimport\s+org\.junit(?:\.jupiter\.api)?\.Test\s*;/.test(body)) return "Java test is missing JUnit @Test import.";
  if (!/\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(body)) return "Java test is missing a test class.";
  if (!/@Test\b/.test(body)) return "Java test is missing an @Test method.";
  if (!/\bassert(?:True|False|Equals|NotNull|Null|Throws)\s*\(|\b(?:Assertions|Assert)\./.test(body)) {
    return "Java test is missing a JUnit assertion.";
  }
  if (!hasBalancedBraces(body)) return "Java test has unbalanced braces.";
  return null;
}

function staticFormatIssue(body: string, framework: string): string | null {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) return pythonStaticIssue(body);
  if (fw.includes("go")) return goStaticIssue(body);
  if (fw.includes("junit") || fw.includes("java")) return javaStaticIssue(body);
  if (isResolverFramework(framework) && !bodyParses(body)) return "TypeScript/JavaScript test body does not parse.";
  return null;
}

/** Framework-aware check that the body contains at least one real assertion. */
function hasAssertion(body: string, framework: string): boolean {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) return /\bassert\b/.test(body);
  if (fw.includes("go")) return /\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\bassert\./.test(body);
  if (fw.includes("junit") || fw.includes("java")) return /\bassert(?:True|False|Equals|NotNull|Null|Throws)\s*\(|\b(?:Assertions|Assert)\./.test(body);
  if (fw.includes("cypress")) return /\.should\s*\(|\bexpect\s*\(/.test(body);
  if (fw.includes("ava")) return /\bt\.(?:is|deepEqual|true|false|truthy|falsy|throws|notThrows|regex|like)\s*\(/.test(body);
  // vitest / jest / mocha / playwright and the default.
  return /\bexpect\s*\(|\bassert\b|\.should\b/.test(body);
}

/**
 * True when a bare (non-relative) specifier matches a tsconfig `paths` alias key
 * (e.g. "@/foo" matches the alias `@/*`). Such a specifier is LOCAL — it resolves
 * into the repo via path mapping — so it must be validated like a relative import,
 * not waved through as an external package.
 */
function matchesTsPathAlias(spec: string, paths: ts.MapLike<string[]> | undefined): boolean {
  if (!paths) return false;
  for (const key of Object.keys(paths)) {
    if (key === spec) return true;
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix)) return true;
  }
  return false;
}

/** The package root of a bare specifier: "lodash/fp" -> "lodash", "@scope/p/x" -> "@scope/p". */
function packageRoot(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Declared dependency names from a repo's package.json (all four dependency maps). */
export function readDeclaredDeps(root: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const map = pkg[field];
      if (map && typeof map === "object") for (const name of Object.keys(map as object)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Import specifiers in a body that WON'T LOAD from where the test will live, so the
 * test cannot honestly be called runnable. For each specifier:
 *   - relative (`./x`) or tsconfig `paths` alias (`@/x`) -> must resolve from the
 *     generated test's location;
 *   - bare package (`@scope/pkg`, `vitest`) -> must be a declared package.json
 *     dependency or a node builtin;
 *   - bare baseUrl-local import (`utils/foo`) -> allowed only when it resolves to a
 *     file inside the target repo.
 *
 * Bare packages are intentionally NOT trusted just because `resolveImport` can
 * find them from OrangePro's own workspace/node_modules; the target repo must
 * declare the dependency or the generated test cannot honestly be called runnable.
 * `declaredDeps` is the repo's package.json dependency names (computed once per run).
 */
export function unresolvedLocalImports(body: string, containingFileAbs: string, repoRootAbs: string, declaredDeps: Set<string>): string[] {
  const sf = ts.createSourceFile("__generated__.tsx", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const specs = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) specs.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (specs.size === 0) return [];
  const paths = loadTsConfigFor(containingFileAbs).options.paths;
  const unresolved: string[] = [];
  const isInsideRepo = (file: string): boolean => {
    const rel = path.relative(repoRootAbs, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  for (const spec of specs) {
    if (spec.startsWith(".") || matchesTsPathAlias(spec, paths)) {
      if (!resolveImport(spec, containingFileAbs).resolved) unresolved.push(spec);
      continue;
    }
    const resolved = resolveImport(spec, containingFileAbs);
    if (resolved.resolvedFileName && !resolved.isExternal && isInsideRepo(resolved.resolvedFileName)) continue;
    if (!declaredDeps.has(packageRoot(spec)) && !isBuiltin(spec)) unresolved.push(spec);
  }
  return unresolved;
}

/**
 * Mechanical (static, in-process) runnability: a real subject import that the
 * resolver confirms loads, a body that parses, and a real assertion. The kit never
 * EXECUTES the test — the calling agent is the runner — so this is the strongest
 * honest signal without running it. `importErrors` are unresolvable LOCAL imports
 * (relative or tsconfig-alias) already computed against the test's location. When
 * false the test ships as a grounded draft (see unresolved_reason).
 */
function isRunnable(body: string, framework: string, provenance: ImportProvenance, importErrors: string[]): boolean {
  if (!importsOk(framework, provenance)) return false;
  if (importErrors.length > 0) return false; // a local import that does not resolve = not runnable
  if (!hasExecutableContent(body, framework)) return false;
  if (!hasAssertion(body, framework)) return false;
  if (staticFormatIssue(body, framework)) return false;
  return true;
}

/** Diagnostic for a non-runnable test, most specific cause first. */
function importFixHint(importErrors: string[], declaredDeps: Set<string>): string {
  const missingPackages = importErrors.filter((spec) => !spec.startsWith(".") && !isBuiltin(spec) && !declaredDeps.has(packageRoot(spec)));
  if (missingPackages.length > 0) {
    return `Fix: regenerate using the repo's existing test framework/imports, or add ${missingPackages.map(packageRoot).join(", ")} to package.json before running.`;
  }
  return "Fix: adjust the import path or write the generated test next to the existing linked test so relative imports resolve.";
}

function runnableFailureReason(
  body: string,
  framework: string,
  provenance: ImportProvenance,
  importErrors: string[],
  declaredDeps: Set<string> = new Set()
): string {
  if (importErrors.length > 0) {
    return `Unresolved import(s) ${importErrors.join(", ")} — they do not resolve from the generated test's location. Grounded draft; no run command emitted. ${importFixHint(importErrors, declaredDeps)}`;
  }
  if (!importsOk(framework, provenance)) {
    return "No usable subject import — grounded draft, no run command emitted. Fix: add the module-under-test import or link this behavior to an existing test/source file.";
  }
  const staticIssue = staticFormatIssue(body, framework);
  if (staticIssue) {
    return `${staticIssue} Grounded draft; no run command emitted. Fix: regenerate or repair the ${framework} syntax using the repo's existing test style before running.`;
  }
  return `Test body does not parse or has no ${framework} assertion — grounded draft, no run command emitted. Fix: add a real framework assertion and rerun the static check.`;
}

function bucketForV5Scenario(scenario: PlannedScenario): LocalBucket {
  if (scenario.concern === "authorization_safety") return "security_privacy";
  if (scenario.concern === "integration_flow" || scenario.technique === "integration_chain" || scenario.technique === "data_flow_analysis") {
    return "integration_flow";
  }
  if (scenario.concern === "boundary_limits" || scenario.technique === "boundary_value_analysis") return "edge_case";
  if (scenario.concern === "failure_recovery" || scenario.technique === "rollback_recovery" || scenario.technique === "chaos_injection") return "regression";
  if (scenario.technique === "happy_path_validation") return "happy_path";
  if (scenario.technique === "contract_verification" || scenario.technique === "permission_matrix" || scenario.technique === "input_sanitization") {
    return "validation_error";
  }
  return "regression";
}

const SCENARIO_ALIGNMENT_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "not",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with"
]);

function scenarioAlignmentTokens(scenario: PlannedScenario): string[] {
  const text = [scenario.title, ...scenario.assertion_targets].join(" ").toLowerCase();
  return [...new Set(text.match(/[a-z0-9_]{3,}/g) ?? [])].filter((token) => !SCENARIO_ALIGNMENT_STOPWORDS.has(token));
}

function generatedBodyAlignsWithScenario(body: string, scenario: PlannedScenario): boolean {
  const tokens = scenarioAlignmentTokens(scenario);
  if (tokens.length === 0) return false;
  const lowered = body.toLowerCase();
  return tokens.some((token) => lowered.includes(token));
}

interface BucketPlanItem {
  behavior: GraphNode;
  bucket: LocalBucket;
  ctx: GenerationContext;
  entityIds: string[];
  sourceRefs: string[];
  weakUsed: string[];
}

/** Build the evidence corpus + structural facts used to derive bucket signals. */
function bucketEvidenceFor(
  behavior: GraphNode,
  gc: { ctx: GenerationContext; entityIds: string[]; weakUsed: string[] }
): BucketEvidence {
  const examples = asStringArray(behavior.properties.example_behaviors);
  const corpus = [
    gc.ctx.behavior_title,
    gc.ctx.description ?? "",
    ...gc.ctx.acceptance_criteria,
    ...gc.ctx.workflow_steps,
    ...gc.ctx.code_context,
    ...gc.ctx.weak_context,
    ...examples
  ]
    .join(" \n ")
    .toLowerCase();
  const hasTestableAnchor =
    gc.ctx.acceptance_criteria.length > 0 ||
    Boolean(gc.ctx.description) ||
    gc.ctx.workflow_steps.length > 0 ||
    gc.ctx.code_context.length > 0;
  const inferredFromTests =
    behavior.review_status === "inferred" || gc.weakUsed.some((w) => w.startsWith("inferred_anchor"));
  return {
    corpus,
    relatedFiles: Math.max(0, gc.entityIds.length - 1),
    workflowSteps: gc.ctx.workflow_steps.length,
    testNames: examples.length,
    hasTestableAnchor,
    inferredFromTests
  };
}

/**
 * Plan (behavior, bucket) pairs for grounded generation, capped at `limit`:
 * default/single target -> up to `limit` bucket-diverse tests for the first
 * viable target; multiple explicit targets -> split the budget (each target >=1
 * test if justified, remaining slots to the strongest bucket opportunities).
 */
function planGroundedBuckets(
  graph: LocalGraph,
  targets: GraphNode[],
  framework: string,
  fileReader: FileReader,
  limit: number,
  explicitMulti: boolean,
  missing: MissingEvidenceItem[],
  warnings: string[]
): BucketPlanItem[] {
  const viable: Array<{ behavior: GraphNode; gc: ReturnType<typeof gatherContext>; buckets: LocalBucket[] }> = [];
  const thinSeen: MissingEvidenceItem[] = [];
  for (const behavior of targets) {
    const gc = gatherContext(graph, behavior, framework, fileReader);
    const thin = tooThin(gc.ctx);
    if (thin.thin) {
      thinSeen.push({
        external_id: behavior.external_id,
        title: gc.ctx.behavior_title,
        reason: "Evidence is too thin to generate a specific, grounded test.",
        needed: thin.needed
      });
      continue;
    }
    const buckets = selectLocalBuckets(deriveBucketSignals(bucketEvidenceFor(behavior, gc)), limit);
    viable.push({ behavior, gc, buckets });
    if (!explicitMulti) break; // default/single target: focus the first viable behavior
  }
  // Default (single-focus) mode skips higher-ranked thin behaviors silently — they are
  // alternatives the caller did not target. Report them only when nothing was viable.
  // Explicit targets are always reported.
  if (viable.length === 0 || explicitMulti) missing.push(...thinSeen);
  if (viable.length === 0) return [];

  const mk = (v: (typeof viable)[number], bucket: LocalBucket): BucketPlanItem => ({
    behavior: v.behavior,
    bucket,
    ctx: v.gc.ctx,
    entityIds: v.gc.entityIds,
    sourceRefs: v.gc.sourceRefs,
    weakUsed: v.gc.weakUsed
  });

  if (!explicitMulti || viable.length === 1) {
    return viable[0].buckets.slice(0, limit).map((b) => mk(viable[0], b));
  }

  // Multiple explicit targets: each gets >=1 test (if justified), then round-robin
  // the remaining budget across targets in selection-priority order.
  const plan: BucketPlanItem[] = [];
  const used = new Set<string>();
  for (let i = 0; i < viable.length && plan.length < limit; i++) {
    const b = viable[i].buckets[0];
    if (b) {
      plan.push(mk(viable[i], b));
      used.add(`${i}:${b}`);
    }
  }
  for (let depth = 1; plan.length < limit; depth++) {
    let progressed = false;
    for (let i = 0; i < viable.length && plan.length < limit; i++) {
      const b = viable[i].buckets[depth];
      if (b && !used.has(`${i}:${b}`)) {
        plan.push(mk(viable[i], b));
        used.add(`${i}:${b}`);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const covered = new Set(plan.map((p) => p.behavior.external_id));
  const dropped = viable.filter((v) => !covered.has(v.behavior.external_id));
  if (dropped.length) {
    warnings.push(
      `Limit ${limit} is smaller than the ${viable.length} viable targets; ${dropped.length} lower-priority target(s) received no test: ${dropped.map((d) => d.behavior.external_id).join(", ")}.`
    );
  }
  return plan;
}

/** One A/B target: the behavior plus its gathered context + grounding metadata. */
export interface CompareTarget {
  behavior: GraphNode;
  ctx: GenerationContext;
  entityIds: string[];
  sourceRefs: string[];
  weakUsed: string[];
}

/**
 * Select the same target behaviors + gathered context for the A/B comparison, so
 * both arms target identical behaviors and differ ONLY in whether the KG evidence
 * is injected. Reuses the kit's target selection and context gathering.
 *
 * NOTE: opCompare no longer calls this because both arms route through generateTests.
 * Kept for local comparison helpers that need stable target/context selection.
 */
export function selectCompareTargets(
  graph: LocalGraph,
  opts: GenerateOptions,
  fileReader: FileReader
): { framework: string; items: CompareTarget[] } {
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));
  const { targets } = selectTargets(graph, opts);
  const framework = pickFramework(graph, opts, targets, fileReader);
  const filtered = targetsForFramework(graph, targets, framework).targets;
  const items = filtered.slice(0, limit).map((behavior) => ({
    behavior,
    ...gatherContext(graph, behavior, framework, fileReader)
  }));
  return { framework, items };
}

export async function generateTests(
  graph: LocalGraph,
  opts: GenerateOptions,
  provider: ModelProvider,
  fileReader: FileReader,
  clock: Clock = systemClock
): Promise<GenerateResult> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));
  const inputMode = opts.input_mode ?? "graph_grounded";
  const { targets, warnings } = selectTargets(graph, opts);
  const framework = pickFramework(graph, opts, targets, fileReader);
  const runSelection = targetsForFramework(graph, targets, framework);
  const runTargets = runSelection.targets;
  warnings.push(...runSelection.warnings);
  const systemPrompt = opts.systemPrompt ?? buildSystemPrompt();
  const promptVersion = inputMode === "graph_grounded" && opts.prompt_version === "v5" ? PROMPT_VERSION_V5 : PROMPT_VERSION;

  const created_at = clock();
  const runSeed = shortHash(created_at + provider.modelName + runTargets.map((t) => t.external_id).join(","));
  const run_id = `local-gen-${runSeed}`;

  const generated: GeneratedTest[] = [];
  const missing: MissingEvidenceItem[] = [];

  if (inputMode === "raw_prompt") {
    // Internal baseline only: broad sampling, one raw test per target (no buckets).
    // Cap ATTEMPTS (not successes): with empty completions skipped below, capping
    // on generated.length would let a systemically-empty provider run across
    // EVERY target — an unbounded spend/latency path.
    for (const behavior of runTargets.slice(0, limit)) {
      const { ctx } = gatherContext(graph, behavior, framework, fileReader);
      reportProgress(`Generating "${ctx.behavior_title}"…`);
      // One failed call must not vaporize the whole run (loops are limit-bounded,
      // so even a systemic failure costs at most `limit` warnings, never a flood).
      let completion: string;
      try {
        completion = await provider.complete({ system: systemPrompt, user: buildRawUserPrompt(ctx.behavior_title, framework) });
      } catch (e) {
        const msg = redactSecrets(e instanceof Error ? e.message : String(e));
        warnings.push(`Model call failed for "${ctx.behavior_title}": ${msg} — no test emitted.`);
        missing.push({
          external_id: behavior.external_id,
          title: ctx.behavior_title,
          reason: `Model call failed: ${msg}`,
          needed: ["a successful model completion"]
        });
        continue;
      }
      const rawBody = stripCodeFence(completion.trim());
      const sanitized = sanitizeGeneratedBody(rawBody, ctx.source_excerpts, commentPrefixForFramework(framework));
      // Same post-redaction cleanup as the grounded path: a half-redacted
      // statement must not ship as a broken baseline body either.
      let cleanBody = sanitized.body;
      if (sanitized.redactedLines > 0) {
        const fw = framework.toLowerCase();
        if (!fw.includes("pytest") && !fw.includes("go") && !fw.includes("junit") && !fw.includes("java")) {
          const stripped = stripRedactedStatements(cleanBody);
          if (stripped.dropped > 0) cleanBody = stripped.body;
        }
      }
      if (!hasExecutableContent(cleanBody, framework)) {
        warnings.push(
          `Model returned an empty completion (no executable test code) for "${ctx.behavior_title}" — no test emitted.`
        );
        missing.push({
          external_id: behavior.external_id,
          title: ctx.behavior_title,
          reason: "Model returned an empty completion (no executable test code); no test emitted.",
          needed: ["a non-empty model completion"]
        });
        continue;
      }
      const relatedFiles = relatedFilePaths(graph, behavior).files;
      let body = cleanBody;
      if (framework.toLowerCase().includes("go")) {
        body = applyGoPackage(body, firstGoPackage(relatedFiles, fileReader));
      }
      if (framework.toLowerCase().includes("junit") || framework.toLowerCase().includes("java")) {
        const licenseHeader = firstJavaLicenseHeader(relatedFiles, fileReader);
        body = applyJavaPackage(body, firstJavaPackage(relatedFiles, fileReader));
        body = applyJavaLicenseHeader(body, licenseHeader);
      }
      if (framework.toLowerCase().includes("pytest") || framework.toLowerCase().includes("python")) {
        body = applyPythonSrcLayoutImports(body, relatedFiles);
      }
      body = ensureFrameworkScaffold(body, framework);
      const staticIssue = staticFormatIssue(body, framework);
      const compileIssue = framework.toLowerCase().includes("go") ? goCompileIssue(body, graph.workspace.root, relatedFiles) : null;
      const runnable = hasAssertion(body, framework) && !staticIssue && !compileIssue;
      generated.push({
        id: `${run_id}-t${generated.length + 1}`,
        run_id,
        title: ctx.behavior_title,
        test_type: ctx.test_layer,
        framework_hint: framework,
        body,
        grounding: { entity_ids: [behavior.external_id], source_refs: [], weak_relationships_used: [] },
        weak_evidence_used: false,
        prompt_version: PROMPT_VERSION,
        runnable,
        ...(!runnable
          ? {
              unresolved_reason:
                staticIssue ?? compileIssue ?? "Test body does not have a framework assertion — comparison draft, review before running."
            }
          : {})
      });
    }
  } else if (opts.prompt_version === "v5") {
    const declaredDeps = readDeclaredDeps(graph.workspace.root);
    for (const behavior of runTargets) {
      if (generated.length >= limit) break;
      const gc = gatherContext(graph, behavior, framework, fileReader);
      reportProgress(`Planning "${gc.ctx.behavior_title}" [v5]…`);
      let scenarios: PlannedScenario[] = [];
      // Transport first: a network/timeout failure is NOT malformed JSON, so it does
      // not warrant a repair pass — fail closed and emit no test.
      let rawPlan: string;
      try {
        rawPlan = await provider.complete({
          system: opts.systemPrompt ?? buildPlanningSystemPromptV5(),
          user: buildPlanningUserPromptV5(gc.ctx),
          maxTokens: 1600,
          temperature: 0
        });
      } catch (callErr) {
        const msg = redactSecrets(callErr instanceof Error ? callErr.message : String(callErr));
        warnings.push(`V5 planning call failed for "${gc.ctx.behavior_title}": ${msg} — no test emitted.`);
        missing.push({
          external_id: behavior.external_id,
          title: gc.ctx.behavior_title,
          reason: `V5 planning call failed: ${msg}`,
          needed: ["a reachable model provider"]
        });
        continue;
      }
      try {
        const result = parsePlannedScenariosStrict(rawPlan, 20);
        scenarios = result.scenarios;
        if (result.dropped > 0) {
          warnings.push(`Dropped ${result.dropped} invalid v5 planned scenario(s) for "${gc.ctx.behavior_title}": ${result.dropSummary.join("; ")}.`);
        }
      } catch (parseErr) {
        // Malformed/unvalidated planning JSON. Make ONE transient repair call — the
        // malformed output is sent to the model but NEVER persisted, and the parse
        // error is redacted before it reaches any warning/log.
        const parseMsg = redactSecrets(parseErr instanceof Error ? parseErr.message : String(parseErr));
        // Repair only RECOVERS scenarios already present in the malformed output — it must NEVER
        // invent a fresh plan from garbage. Pre-gate on recoverable JSON-array structure; without it,
        // fail closed with no repair call ("no JSON array" / total garbage → no invented plan).
        if (!hasRepairableScenarioStructure(rawPlan)) {
          warnings.push(`V5 planning for "${gc.ctx.behavior_title}" produced no recoverable scenario array (${parseMsg}) — failing closed, no repair, no test emitted.`);
          missing.push({
            external_id: behavior.external_id,
            title: gc.ctx.behavior_title,
            reason: `V5 planning JSON had no recoverable scenario array (repair would invent): ${parseMsg}`,
            needed: ["valid JSON planned scenarios"]
          });
          continue;
        }
        try {
          const repaired = await provider.complete({
            system: buildPlanningRepairSystemPromptV5(),
            user: buildPlanningRepairUserPromptV5(rawPlan),
            maxTokens: 1600,
            temperature: 0
          });
          const result = parsePlannedScenariosStrict(repaired, 20);
          // Keep ONLY repaired scenarios that tie back to the ORIGINAL malformed text; drop any the
          // model invented. If none tie back, fail closed — never generate from an invented plan.
          const tiedBack = result.scenarios.filter((s) => scenarioTiesBackToRaw(s, rawPlan));
          const invented = result.scenarios.length - tiedBack.length;
          if (tiedBack.length === 0) {
            warnings.push(`V5 planning repair for "${gc.ctx.behavior_title}" recovered no scenario tied to the original output (${invented} invented dropped) — failing closed, no test emitted.`);
            missing.push({
              external_id: behavior.external_id,
              title: gc.ctx.behavior_title,
              reason: "V5 planning repair produced only invented scenarios not tied to the original output.",
              needed: ["valid JSON planned scenarios"]
            });
            continue;
          }
          scenarios = tiedBack;
          warnings.push(`V5 planning output for "${gc.ctx.behavior_title}" was malformed (${parseMsg}); one repair call recovered ${tiedBack.length} tied-back scenario(s)${invented ? `, dropped ${invented} not tied to the original` : ""}.`);
          if (result.dropped > 0) {
            warnings.push(`Dropped ${result.dropped} invalid v5 planned scenario(s) after repair for "${gc.ctx.behavior_title}": ${result.dropSummary.join("; ")}.`);
          }
        } catch (repairErr) {
          // Fail closed: never generate from malformed/unvalidated scenario data.
          const repairMsg = redactSecrets(repairErr instanceof Error ? repairErr.message : String(repairErr));
          warnings.push(`V5 planning failed for "${gc.ctx.behavior_title}": malformed JSON and repair failed (${repairMsg}) — no test emitted.`);
          missing.push({
            external_id: behavior.external_id,
            title: gc.ctx.behavior_title,
            reason: `V5 planning JSON was malformed and could not be repaired: ${repairMsg}`,
            needed: ["valid JSON planned scenarios"]
          });
          continue;
        }
      }
      if (scenarios.length === 0) {
        missing.push({
          external_id: behavior.external_id,
          title: gc.ctx.behavior_title,
          reason: "V5 planning returned no missing scenarios.",
          needed: ["a distinct uncovered scenario"]
        });
        continue;
      }
      const selected = scenarios.slice(0, Math.max(1, limit - generated.length));
      const completions: string[] = [];
      try {
        reportProgress(`Generating "${gc.ctx.behavior_title}" [v5 batch: ${selected.length}]…`);
        completions.push(
          await provider.complete({
            system: buildBatchGenerationSystemPromptV5(),
            user: buildBatchGenerationUserPromptV5({ ...gc.ctx, scenarios: selected })
          })
        );
      } catch (e) {
        const msg = redactSecrets(e instanceof Error ? e.message : String(e));
        warnings.push(`V5 batch generation failed for "${gc.ctx.behavior_title}": ${msg} — retrying scenarios individually.`);
        for (const scenario of selected) {
          try {
            completions.push(
              await provider.complete({
                system: buildBatchGenerationSystemPromptV5(),
                user: buildBatchGenerationUserPromptV5({ ...gc.ctx, scenarios: [scenario] })
              })
            );
          } catch (singleErr) {
            const singleMsg = redactSecrets(singleErr instanceof Error ? singleErr.message : String(singleErr));
            warnings.push(`V5 single-scenario generation failed for "${gc.ctx.behavior_title}" / "${scenario.title}": ${singleMsg}.`);
          }
        }
      }
      const scenarioById = new Map(selected.map((s) => [s.id, s]));
      const parsed = completions.flatMap(parseBatchGeneratedTests);
      const seenScenarioIds = new Set<number>();
      const relatedFiles = relatedFilePaths(graph, behavior).files;
      for (let i = 0; i < parsed.length && generated.length < limit; i++) {
        const parsedTest = parsed[i];
        let scenario: PlannedScenario | undefined;
        if (parsedTest.scenario_id === null) {
          if (selected.length === 1) {
            scenario = selected[0];
          } else {
            warnings.push(`Dropped v5 generated test for "${gc.ctx.behavior_title}": missing scenario delimiter/id in multi-scenario output.`);
            continue;
          }
        } else {
          scenario = scenarioById.get(parsedTest.scenario_id);
          if (!scenario) {
            warnings.push(`Dropped v5 generated test for "${gc.ctx.behavior_title}": unknown scenario id ${parsedTest.scenario_id}.`);
            continue;
          }
          if (seenScenarioIds.has(parsedTest.scenario_id)) {
            warnings.push(`Dropped duplicate v5 generated test for "${gc.ctx.behavior_title}" / scenario ${parsedTest.scenario_id}.`);
            continue;
          }
          seenScenarioIds.add(parsedTest.scenario_id);
        }
        if (!scenario) continue;
        const rawBody = stripCodeFence(parsedTest.body);
        const sanitized = sanitizeGeneratedBody(rawBody, gc.ctx.source_excerpts, commentPrefixForFramework(framework));
        if (sanitized.redactedLines > 0) {
          warnings.push(`Redacted ${sanitized.redactedLines} echoed source-excerpt line(s) from the v5 generated test for "${gc.ctx.behavior_title}".`);
        }
        if (!hasExecutableContent(sanitized.body, framework)) {
          warnings.push(`Dropped v5 generated test for "${gc.ctx.behavior_title}" / "${scenario.title}": no executable test code.`);
          missing.push({
            external_id: behavior.external_id,
            title: gc.ctx.behavior_title,
            reason: `V5 generated no executable code for scenario "${scenario.title}".`,
            needed: ["a non-empty runnable test body"]
          });
          continue;
        }
        if (!generatedBodyAlignsWithScenario(sanitized.body, scenario)) {
          warnings.push(`Dropped v5 generated test for "${gc.ctx.behavior_title}" / "${scenario.title}": body did not reference the planned assertion target.`);
          missing.push({
            external_id: behavior.external_id,
            title: gc.ctx.behavior_title,
            reason: `V5 generated test did not align with scenario "${scenario.title}".`,
            needed: ["a generated test body that asserts the planned scenario target"]
          });
          continue;
        }
        let cleanBody = sanitized.body;
        if (sanitized.redactedLines > 0) {
          const fw = framework.toLowerCase();
          if (!fw.includes("pytest") && !fw.includes("go")) {
            const stripped = stripRedactedStatements(cleanBody);
            if (stripped.dropped > 0) cleanBody = stripped.body;
          }
        }
        if (framework.toLowerCase().includes("go")) {
          cleanBody = applyGoPackage(cleanBody, firstGoPackage(relatedFiles, fileReader));
        }
        if (framework.toLowerCase().includes("junit") || framework.toLowerCase().includes("java")) {
          cleanBody = applyJavaPackage(cleanBody, firstJavaPackage(relatedFiles, fileReader));
          cleanBody = applyJavaLicenseHeader(cleanBody, firstJavaLicenseHeader(relatedFiles, fileReader));
        }
        if (framework.toLowerCase().includes("pytest") || framework.toLowerCase().includes("python")) {
          cleanBody = applyPythonSrcLayoutImports(cleanBody, relatedFiles);
        }
        cleanBody = ensureFrameworkScaffold(cleanBody, framework);
        const linkedTest = gc.sourceRefs.find((r) => TEST_REF_RE.test(r)) ?? "";
        const testDir = linkedTest ? (linkedTest.includes("/") ? linkedTest.slice(0, linkedTest.lastIndexOf("/")) : ".") : GENERATED_DIR;
        const genTestRel = testDir === "." ? "__generated__.test.ts" : `${testDir}/__generated__.test.ts`;
        const genTestAbs = path.join(graph.workspace.root, genTestRel);
        let body: string;
        let import_provenance: ImportProvenance;
        let unresolved_reason: string | undefined;
        if (BODY_HAS_IMPORTS_RE.test(cleanBody)) {
          body = cleanBody;
          import_provenance = "model_provided";
        } else if (gc.ctx.subject_imports.length) {
          body = synthesizeImports(framework, gc.ctx.subject_imports).join("\n") + "\n\n" + cleanBody;
          import_provenance = "test_metadata";
        } else {
          const derived = deriveSubjectImport(graph, behavior, relatedFiles, genTestRel, framework);
          if (derived) {
            body = [frameworkImport(framework), derived.line, "", cleanBody].join("\n");
            import_provenance = "resolver_relative";
          } else {
            body = cleanBody;
            import_provenance = "none";
            unresolved_reason = isResolverFramework(framework)
              ? "No subject import could be derived without guessing; v5 output dropped from proof-ready set."
              : undefined;
          }
        }
        const importErrors = isResolverFramework(framework) ? unresolvedLocalImports(body, genTestAbs, graph.workspace.root, declaredDeps) : [];
        const compileIssue = framework.toLowerCase().includes("go") ? goCompileIssue(body, graph.workspace.root, relatedFiles) : null;
        const runnable = isRunnable(body, framework, import_provenance, importErrors) && !compileIssue;
        if (!runnable) {
          const reason = unresolved_reason ?? compileIssue ?? runnableFailureReason(body, framework, import_provenance, importErrors, declaredDeps);
          warnings.push(`Non-runnable v5 generated test for "${gc.ctx.behavior_title}" / "${scenario.title}" kept as an English intent (no run command): ${reason}`);
          missing.push({
            external_id: behavior.external_id,
            title: gc.ctx.behavior_title,
            reason,
            needed: ["a compiling generated test with a real assertion and resolvable subject import"]
          });
          // Preserve the grounded INTENT in English, never the rejected code.
          // The scenario fields were authored by a model that saw source
          // excerpts — scrub the composed body with the same guard as code.
          // The scenario plan (title / assertion targets / rationale) is the
          // reviewable half of the draft; withholding the body entirely also
          // removes any residual source-echo risk. runnable:false + the reason
          // keep this honestly a draft — it ships with no run command and can
          // never enter the proof-ready set.
          const manualBody = sanitizeGeneratedBody([
              `Scenario: ${scenario.title}`,
              ...(scenario.steps && scenario.steps.length
                ? ["Steps:", ...scenario.steps.map((st, n) => `  ${n + 1}. ${st}`)]
                : []),
              ...(scenario.test_data ? [`Test data: ${scenario.test_data}`] : []),
              ...(scenario.assertion_targets.length ? [`Expected: ${scenario.assertion_targets.join("; ")}`] : []),
              ...(scenario.rationale ? [`Why this test: ${scenario.rationale}`] : []),
              "",
              // Concise blocker: first clause only — the full remedy is one line.
              `Blocked by: ${reason.split(" — ")[0]}`,
              "Fix: install this repo's dependencies / configure the test runner, then re-run \`opro start\`."
            ].join("\n"), gc.ctx.source_excerpts, "//").body;
          generated.push({
            id: `${run_id}-t${generated.length + 1}`,
            run_id,
            title: `${gc.ctx.behavior_title} — ${scenario.title}`,
            test_type: gc.ctx.test_layer,
            framework_hint: framework,
            body: manualBody,
            bucket: bucketForV5Scenario(scenario),
            prompt_version: PROMPT_VERSION_V5,
            grounding: { entity_ids: gc.entityIds, source_refs: [], weak_relationships_used: [] },
            weak_evidence_used: false,
            target_symbol_external_id: behavior.external_id,
            runnable: false,
            unresolved_reason: reason
          });
          continue;
        }
        generated.push({
          id: `${run_id}-t${generated.length + 1}`,
          run_id,
          title: `${gc.ctx.behavior_title} — ${scenario.title}`,
          test_type: gc.ctx.test_layer,
          framework_hint: framework,
          body,
          bucket: bucketForV5Scenario(scenario),
          prompt_version: PROMPT_VERSION_V5,
          grounding: {
            entity_ids: gc.entityIds,
            source_refs: dedupe(gc.sourceRefs),
            weak_relationships_used: gc.weakUsed,
            import_provenance
          },
          weak_evidence_used: gc.weakUsed.length > 0,
          ...(behavior.kind === "CodeSymbol" ? { target_symbol_external_id: behavior.external_id } : {}),
          runnable: true
        });
      }
    }
  } else {
    // Default: target-focused, bucket-diverse generation (one test per local bucket).
    const explicitMulti = Boolean(opts.target_ids && opts.target_ids.length > 1);
    const plan = planGroundedBuckets(graph, runTargets, framework, fileReader, limit, explicitMulti, missing, warnings);
    // Repo dependency names (read once) — used by the runnable check to tell a missing
    // baseUrl-local import from a genuine external package the agent has installed.
    const declaredDeps = readDeclaredDeps(graph.workspace.root);
    for (const item of plan) {
      if (generated.length >= limit) break;
      reportProgress(`Generating "${item.ctx.behavior_title}" [${BUCKET_LABEL[item.bucket]}]…`);
      // One failed call (timeout, transient HTTP) must not vaporize the run:
      // disclose, skip this bucket, and keep the completed work. The plan is
      // limit-bounded, so a systemic failure costs at most `limit` warnings.
      let completion: string;
      try {
        completion = await provider.complete({ system: systemPrompt, user: buildGroundedUserPrompt(item.ctx, item.bucket) });
      } catch (e) {
        const msg = redactSecrets(e instanceof Error ? e.message : String(e));
        warnings.push(
          `Model call failed for "${item.ctx.behavior_title}" [${BUCKET_LABEL[item.bucket]}]: ${msg} — no test emitted.`
        );
        missing.push({
          external_id: item.behavior.external_id,
          title: item.ctx.behavior_title,
          reason: `Model call failed for the ${BUCKET_LABEL[item.bucket]} bucket: ${msg}`,
          needed: ["a successful model completion"]
        });
        continue;
      }
      const rawBody = stripCodeFence(completion.trim());
      const sanitized = sanitizeGeneratedBody(rawBody, item.ctx.source_excerpts, commentPrefixForFramework(framework));
      // The privacy disclosure comes FIRST, before any skip: a redaction event
      // must show in the audit trail even when the redaction empties the body.
      if (sanitized.redactedLines > 0) {
        warnings.push(
          `Redacted ${sanitized.redactedLines} echoed source-excerpt line(s) from the generated test for "${item.ctx.behavior_title}".`
        );
      }
      // NEVER package an empty completion as a test: an empty body with
      // synthesized imports reads as a generated test (and run_hints would tell
      // an agent to run it) while proving nothing. Skip + disclose instead —
      // attributing redaction-emptied bodies to redaction, not token starvation.
      if (!hasExecutableContent(sanitized.body, framework)) {
        if (sanitized.redactedLines > 0) {
          warnings.push(
            `Redaction removed all executable content for "${item.ctx.behavior_title}" [${BUCKET_LABEL[item.bucket]}] — no test emitted.`
          );
          missing.push({
            external_id: item.behavior.external_id,
            title: item.ctx.behavior_title,
            reason: `Redaction removed all executable content from the ${BUCKET_LABEL[item.bucket]} completion; no test emitted.`,
            needed: ["a completion that does not echo source excerpts"]
          });
        } else {
          warnings.push(
            `Model returned an empty completion (no executable test code) for "${item.ctx.behavior_title}" [${BUCKET_LABEL[item.bucket]}] — no test emitted. ` +
              `Reasoning models can exhaust their token budget on long grounded prompts; retry, or try another model.`
          );
          missing.push({
            external_id: item.behavior.external_id,
            title: item.ctx.behavior_title,
            reason: `Model returned an empty completion (no executable test code) for the ${BUCKET_LABEL[item.bucket]} bucket; no test emitted.`,
            needed: ["a non-empty model completion"]
          });
        }
        continue;
      }
      let cleanBody = sanitized.body;
      if (sanitized.redactedLines > 0) {
        const fw = framework.toLowerCase();
        if (!fw.includes("pytest") && !fw.includes("go")) {
          const stripped = stripRedactedStatements(cleanBody);
          if (stripped.dropped > 0) {
            cleanBody = stripped.body;
            warnings.push(
              `Removed ${stripped.dropped} statement(s) left broken by redaction in "${item.ctx.behavior_title}" — the emitted test stays parseable.`
            );
          }
        }
        if (!hasExecutableContent(cleanBody, framework)) {
          warnings.push(
            `Redaction removed all executable content for "${item.ctx.behavior_title}" [${BUCKET_LABEL[item.bucket]}] — no test emitted.`
          );
          missing.push({
            external_id: item.behavior.external_id,
            title: item.ctx.behavior_title,
            reason: `Redaction removed all executable content from the ${BUCKET_LABEL[item.bucket]} completion; no test emitted.`,
            needed: ["a completion that does not echo source excerpts"]
          });
          continue;
        }
      }
      const relatedFiles = relatedFilePaths(graph, item.behavior).files;
      if (framework.toLowerCase().includes("go")) {
        cleanBody = applyGoPackage(cleanBody, firstGoPackage(relatedFiles, fileReader));
      }
      if (framework.toLowerCase().includes("junit") || framework.toLowerCase().includes("java")) {
        const licenseHeader = firstJavaLicenseHeader([...item.sourceRefs, ...relatedFiles], fileReader);
        cleanBody = applyJavaPackage(cleanBody, firstJavaPackage(relatedFiles, fileReader));
        cleanBody = applyJavaLicenseHeader(cleanBody, licenseHeader);
      }
      if (framework.toLowerCase().includes("pytest") || framework.toLowerCase().includes("python")) {
        cleanBody = applyPythonSrcLayoutImports(cleanBody, relatedFiles);
      }
      cleanBody = ensureFrameworkScaffold(cleanBody, framework);
      // Where this generated test will LIVE drives both the relative-import
      // resolution context and the run-hint path: next to its linked existing test
      // when one is known, else the repo-root orangepro_generated/ dir.
      const linkedTest = item.sourceRefs.find((r) => TEST_REF_RE.test(r)) ?? "";
      const testDir = linkedTest ? (linkedTest.includes("/") ? linkedTest.slice(0, linkedTest.lastIndexOf("/")) : ".") : GENERATED_DIR;
      const genTestRel = testDir === "." ? "__generated__.test.ts" : `${testDir}/__generated__.test.ts`;
      const genTestAbs = path.join(graph.workspace.root, genTestRel);

      // Resolve the SUBJECT import + its provenance. The kit NEVER fabricates a
      // module specifier: when the model wrote no imports and none can be
      // resolver-derived, the test ships as a non-runnable grounded draft.
      let body: string;
      let import_provenance: ImportProvenance;
      let unresolved_reason: string | undefined;
      if (BODY_HAS_IMPORTS_RE.test(cleanBody)) {
        // The model wrote its own imports (the prompt demands complete imports);
        // prepending ours would duplicate declarations and break the single file.
        // These are NOT trusted blindly — their relative specifiers are resolver-
        // validated below, so a model-written `./missing` cannot ride as runnable.
        body = cleanBody;
        import_provenance = "model_provided";
      } else if (item.ctx.subject_imports.length) {
        // Reuse the linked existing test's real imports (the repo proves they resolve).
        body = synthesizeImports(framework, item.ctx.subject_imports).join("\n") + "\n\n" + cleanBody;
        import_provenance = "test_metadata";
      } else {
        // No model imports and no linked-test imports → derive a RESOLVER-VALIDATED
        // import from the import graph, or emit a grounded draft rather than guess.
        const derived = deriveSubjectImport(graph, item.behavior, relatedFiles, genTestRel, framework);
        if (derived) {
          body = [frameworkImport(framework), derived.line, "", cleanBody].join("\n");
          import_provenance = "resolver_relative";
        } else {
          body = cleanBody;
          import_provenance = "none";
          unresolved_reason = isResolverFramework(framework)
            ? "No subject import could be derived without guessing (no linked source file with a validated export). " +
              "Grounded draft — add the import for the module under test before running."
            : undefined;
        }
      }
      // Mechanical runnability — including validating that EVERY local import in the
      // final body (relative OR tsconfig-alias; model-written or kit-added) resolves
      // from where the test will live. A test whose own import won't load is never
      // marked runnable.
      const importErrors = isResolverFramework(framework) ? unresolvedLocalImports(body, genTestAbs, graph.workspace.root, declaredDeps) : [];
      const compileIssue = framework.toLowerCase().includes("go") ? goCompileIssue(body, graph.workspace.root, relatedFiles) : null;
      const runnable = isRunnable(body, framework, import_provenance, importErrors) && !compileIssue;
      if (!runnable && !unresolved_reason) {
        unresolved_reason = compileIssue ?? runnableFailureReason(body, framework, import_provenance, importErrors, declaredDeps);
      }
      generated.push({
        id: `${run_id}-t${generated.length + 1}`,
        run_id,
        title: `${item.ctx.behavior_title} — ${BUCKET_LABEL[item.bucket]}`,
        test_type: item.ctx.test_layer,
        framework_hint: framework,
        body,
        bucket: item.bucket,
        prompt_version: PROMPT_VERSION,
        grounding: {
          entity_ids: item.entityIds,
          source_refs: dedupe(item.sourceRefs),
          weak_relationships_used: item.weakUsed,
          import_provenance
        },
        weak_evidence_used: item.weakUsed.length > 0,
        ...(item.behavior.kind === "CodeSymbol" ? { target_symbol_external_id: item.behavior.external_id } : {}),
        runnable,
        ...(unresolved_reason ? { unresolved_reason } : {})
      });
    }
  }

  if (targets.length === 0) {
    warnings.push("No behavior anchors available to target. Add requirements/templates or analyze a path with tests.");
  }

  const run: GenerationRun | null = generated.length
    ? {
        run_id,
        model_provider: provider.providerName,
        model_name: provider.modelName,
        input_mode: inputMode,
        prompt_version: promptVersion,
        created_at,
        generated_test_ids: generated.map((t) => t.id)
      }
    : null;

  return { run, generated_tests: generated, missing_evidence: missing, warnings };
}
