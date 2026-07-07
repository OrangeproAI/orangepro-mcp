/**
 * Internal prompt assembly. NEVER exported in the evidence pack — only the
 * `prompt_version` string is recorded in generation runs. Section labels are
 * uppercase so the deterministic provider can map grounded evidence into
 * concrete assertions.
 */
import { LocalBucket, TestLayer } from "../graph/ontology.js";
import { BUCKET_LABEL } from "./buckets.js";

export const PROMPT_VERSION = "orangepro.local.testgen.v2" as const;

/** Generic local proof-kit guidance per scenario bucket. */
const BUCKET_GUIDANCE: Record<LocalBucket, string> = {
  happy_path: "the primary expected-success path — valid inputs produce the correct outcome.",
  validation_error: "invalid or missing input is rejected with the right error/validation behavior.",
  edge_case: "a boundary or unusual state (empty/null, limits, missing data, concurrency/timeouts).",
  integration_flow: "a flow across modules/services/routes — exercise the real interaction, not a unit in isolation.",
  security_privacy: "an access-control / privacy concern (auth, permissions, tokens, sessions, roles).",
  regression: "a previously-broken or known-risk behavior stays correct (guard against regressions)."
};

export interface GenerationContext {
  behavior_external_id: string;
  behavior_title: string;
  description?: string;
  actors: string[];
  priority?: string;
  acceptance_criteria: string[];
  workflow_steps: string[];
  framework: string;
  test_layer: TestLayer;
  /** File/symbol names — metadata grounding, never source bodies. */
  code_context: string[];
  /** Redacted in-process source excerpts — used for the prompt, never stored. */
  source_excerpts: string[];
  /** Weak/candidate evidence, clearly labeled. */
  weak_context: string[];
  /** Observed names of EXISTING tests — coverage that already exists (do not regenerate). */
  existing_tests: string[];
  /** Working import lines reconstructed from graph metadata (linked test file's imports). */
  subject_imports: string[];
}

export function buildSystemPrompt(): string {
  return [
    "You are OrangePro's local test-generation assistant.",
    "Generate exactly one focused, concrete test for the target behavior.",
    "Rules:",
    "- Name the behavior or requirement under test.",
    "- Target the given framework / test layer.",
    "- EXISTING TESTS listed in the evidence are coverage that ALREADY exists. Generate a",
    "  scenario that is NOT among them — never re-derive or restate an existing test.",
    "- Include at least one assertion tied to a stated acceptance criterion or expected behavior.",
    "- Do NOT produce smoke-only or existence-only tests unless that is the actual requirement.",
    "- Do NOT copy SOURCE EXCERPT lines verbatim. Use them to understand behavior, then write original test code.",
    "- Write COMPLETE import statements for everything the test uses (framework, test helpers,",
    "  the module under test). Module paths and exported names are metadata — imports are",
    "  expected and exempt from any copying concern. Prefer the SUBJECT IMPORTS provided.",
    "- If SUBJECT IMPORTS are provided, reuse those repo-proven imports instead of inventing",
    "  new module paths or switching test frameworks.",
    "- Start the test body with two comment lines using the target language's comment syntax:",
    "  `// Bucket: <bucket>` and `// Refs: <evidence refs>` for TS/JS/Go/Java;",
    "  `# Bucket: <bucket>` and `# Refs: <evidence refs>` for Python.",
    "- Framework format rules:",
    "  - pytest: output a valid Python file with pytest-style `def test_...` functions and `assert` statements.",
    "  - Go: output a same-package `_test.go` body. Include `package <same package>`, `import \"testing\"`,",
    "    and `func Test...(t *testing.T)`. Avoid third-party or module-path imports; use stdlib-only unless",
    "    the evidence gives an existing same-package helper.",
    "  - Java/JUnit: output a complete `.java` file, not a method fragment. Include a `class <Name>Test { ... }`,",
    "    the requested JUnit version's `@Test` import, and a JUnit assertion.",
    "  - TS/JS: output valid framework code for the named framework and use complete imports.",
    "- Prefer specificity grounded in the provided evidence over generic phrasing.",
    "- Treat WEAK CONTEXT as low-confidence hints, not facts.",
    "- Output ONLY the test code — no Markdown code fences, no prose, no explanation."
  ].join("\n");
}

export function buildGroundedUserPrompt(ctx: GenerationContext, bucket?: LocalBucket): string {
  const lines: string[] = [];
  lines.push(`BEHAVIOR: ${ctx.behavior_title}`);
  if (ctx.description) lines.push(`DESCRIPTION: ${ctx.description}`);
  if (ctx.actors.length) lines.push(`ACTORS: ${ctx.actors.join(", ")}`);
  if (ctx.priority) lines.push(`PRIORITY: ${ctx.priority}`);
  lines.push(`FRAMEWORK: ${ctx.framework}`);
  lines.push(`TEST LAYER: ${ctx.test_layer}`);
  if (ctx.acceptance_criteria.length) {
    lines.push("ACCEPTANCE CRITERIA:");
    for (const ac of ctx.acceptance_criteria) lines.push(`- ${ac}`);
  }
  if (ctx.workflow_steps.length) {
    lines.push("WORKFLOW STEPS:");
    for (const step of ctx.workflow_steps) lines.push(`- ${step}`);
  }
  if (ctx.code_context.length) {
    lines.push("CODE CONTEXT:");
    for (const c of ctx.code_context) lines.push(`- ${c}`);
  }
  if (ctx.existing_tests.length) {
    lines.push("EXISTING TESTS (already covered — do NOT regenerate these scenarios):");
    for (const t of ctx.existing_tests) lines.push(`- ${t}`);
  }
  if (ctx.subject_imports.length) {
    lines.push("SUBJECT IMPORTS (working import lines from the repo's own test for this area — reuse them):");
    for (const imp of ctx.subject_imports) lines.push(imp);
  }
  if (ctx.source_excerpts.length) {
    lines.push("SOURCE EXCERPTS:");
    lines.push("Use these for understanding only; do not copy their lines verbatim into the test body.");
    for (const e of ctx.source_excerpts) lines.push(e);
  }
  if (ctx.weak_context.length) {
    lines.push("WEAK CONTEXT:");
    for (const w of ctx.weak_context) lines.push(`- ${w}`);
  }
  const fw = ctx.framework.toLowerCase();
  lines.push("FRAMEWORK-SPECIFIC RUNNABILITY RULES:");
  if (fw.includes("pytest") || fw.includes("python")) {
    lines.push("- Use Python comments (`# Bucket`, `# Refs`), not `//` comments.");
    lines.push("- Emit a pytest file with at least one `def test_...` function and a real `assert`.");
  } else if (fw.includes("go")) {
    lines.push("- Emit same-package Go test code only: `package ...`, `import \"testing\"`, and `func Test...(t *testing.T)`.");
    lines.push("- Do not import third-party or module-path packages such as `github.com/...`; prefer stdlib-only tests.");
    lines.push("- Do not use testify/assert/require unless an existing same-package helper in the evidence clearly requires it.");
  } else if (fw.includes("junit") || fw.includes("java")) {
    if (fw.includes("junit4")) {
      lines.push("- Emit JUnit 4 code with `import org.junit.Test;` and `import static org.junit.Assert.*;`.");
    } else {
      lines.push("- Emit JUnit 5 code with `import org.junit.jupiter.api.Test;` and a static JUnit assertion import.");
    }
    lines.push("- Return a complete `.java` file with a test class, not a bare method fragment.");
    lines.push("- Include at least one `@Test` method with a real assertion.");
  } else {
    lines.push(`- Emit ${ctx.framework} code only. Do not switch to another test framework or import its package.`);
    if (fw.includes("ava")) {
      lines.push("- For AVA, use `import test from \"ava\";` and assertions such as `t.is`, `t.deepEqual`, `t.true`, or `t.throws`.");
    }
    lines.push("- If SUBJECT IMPORTS are listed, reuse those exact repo-proven imports for the module under test.");
    lines.push("- Do not invent module paths, selectors, helpers, or framework packages not shown in the evidence.");
    lines.push("- Do not paste SOURCE EXCERPT statements into the test. Create new test data and assertions from the behavior.");
    lines.push("- Emit one complete test file with complete imports and at least one assertion.");
  }
  lines.push("");
  if (bucket) {
    lines.push(`SCENARIO FOCUS (${BUCKET_LABEL[bucket]}): ${BUCKET_GUIDANCE[bucket]}`);
    lines.push(`Write the single best ${BUCKET_LABEL[bucket]} test for this behavior, grounded ONLY in the evidence above.`);
    lines.push("Label the test with this bucket. Cite the evidence anchors / source refs you used.");
    lines.push("If you rely on weak/candidate evidence, disclose it. Do not invent APIs, modules, selectors, or");
    lines.push("business rules not supported by the evidence. Do not produce a generic smoke test.");
  } else {
    lines.push("Produce the single best test for this behavior.");
  }
  return lines.join("\n");
}

/** Raw-prompt baseline (internal comparison only) — no graph grounding. */
export function buildRawUserPrompt(behaviorTitle: string, framework: string): string {
  return [
    `BEHAVIOR: ${behaviorTitle}`,
    `FRAMEWORK: ${framework}`,
    "",
    "Write a test for this."
  ].join("\n");
}
