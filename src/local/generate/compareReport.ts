/**
 * A/B comparison artifacts for `generate` (compare mode), written fresh to the
 * local workspace on every run. Local testing artifacts — never the evidence
 * pack, never uploaded.
 *
 * Outputs:
 *  - four per-arm test files so a tester can run + compare each arm: runnable
 *    framework code (`.local-kg.<ext>` / `.baseline.<ext>`) and beautified
 *    structured cases (`.local-kg.json` / `.baseline.json`) — the durable
 *    artifacts that remain after A/B testing;
 *  - a slim Markdown report: the scores, the matrix, and links to those files
 *    (no full body dumps).
 */
import ts from "typescript";
import type { GenerateComparison } from "../operations.js";
import { BUCKET_LABEL } from "./buckets.js";

type ArmTests = GenerateComparison["baseline"]["generated_tests"];

const REDACTION_MARKER = "[orangepro: source excerpt redacted]";
const normHeader = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const LEAKED_HEADERS = new Set(Object.values(BUCKET_LABEL).map(normHeader));

/**
 * Tidy a model-generated body for the draft test file: drop our own
 * source-excerpt redaction placeholders (the source is already gone — the marker
 * is just a comment) and standalone scenario/bucket headers the model echoed from
 * the prompt (e.g. a bare "HAPPY PATH" line that is not real code). A tidy, not a
 * rewrite: real code is left untouched, so the body stays a faithful draft.
 */
export function cleanDraftTestBody(body: string): string {
  const out: string[] = [];
  let blanks = 0;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t.includes(REDACTION_MARKER)) continue;
    const label = t.replace(/^[#/*\s]+/, "").replace(/[:*\s]+$/, "");
    if (label && LEAKED_HEADERS.has(normHeader(label))) continue;
    if (t === "") {
      if (++blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Pick a sensible file extension for the generated test cases from the framework. */
/** True when a body contains real JSX (TS-AST walk — generics never false-positive). */
export function bodyHasJsx(body: string): boolean {
  const sf = ts.createSourceFile("b.tsx", body || "", ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      n.kind === ts.SyntaxKind.JsxElement ||
      n.kind === ts.SyntaxKind.JsxSelfClosingElement ||
      n.kind === ts.SyntaxKind.JsxFragment
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

export function testsFileExt(framework: string, bodies: string[] = []): string {
  const f = (framework || "").toLowerCase();
  // JSX inside a .ts file is a TypeScript error — emit .tsx when any body carries JSX.
  const x = bodies.some(bodyHasJsx) ? "x" : "";
  if (f.includes("playwright")) return "spec.ts" + x;
  if (f.includes("cypress")) return "cy.ts" + x;
  if (f.includes("vitest")) return "test.ts" + x;
  if (f.includes("jest")) return "test.ts" + x;
  if (f.includes("ava")) return "test.js";
  if (f.includes("pytest") || f.includes("python")) return "py";
  if (f.includes("go")) return "go";
  if (f.includes("junit") || f.includes("java")) return "java";
  return "test.txt";
}

export function testsArtifactName(prefix: string, ext: string): string {
  return ext === "go" ? `${prefix}_test.go` : `${prefix}.${ext}`;
}

/** Framework shared by a run's generated tests (grounded arm preferred). */
export function compareTestsFramework(cmp: GenerateComparison): string {
  const first = cmp.grounded.generated_tests[0] ?? cmp.baseline.generated_tests[0];
  return first?.framework_hint ?? "generic";
}

/** Every non-empty generated body across both arms (grounded first). */
function allBodies(cmp: GenerateComparison): string[] {
  return [...cmp.grounded.generated_tests, ...cmp.baseline.generated_tests]
    .map((t) => t.body?.trim() ?? "")
    .filter(Boolean);
}

/** Whether a body is JSON test-cases — tolerant of a leading or prose-wrapped ```json fence. */
export function looksJson(body: string): boolean {
  const t = body.replace(/^```(?:json)?\s*/i, "").trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return true;
  return /```json/i.test(body); // prose-wrapped JSON (loose model output)
}

/**
 * File extension for the test-cases file. Some comparison outputs are JSON
 * test-case specs (`.testcases.json`); detect that (and legacy XML) before falling back
 * to the framework extension for single-call runnable drafts. Scans ALL bodies in
 * both arms so an empty grounded[0] never hides a JSON/XML body elsewhere.
 */
export function compareTestsExt(cmp: GenerateComparison): string {
  const bodies = allBodies(cmp);
  if (bodies.some((b) => b.startsWith("<"))) return "testcases.xml";
  if (bodies.some((b) => looksJson(b))) return "testcases.json";
  return testsFileExt(compareTestsFramework(cmp), bodies);
}

type CompareArm = "grounded" | "baseline";

/**
 * Partition a TS/JS test body into its import statements and the rest, via a
 * parse-only `ts.createSourceFile` pass (handles multi-line imports a regex
 * cannot). Used to HOIST + de-duplicate imports when several per-test bodies
 * are concatenated into one file — duplicate import declarations are invalid TS
 * and made the combined artifact unreadable/unrunnable.
 */
function partitionImports(body: string): { imports: string[]; rest: string } {
  const sf = ts.createSourceFile("arm.tsx", body, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX);
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      ranges.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: stmt.getText(sf).trim() });
    }
  }
  if (!ranges.length) return { imports: [], rest: body.trim() };
  let rest = body;
  for (let i = ranges.length - 1; i >= 0; i--) rest = rest.slice(0, ranges[i].start) + rest.slice(ranges[i].end);
  rest = rest
    .split(/\r?\n/)
    .filter((l) => !l.includes("Imports reconstructed by OrangePro") && !l.includes("Imports synthesized by OrangePro"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { imports: ranges.map((r) => r.text), rest };
}

function partitionGoTestBody(body: string): { packageName: string | null; imports: string[]; rest: string } {
  const imports: string[] = [];
  const rest: string[] = [];
  let packageName: string | null = null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const pkg = trimmed.match(/^package\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (pkg) {
      packageName ??= pkg[1];
      continue;
    }
    const singleImport = trimmed.match(/^import\s+(.+)$/);
    if (singleImport && singleImport[1].trim() !== "(") {
      imports.push(singleImport[1].trim());
      continue;
    }
    if (/^import\s*\($/.test(trimmed)) {
      for (i++; i < lines.length; i++) {
        const importLine = lines[i].trim();
        if (importLine === ")") break;
        if (importLine && !importLine.startsWith("//")) imports.push(importLine);
      }
      continue;
    }
    rest.push(line);
  }
  return { packageName, imports, rest: rest.join("\n").trim() };
}

function renderGoImportBlock(imports: string[]): string[] {
  const unique = [...new Set(imports.map((i) => i.trim()).filter(Boolean))].sort();
  if (!unique.length) return [];
  if (unique.length === 1) return [`import ${unique[0]}`];
  return ["import (", ...unique.map((i) => `\t${i}`), ")"];
}

function partitionJavaTestBody(body: string): { packageName: string | null; imports: string[]; rest: string } {
  const imports: string[] = [];
  const rest: string[] = [];
  let packageName: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    const pkg = trimmed.match(/^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/);
    if (pkg) {
      packageName ??= pkg[1];
      continue;
    }
    if (/^import\s+/.test(trimmed)) {
      imports.push(trimmed);
      continue;
    }
    rest.push(line);
  }
  return { packageName, imports, rest: rest.join("\n").trim() };
}

/**
 * Full binding identity per LOCAL name declared by one import statement:
 * local → "<imported>@<module>", where <imported> is the exported symbol
 * (propertyName for aliases), "default" for default imports, and "*" for
 * namespace imports. Two imports are interchangeable only when identities
 * match — same local + same module is NOT enough (`saveCard as subject` and
 * `deleteCard as subject` are different bindings, as are default/namespace
 * vs named imports of the same local name).
 */
function importBindingIdentities(importText: string): Map<string, string> {
  const out = new Map<string, string>();
  const sf = ts.createSourceFile("imp.ts", importText, ts.ScriptTarget.Latest, /*setParentNodes*/ false);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const mod = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
    const clause = stmt.importClause;
    if (clause.name) out.set(clause.name.text, `default@${mod}`);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.set(nb.name.text, `*@${mod}`);
    else if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) out.set(el.name.text, `${(el.propertyName ?? el.name).text}@${mod}`);
    }
  }
  return out;
}

/**
 * Render ONE arm's generated tests into its own runnable framework-code file.
 * Local KG (graph-grounded) is the keep-arm; the prompt-only baseline is for
 * comparison only. Bodies are the model's raw output (drafts, not guaranteed
 * runnable), tidied of redaction placeholders and leaked headers — a tidy, not a
 * rewrite. Comment style follows the file extension (JS/TS `//` vs Python `#`).
 */
export function renderArmTestsFile(cmp: GenerateComparison, arm: CompareArm, createdAt: string): string {
  const fw = compareTestsFramework(cmp);
  const ext = testsFileExt(fw);
  const cmt = (line: string): string => `${ext === "py" ? "#" : "//"} ${line}`;
  const bar = cmt("=".repeat(70));
  const tests = cmp[arm].generated_tests;
  const isKeep = arm === "grounded";
  const lines: string[] = [];
  lines.push(cmt(`OrangePro Local — A/B generated tests (${isKeep ? "Local KG / graph-grounded" : "prompt-only baseline"}, ${fw})`));
  lines.push(cmt(`Generated ${createdAt} via ${cmp.model_provider}/${cmp.model_name}.`));
  if (isKeep) {
    lines.push(cmt("Local KG arm — KEEP these. Runnable framework code: write each test to its own"));
    lines.push(cmt("file (see run hints in the report) and run it with your repo's test command."));
  } else {
    lines.push(cmt("Prompt-only baseline arm — COMPARISON ONLY. Generated without the Local KG; kept"));
    lines.push(cmt("so you can run both arms side by side. Do not commit these."));
  }
  lines.push("");
  lines.push(bar);
  lines.push(cmt(isKeep ? "Local KG (graph-grounded) — keep these" : "Prompt-only baseline — comparison only; delete before committing"));
  lines.push(bar);
  lines.push("");
  if (!tests.length) {
    lines.push(cmt("(no tests generated)"));
    return lines.join("\n") + "\n";
  }
  if (ext === "go") {
    const partitionedGo = tests.map((t) => partitionGoTestBody(cleanDraftTestBody(t.body)));
    const packages = [...new Set(partitionedGo.map((p) => p.packageName).filter((p): p is string => Boolean(p)))].sort();
    const packageName = packages[0] ?? "main";
    const packageMismatch = packages.length > 1;
    lines.push(`package ${packageName}`);
    lines.push("");
    lines.push(...renderGoImportBlock(partitionedGo.flatMap((p) => p.imports)));
    lines.push("");
    tests.forEach((t, i) => {
      lines.push(bar);
      lines.push(cmt(`TEST ${i + 1}/${tests.length}: ${t.title}  [${t.test_type}/${t.framework_hint}]${t.bucket ? ` {${t.bucket}}` : ""}`));
      lines.push(bar);
      if (t.grounding.entity_ids.length) lines.push(cmt(`grounded by: ${t.grounding.entity_ids.join(", ")}`));
      if (t.grounding.source_refs.length) lines.push(cmt(`source refs: ${t.grounding.source_refs.join(", ")}`));
      if (t.weak_evidence_used) lines.push(cmt("uses weak/candidate evidence — verify before trusting"));
      if (packageMismatch && partitionedGo[i].packageName && partitionedGo[i].packageName !== packageName) {
        lines.push(cmt(`MANUAL SPLIT REQUIRED — this test belongs to package ${partitionedGo[i].packageName}.`));
        lines.push(cmt("Write it to its own _test.go file using the run hint instead of this combined file."));
      }
      lines.push("");
      lines.push(partitionedGo[i].rest);
      lines.push("");
    });
    return lines.join("\n") + "\n";
  }
  if (ext === "java") {
    const partitionedJava = tests.map((t) => partitionJavaTestBody(cleanDraftTestBody(t.body)));
    const packages = [...new Set(partitionedJava.map((p) => p.packageName).filter((p): p is string => Boolean(p)))].sort();
    const packageName = packages[0];
    const packageMismatch = packages.length > 1;
    if (packageName) {
      lines.push(`package ${packageName};`);
      lines.push("");
    }
    const imports = [...new Set(partitionedJava.flatMap((p) => p.imports))].sort();
    if (imports.length) {
      lines.push(...imports);
      lines.push("");
    }
    tests.forEach((t, i) => {
      lines.push(bar);
      lines.push(cmt(`TEST ${i + 1}/${tests.length}: ${t.title}  [${t.test_type}/${t.framework_hint}]${t.bucket ? ` {${t.bucket}}` : ""}`));
      lines.push(bar);
      if (t.grounding.entity_ids.length) lines.push(cmt(`grounded by: ${t.grounding.entity_ids.join(", ")}`));
      if (t.grounding.source_refs.length) lines.push(cmt(`source refs: ${t.grounding.source_refs.join(", ")}`));
      if (t.weak_evidence_used) lines.push(cmt("uses weak/candidate evidence — verify before trusting"));
      if (packageMismatch && partitionedJava[i].packageName && partitionedJava[i].packageName !== packageName) {
        lines.push(cmt(`MANUAL SPLIT REQUIRED — this test belongs to package ${partitionedJava[i].packageName}.`));
        lines.push(cmt("Write it to its own Java file using the run hint instead of this combined file."));
      }
      lines.push("");
      lines.push(partitionedJava[i].rest);
      lines.push("");
    });
    return lines.join("\n") + "\n";
  }
  // TS/JS: hoist + de-duplicate imports across the concatenated test bodies so
  // the combined file is one valid module instead of N duplicate import blocks.
  const isCode = ext !== "py" && ext !== "go" && !ext.startsWith("testcases");
  const partitioned = tests.map((t) =>
    isCode ? partitionImports(cleanDraftTestBody(t.body)) : { imports: [], rest: cleanDraftTestBody(t.body) }
  );
  // De-duplicate on whitespace-NORMALIZED text plus parsed binding identity —
  // the same import re-emitted with different spacing OR token layout must not
  // survive as a duplicate declaration. An import whose LOCAL names collide
  // with one already hoisted cannot live in this combined file at all: hoisting
  // it is invalid TS, and silently dropping it would make its test run against
  // the earlier binding. Keep it with its own test below as a commented
  // "manual split required" block — and REPEAT the warning for every later test
  // that carries the same conflicting line (a dedupe hit on a conflicted line is
  // still a conflict for that test, not a resolved duplicate).
  const hoisted: string[] = [];
  const seenNormalized = new Set<string>();
  const conflictNormalized = new Set<string>();
  const boundIdentityByLocal = new Map<string, string>();
  const conflicts: string[][] = partitioned.map(() => []);
  partitioned.forEach((part, i) => {
    for (const imp of part.imports) {
      const normalized = imp.replace(/\s+/g, " ").trim();
      if (seenNormalized.has(normalized)) {
        if (conflictNormalized.has(normalized)) conflicts[i].push(normalized);
        continue;
      }
      seenNormalized.add(normalized);
      const bindings = importBindingIdentities(imp);
      const locals = [...bindings.keys()];
      const colliding = locals.filter((n) => boundIdentityByLocal.has(n));
      if (colliding.length) {
        // A duplicate (not a conflict) ONLY when every local resolves to the
        // identical binding — same module AND same imported symbol/form — and
        // the line adds nothing new. `saveCard as subject` vs `deleteCard as
        // subject` from one module must NOT pass as a duplicate.
        const sameBindingDup =
          colliding.length === locals.length && colliding.every((n) => boundIdentityByLocal.get(n) === bindings.get(n));
        if (!sameBindingDup) {
          conflicts[i].push(normalized);
          conflictNormalized.add(normalized);
        }
        continue;
      }
      for (const [n, id] of bindings) boundIdentityByLocal.set(n, id);
      hoisted.push(imp);
    }
  });
  if (hoisted.length) {
    lines.push(cmt("Imports — hoisted and de-duplicated across the tests below:"));
    lines.push(...hoisted);
    lines.push("");
  }
  tests.forEach((t, i) => {
    lines.push(bar);
    lines.push(cmt(`TEST ${i + 1}/${tests.length}: ${t.title}  [${t.test_type}/${t.framework_hint}]${t.bucket ? ` {${t.bucket}}` : ""}`));
    lines.push(bar);
    if (t.grounding.entity_ids.length) lines.push(cmt(`grounded by: ${t.grounding.entity_ids.join(", ")}`));
    if (t.grounding.source_refs.length) lines.push(cmt(`source refs: ${t.grounding.source_refs.join(", ")}`));
    if (t.weak_evidence_used) lines.push(cmt("uses weak/candidate evidence — verify before trusting"));
    if (conflicts[i].length) {
      lines.push(cmt("⚠ MANUAL SPLIT REQUIRED — this test's import(s) collide with name(s) already"));
      lines.push(cmt("bound earlier in this combined file and could not be hoisted. Below, those"));
      lines.push(cmt("names may resolve to a different binding than this test intends (or stay"));
      lines.push(cmt("unbound). Move this test to its own file with its own imports:"));
      for (const c of conflicts[i]) lines.push(cmt(`  ${c}`));
    }
    lines.push("");
    lines.push(partitioned[i].rest);
    lines.push("");
  });
  return lines.join("\n") + "\n";
}

/** One valid pretty-printed JSON document with ONE arm's structured test cases + grounding. */
export function renderArmTestsJson(cmp: GenerateComparison, arm: CompareArm, createdAt: string): string {
  const tests = cmp[arm].generated_tests.map((t) => ({
    title: t.title,
    bucket: t.bucket,
    test_type: t.test_type,
    framework: t.framework_hint,
    grounding: {
      entity_ids: t.grounding.entity_ids,
      source_refs: t.grounding.source_refs,
      weak_relationships_used: t.grounding.weak_relationships_used
    },
    weak_evidence_used: t.weak_evidence_used,
    test_code: t.body
  }));
  return (
    JSON.stringify(
      {
        generated_at: createdAt,
        model: `${cmp.model_provider}/${cmp.model_name}`,
        arm: arm === "grounded" ? "local_kg" : "prompt_only_baseline",
        count: tests.length,
        tests
      },
      null,
      2
    ) + "\n"
  );
}

/** Per-arm output file basenames the report links to. */
export interface CompareTestFileNames {
  localKgTests: string;
  baselineTests: string;
  localKgJson: string;
  baselineJson: string;
}

export function renderCompareReportMarkdown(
  cmp: GenerateComparison,
  createdAt: string,
  files?: CompareTestFileNames
): string {
  const lines: string[] = [];
  lines.push("# OrangePro Local — A/B comparison report");
  lines.push("");
  lines.push(`- Generated at: ${createdAt}`);
  lines.push(`- Model: ${cmp.model_provider}/${cmp.model_name}`);
  lines.push(`- System prompt (shared by both arms): ${cmp.system_prompt_source}`);
  lines.push(`- Scored by: ${cmp.scoring_method}`);
  if (cmp.rationale) lines.push(`- Judge rationale: ${cmp.rationale}`);
  lines.push("");

  if (cmp.model_provider === "none") {
    lines.push("No comparison was produced — no model provider configured.");
    for (const w of cmp.warnings) lines.push(`- ${w}`);
    return lines.join("\n") + "\n";
  }

  if (files) {
    lines.push("## Test cases");
    lines.push("");
    lines.push("Per-arm files (run each arm and compare side by side):");
    lines.push("");
    lines.push(
      `- **Local KG (graph-grounded) — keep these:** runnable code [\`${files.localKgTests}\`](./${files.localKgTests}), ` +
        `structured cases [\`${files.localKgJson}\`](./${files.localKgJson}).`
    );
    lines.push(
      `- **Prompt-only baseline — comparison only:** runnable code [\`${files.baselineTests}\`](./${files.baselineTests}), ` +
        `structured cases [\`${files.baselineJson}\`](./${files.baselineJson}).`
    );
    lines.push("");
    lines.push(
      "Write the **Local KG** tests to their own files and run them (those are the keep-arm); the " +
        "prompt-only baseline is included only for comparison (it may need its own imports to run)."
    );
    lines.push("");
  }

  const s = cmp.scores;
  lines.push("## Scores (0–100)");
  lines.push("");
  lines.push("| Dimension | Prompt-only | Local KG |");
  lines.push("|---|---:|---:|");
  lines.push(`| Completeness | ${s.baseline.completeness} | ${s.grounded.completeness} |`);
  lines.push(`| Context awareness | ${s.baseline.context_awareness} | ${s.grounded.context_awareness} |`);
  lines.push(`| Accuracy | ${s.baseline.accuracy} | ${s.grounded.accuracy} |`);
  lines.push(`| Domain specificity | ${s.baseline.domain_specificity} | ${s.grounded.domain_specificity} |`);
  lines.push("");

  const mx = cmp.matrix;
  lines.push("## Comparison matrix");
  lines.push("");
  lines.push("| Metric | Prompt-only | Local KG |");
  lines.push("|---|---:|---:|");
  lines.push(`| Tests | ${mx.baseline.tests} | ${mx.grounded.tests} |`);
  lines.push(`| Concrete assertions (avg) | ${mx.baseline.concrete_assertions_avg} | ${mx.grounded.concrete_assertions_avg} |`);
  lines.push(`| Traceability (source refs) | ${mx.baseline.traceability_refs} | ${mx.grounded.traceability_refs} |`);
  lines.push(`| Weak evidence disclosed | ${mx.baseline.weak_evidence_disclosed} | ${mx.grounded.weak_evidence_disclosed} |`);
  lines.push(`| Smoke-only | ${mx.baseline.smoke_only} | ${mx.grounded.smoke_only} |`);
  lines.push("");

  // Compact index — one line per test — instead of full body dumps (those live
  // in the test-cases file).
  const indexArm = (label: string, tests: ArmTests): void => {
    for (const t of tests) {
      const refs = t.grounding.source_refs.length;
      lines.push(
        `- [${label}] ${t.title}${t.bucket ? ` {${t.bucket}}` : ""} — ${t.test_type}/${t.framework_hint}, ` +
          `${refs} source ref${refs === 1 ? "" : "s"}${t.weak_evidence_used ? ", weak evidence" : ""}`
      );
    }
  };
  lines.push("## Generated tests (index)");
  lines.push("");
  if (!cmp.grounded.generated_tests.length && !cmp.baseline.generated_tests.length) {
    lines.push("_(no tests generated)_");
  } else {
    indexArm("Local KG", cmp.grounded.generated_tests);
    indexArm("Baseline", cmp.baseline.generated_tests);
    if (files) {
      lines.push("");
      lines.push(
        `Full bodies: Local KG [\`${files.localKgTests}\`](./${files.localKgTests}), ` +
          `baseline [\`${files.baselineTests}\`](./${files.baselineTests}).`
      );
    }
  }
  lines.push("");

  // Agent run hints (Local KG, runnable tests only). The agent writes each test
  // to its path and runs it — OrangePro never writes to or runs the repo.
  if (cmp.grounded.run_hints?.length) {
    lines.push("## Agent run hints (Local KG)");
    lines.push("");
    lines.push("Write each test to its path and run it (the agent does this for you):");
    lines.push("");
    for (const h of cmp.grounded.run_hints) {
      lines.push(`- \`${h.suggested_path}\` — run: \`${h.run_command}\``);
    }
    lines.push("");
  } else if (cmp.grounded.generated_tests.length) {
    lines.push("## Review before running");
    lines.push("");
    lines.push(
      "The Local KG tests are in the per-arm files above. Review each, write it to its own file, " +
        "and run it with your repo's test command."
    );
    lines.push("");
  }

  if (cmp.warnings.length) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of cmp.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
