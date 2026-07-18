import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { autoProve, containedGeneratedPath, existingAssociatedTests, isEligibleProvableTarget, isRoastSurvivor, orderExistingAttempts, NO_KEY_MESSAGE, AutoProveDeps } from "../../src/local/autoProve.js";
import type { AutoProveAttempt } from "../../src/local/autoProve.js";
import { loadLedger } from "../../src/local/ledger.js";
import { opAnalyze, opDynamicProof, opInit, opProveLoop, opRtm, opStart } from "../../src/local/operations.js";
import type { ProveLoopResult } from "../../src/local/operations.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { runHintsFor, suggestedTestPath } from "../../src/local/generate/runHints.js";
import { generateTests } from "../../src/local/generate/generator.js";
import type { GeneratedTest, GraphNode, LocalGraph } from "../../src/local/graph/ontology.js";
import type { GenerateOptions, GenerateResult, ModelCompletionRequest, ModelProvider } from "../../src/local/types.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";

const TARGET = "sym:service.ts#createOrder";
const clock = () => "2026-07-02T00:00:00Z";
const KEY_ENV = { OPENAI_API_KEY: "sk-test-key" } as NodeJS.ProcessEnv;
const NO_ENV = {} as NodeJS.ProcessEnv;

const tempDirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["typescript", "go", "python"]);
});

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("isRoastSurvivor", () => {
  const attempt = (classification: AutoProveAttempt["classification"], mutant_status?: string): AutoProveAttempt => ({
    target_symbol: TARGET,
    test_path: "service.test.ts",
    classification,
    mutant_status,
  });

  it("reports only real survived mutants, not crashes/refusals/baseline-red/proven attempts", () => {
    expect(isRoastSurvivor(attempt("non_killing", "associated_survived"))).toBe(true);
    expect(isRoastSurvivor(attempt("non_killing", "associated_non_assertion_failure"))).toBe(false);
    expect(isRoastSurvivor(attempt("needs_setup", "unrunnable"))).toBe(false);
    expect(isRoastSurvivor(attempt("needs_setup", undefined))).toBe(false);
    expect(isRoastSurvivor(attempt("proven", "reproven"))).toBe(false);
  });
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", devDependencies: { vitest: "^2.0.0" } }, null, 2), "utf8");
  writeFileSync(
    join(dir, "service.ts"),
    ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
    "utf8"
  );
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

/**
 * Workspace with BOTH an eligible entry-point-adjacent behavior (service.ts#createOrder)
 * and an EXCLUDED infra plumbing symbol (registry.ts#getRegistrationIdentifier — matches
 * the infra accessor suffix, so denominator_reason_code=infra_behavior_surface, eligible=false).
 */
function makeWorkspaceWithInfra(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-infra-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", devDependencies: { vitest: "^2.0.0" } }, null, 2), "utf8");
  writeFileSync(
    join(dir, "service.ts"),
    ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dir, "registry.ts"),
    ["export function getRegistrationIdentifier(key: string): string {", "  return `reg-${key}`;", "}", ""].join("\n"),
    "utf8"
  );
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

/** Workspace with N eligible entry-point-adjacent behaviors, to force multi-window paging (GEN_WINDOW=5). */
function makeWorkspaceMulti(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-multi-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", devDependencies: { vitest: "^2.0.0" } }, null, 2), "utf8");
  const names = ["createOrder", "createBravo", "createCharlie", "createDelta", "createEcho", "createFoxtrot", "createGolf", "createHotel"];
  const fns = names.slice(0, n).map((fn) => `export function ${fn}(id: string): string { return \`${fn}-\${id}\`; }`);
  writeFileSync(join(dir, "service.ts"), `${fns.join("\n")}\n`, "utf8");
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

function nodeOf(root: string, extId: string) {
  return loadGraph(workspacePaths(root).graphPath).nodes.find((n) => n.external_id === extId);
}

/** A generated test targeting a code symbol (TS/JS → provable via dynamic proof). */
function fakeTest(over: Partial<GeneratedTest> = {}): GeneratedTest {
  return {
    id: "gen-1",
    run_id: "run-1",
    title: "creates order id",
    test_type: "unit",
    framework_hint: "vitest",
    body: [
      "import { describe, expect, it } from 'vitest';",
      "import { createOrder } from './service';",
      "describe('createOrder', () => { it('works', () => { expect(createOrder('1')).toBe('order-1'); }); });",
      ""
    ].join("\n"),
    grounding: { entity_ids: [TARGET], source_refs: [], weak_relationships_used: [] },
    weak_evidence_used: false,
    target_symbol_external_id: TARGET,
    runnable: true,
    ...over
  };
}

/** Fake generator: returns the given tests on the FIRST call, then nothing. */
function fakeGenerate(tests: GeneratedTest[]) {
  let called = false;
  return vi.fn(async (): Promise<GenerateResult> => {
    if (called) return { run: null, generated_tests: [], missing_evidence: [], warnings: [] };
    called = true;
    return { run: null, generated_tests: tests, missing_evidence: [], warnings: [] };
  });
}

type OracleKind = "proven" | "non_killing" | "baseline_fail" | "crash";

/** Oracle JSON the mocked dynamic-proof runner emits. */
function oracle(kind: OracleKind) {
  const base = { runner: "vitest", replacementMode: "return-json", test: "t", target: "service.ts", method: "createOrder", medianProofMs: 5 };
  if (kind === "proven") {
    return JSON.stringify({ ...base, status: "proven", proven: true, reason: "kill", baseline: { exitCode: 0, timedOut: false }, mutant: { exitCode: 1, timedOut: false, assertionFailure: true } });
  }
  if (kind === "non_killing") {
    return JSON.stringify({ ...base, status: "associated_survived", proven: false, reason: "survived", baseline: { exitCode: 0, timedOut: false }, mutant: { exitCode: 0, timedOut: false, assertionFailure: false } });
  }
  if (kind === "crash") {
    // Baseline green, but the mutant crashes BEFORE any assertion (exit≠0, assertionFailure false):
    // a non-assertion failure — never a valid kill/close.
    return JSON.stringify({ ...base, status: "associated_non_assertion_failure", proven: false, reason: "target threw before assertion", baseline: { exitCode: 0, timedOut: false }, mutant: { exitCode: 1, timedOut: false, assertionFailure: false } });
  }
  return JSON.stringify({ ...base, status: "unproven", proven: false, reason: "baseline failed", baseline: { exitCode: 1, timedOut: false }, mutant: { exitCode: 1, timedOut: false, assertionFailure: false } });
}

function proofRunner(kind: OracleKind) {
  return () => ({ exitCode: 0, stderr: "", stdout: oracle(kind) });
}

function baseDeps(env: NodeJS.ProcessEnv, over: Partial<AutoProveDeps> = {}): AutoProveDeps {
  return { clock, env, proveLoop: opProveLoop, ...over };
}

function generatedDir(root: string): string {
  return join(loadGraph(workspacePaths(root).graphPath).workspace.root, "orangepro_generated");
}

describe("autoProve — key gate", () => {
  it("1. no key → no generated files, Proven 0, explicit guidance", async () => {
    const W = makeWorkspace();
    const gen = fakeGenerate([fakeTest()]);
    const res = await autoProve(W, { autoLimit: 3 }, baseDeps(NO_ENV, { generate: gen }));

    expect(res.ran).toBe(false);
    expect(res.status).toBe("skipped-no-key");
    expect(res.reason).toBe(NO_KEY_MESSAGE);
    expect(res.generated_files).toEqual([]);
    expect(res.proven).toBe(0);
    expect(gen).not.toHaveBeenCalled();
    expect(existsSync(generatedDir(W))).toBe(false);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });
});

describe("autoProve — proof outcomes", () => {
  it("2. successful generated test → Proven 0→1 via a real dynamic cert", async () => {
    const W = makeWorkspace();
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);

    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([fakeTest()]), dynamicProofRunner: proofRunner("proven") })
    );

    expect(res.ran).toBe(true);
    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(1);
    expect(res.generated_files.length).toBe(1);
    expect(res.attempts[0].classification).toBe("proven");
    // Proven minted only by the real oracle/cert path → RTM reflects it.
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);
  });

  it("3. generated non-killing test → Proven stays 0 (honest skip)", async () => {
    const W = makeWorkspace();
    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([fakeTest()]), dynamicProofRunner: proofRunner("non_killing") })
    );

    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(0);
    expect(res.attempts[0].classification).toBe("non_killing");
    expect(res.attempts[0].mutant_status).toBe("associated_survived");
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("8. ambiguous baseline failure (no captured detail) → non_killing honest unproven, NOT needs_setup", async () => {
    const W = makeWorkspace();
    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([fakeTest()]), dynamicProofRunner: proofRunner("baseline_fail") })
    );

    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(0);
    // A baseline-red with no confident env category is `unknown` → an honest non-proof, never a
    // "just needs setup" excuse that would hide a real unproven behind inflated needs_setup.
    expect(res.needs_setup.length).toBe(0);
    expect(res.attempts[0].classification).toBe("non_killing");
    expect(res.attempts[0].category).toBe("unknown");
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });
});

describe("autoProve — trust: a failed later attempt cannot hide a prior Proven", () => {
  it("4. seeds a Proven cert, then a failing auto attempt leaves Proven count unchanged", async () => {
    const W = makeWorkspace();
    // Seed a genuine dynamic proof for the target (matching fingerprint).
    opDynamicProof(
      W,
      { target_symbol: TARGET, source: loadGraph(workspacePaths(W).graphPath).workspace.root, test_path: "seed.test.ts", replacement: "return null;", runner: "vitest", run_id: "seed" },
      { clock, env: NO_ENV, dynamicProofRunner: proofRunner("proven") }
    );
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);

    // A failing auto attempt on the SAME symbol must NOT demote the prior Proven (#162).
    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([fakeTest()]), dynamicProofRunner: proofRunner("non_killing") })
    );
    expect(res.proven).toBe(0);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);
  });
});

describe("autoProve — repo-write guardrails", () => {
  it("5. a generated path that escapes orangepro_generated/ is rejected", () => {
    const W = makeWorkspace();
    const root = loadGraph(workspacePaths(W).graphPath).workspace.root;
    expect(() => containedGeneratedPath(root, "../../evil.test.ts")).toThrow();
    expect(() => containedGeneratedPath(root, "../escape.test.ts")).toThrow();
    // A plain filename is contained (control).
    expect(containedGeneratedPath(root, "ok.test.ts")).toContain("orangepro_generated");
  });

  it("6. an existing file in orangepro_generated/ is NOT overwritten", async () => {
    const W = makeWorkspace();
    const root = loadGraph(workspacePaths(W).graphPath).workspace.root;
    const rel = suggestedTestPath(fakeTest(), 0);
    const filename = rel.slice(rel.lastIndexOf("/") + 1);
    const abs = join(root, "orangepro_generated", filename);
    mkdirSync(join(root, "orangepro_generated"), { recursive: true });
    writeFileSync(abs, "PRE-EXISTING — DO NOT TOUCH", "utf8");

    const proveLoop = vi.fn(opProveLoop);
    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([fakeTest()]), dynamicProofRunner: proofRunner("proven"), proveLoop })
    );

    expect(readFileSync(abs, "utf8")).toBe("PRE-EXISTING — DO NOT TOUCH");
    expect(res.attempted).toBe(0);
    expect(res.proven).toBe(0);
    expect(res.generated_files).toEqual([]);
    expect(proveLoop).not.toHaveBeenCalled();
    expect(res.skipped.some((s) => /not overwritten/i.test(s.reason))).toBe(true);
  });
});

describe("autoProve — generation lane: Go is not dynamically provable via a generated file", () => {
  it("7. a GENERATED Go test is skipped (wrong package for `go test -run`), never attempted", async () => {
    // G-INT-2: Go IS admitted at selection now, but the Go oracle runs the TARGET
    // package's OWN test (`go test -run ^TestX$ ./<pkgdir>`). A freshly generated test
    // written to orangepro_generated/ lives outside that package, so it can never be
    // reached — the generation lane honestly skips it (the existing-tests lane covers Go).
    const W = makeWorkspace();
    const goTest = fakeTest({ framework_hint: "go", target_symbol_external_id: "sym:math.go#Add", body: "package svc\nfunc TestAdd(t *testing.T){}" });
    const proveLoop = vi.fn(opProveLoop);
    const res = await autoProve(
      W,
      { autoLimit: 3 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([goTest]), dynamicProofRunner: proofRunner("proven"), proveLoop })
    );

    expect(res.attempted).toBe(0);
    expect(res.proven).toBe(0);
    expect(res.generated_files).toEqual([]);
    expect(proveLoop).not.toHaveBeenCalled();
    expect(res.skipped.some((s) => /existing-tests lane/i.test(s.reason))).toBe(true);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });
});

describe("autoProve — eligibility trust barrier (never auto-prove plumbing)", () => {
  it("9. an EXCLUDED infra CodeSymbol is never selected as an auto-prove target", async () => {
    const W = makeWorkspaceWithInfra();
    // The infra node exists in the graph but is denominator-excluded plumbing.
    const infra = nodeOf(W, "sym:registry.ts#getRegistrationIdentifier");
    expect(infra).toBeDefined();
    expect(infra!.denominator_eligible).not.toBe(true);
    expect(infra!.properties.denominator_reason_code).toBe("infra_behavior_surface");
    expect(isEligibleProvableTarget(infra)).toBe(false);
    // The eligible behavior IS a valid target (control).
    expect(isEligibleProvableTarget(nodeOf(W, TARGET))).toBe(true);

    // Auto-prove restricted (via PR scope) to ONLY the infra file must attempt nothing:
    // the selector never hands plumbing to the guard-less prove path.
    const gen = fakeGenerate([fakeTest({ target_symbol_external_id: "sym:registry.ts#getRegistrationIdentifier", grounding: { entity_ids: ["sym:registry.ts#getRegistrationIdentifier"], source_refs: [], weak_relationships_used: [] } })]);
    const proveLoop = vi.fn(opProveLoop);
    const res = await autoProve(
      W,
      { autoLimit: 3, changedFiles: ["registry.ts"] },
      baseDeps(KEY_ENV, { generate: gen, dynamicProofRunner: proofRunner("proven"), proveLoop })
    );

    expect(res.attempted).toBe(0);
    expect(res.proven).toBe(0);
    expect(res.generated_files).toEqual([]);
    expect(gen).not.toHaveBeenCalled();
    expect(proveLoop).not.toHaveBeenCalled();
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("10. PR-mode: a changed infra file yields no plumbing target", async () => {
    const W = makeWorkspaceWithInfra();
    const gen = fakeGenerate([fakeTest()]);
    const proveLoop = vi.fn(opProveLoop);
    // Only the infra file is in the diff → no eligible symbol in scope → nothing attempted.
    const res = await autoProve(
      W,
      { autoLimit: 3, changedFiles: ["registry.ts"] },
      baseDeps(KEY_ENV, { generate: gen, dynamicProofRunner: proofRunner("proven"), proveLoop })
    );
    expect(res.attempted).toBe(0);
    expect(res.proven).toBe(0);
    expect(gen).not.toHaveBeenCalled();
    expect(proveLoop).not.toHaveBeenCalled();

    // Control: with the ELIGIBLE file changed, the eligible symbol IS attempted.
    const gen2 = fakeGenerate([fakeTest()]);
    const res2 = await autoProve(
      W,
      { autoLimit: 1, changedFiles: ["service.ts"] },
      baseDeps(KEY_ENV, { generate: gen2, dynamicProofRunner: proofRunner("proven") })
    );
    expect(res2.attempted).toBe(1);
    expect(res2.proven).toBe(1);
  });
});

describe("autoProve — #164 fix regressions", () => {
  // Fix 1: import-grounding. The generator grounds a test's import against the SOURCE
  // dir (`./service`), but autoProve writes to orangepro_generated/. The write must
  // rewrite `./service` → `../service` so it resolves from the write location, and a
  // generator `runnable:false` verdict (wrong location) must be RE-VALIDATED after the
  // rewrite rather than pre-skipped.
  it("1a. rewrites a runnable:false draft's import to resolve from orangepro_generated/ and attempts it", async () => {
    const W = makeWorkspace();
    const draft = fakeTest({ runnable: false, unresolved_reason: "Unresolved import(s) ./service" });
    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([draft]), dynamicProofRunner: proofRunner("proven") })
    );
    expect(res.generated_files.length).toBe(1);
    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(1);
    const written = readFileSync(join(generatedDir(W), res.generated_files[0].split("/").pop() as string), "utf8");
    expect(written).toContain("'../service'");
    expect(written).not.toContain("'./service'");
  });

  it("1b. still skips a runnable:false draft whose import cannot resolve even after rewrite", async () => {
    const W = makeWorkspace();
    const draft = fakeTest({
      runnable: false,
      unresolved_reason: "Unresolved import(s) ./missing",
      body: [
        "import { describe, expect, it } from 'vitest';",
        "import { createOrder } from './missing';",
        "describe('createOrder', () => { it('works', () => { expect(createOrder('1')).toBe('order-1'); }); });",
        ""
      ].join("\n")
    });
    const res = await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([draft]), dynamicProofRunner: proofRunner("proven") })
    );
    expect(res.generated_files).toEqual([]);
    expect(res.proven).toBe(0);
    expect(res.skipped.some((s) => /non-runnable draft/.test(s.reason))).toBe(true);
    expect(existsSync(generatedDir(W))).toBe(false);
  });

  // Fix 2: filenames must stay unique across generation windows (runHintsFor resets its
  // index per call; the startIndex offset prevents same-slug collisions).
  it("2. suggestedTestPath / runHintsFor honor a startIndex offset → distinct filenames across windows", () => {
    const t = fakeTest({ title: "handler" });
    expect(suggestedTestPath(t, 0)).not.toBe(suggestedTestPath(t, 5));
    const a = runHintsFor([t], undefined, 0);
    const b = runHintsFor([t], undefined, 5);
    expect(a[0].prove_run?.args.test_path).not.toBe(b[0].prove_run?.args.test_path);
  });

  it("2b. Python generated tests carry a pytest dynamic-proof handoff, not static-only record_run", () => {
    const t = fakeTest({
      framework_hint: "pytest",
      target_symbol_external_id: "sym:src/app/calc.py#add",
      body: ["from app.calc import add", "", "def test_add():", "    assert add(1, 2) == 3", ""].join("\n")
    });
    const [hint] = runHintsFor([t], undefined, 0);
    expect(hint.prove_run).toEqual({
      tool: "orangepro_prove",
      args: {
        target_symbol: "sym:src/app/calc.py#add",
        test_path: "orangepro_generated/01_creates_order_id.py",
        replacement: "return 0",
        runner: "pytest"
      }
    });
    expect(hint.record_run).toBeDefined();
  });

  // Fix 3: an empty first window (transient generation hiccup) must NOT abandon
  // lower-ranked candidates — the loop continues to the next window.
  it("3. an empty first window does not abandon a provable later-window candidate", async () => {
    const W = makeWorkspaceMulti(6); // 6 eligible → two windows (GEN_WINDOW=5)
    let call = 0;
    const gen = vi.fn(async (): Promise<GenerateResult> => {
      call++;
      if (call === 1) return { run: null, generated_tests: [], missing_evidence: [], warnings: [] };
      return { run: null, generated_tests: [fakeTest()], missing_evidence: [], warnings: [] };
    });
    const res = await autoProve(W, { autoLimit: 1 }, baseDeps(KEY_ENV, { generate: gen, dynamicProofRunner: proofRunner("proven") }));
    expect(gen.mock.calls.length).toBeGreaterThanOrEqual(2); // reached the second window
    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(1);
  });
});

// ── PR 1.5 — existing-associated-tests-first (no-key public-demo lift) ──────────
const SYM_ORDER = "sym:orderService.ts#createOrder";
const SYM_INVOICE = "sym:orderService.ts#createInvoice";
const SYM_PAYMENT = "sym:paymentService.ts#createPayment";
const EXISTING_TEST = "orderService.test.ts";

/**
 * Workspace with two eligible entry-point-adjacent behaviors sharing ONE existing test
 * (orderService.ts#createOrder / #createInvoice, exercised by orderService.test.ts) plus a
 * third eligible behavior with NO test (paymentService.ts#createPayment — a generation gap).
 */
function makeWorkspaceWithExistingTests(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-existing-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", type: "module" }, null, 2), "utf8");
  writeFileSync(
    join(dir, "orderService.ts"),
    [
      "export function createOrder(id: string): string {",
      "  return `order-${id}`;",
      "}",
      "export function createInvoice(id: string): string {",
      "  return `invoice-${id}`;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dir, "orderService.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { createInvoice, createOrder } from './orderService';",
      "describe('orderService', () => {",
      "  it('creates an order id', () => { expect(createOrder('42')).toBe('order-42'); });",
      "  it('creates an invoice id', () => { expect(createInvoice('7')).toBe('invoice-7'); });",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dir, "paymentService.ts"),
    ["export function createPayment(id: string): string {", "  return `payment-${id}`;", "}", ""].join("\n"),
    "utf8"
  );
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

/** A generated test targeting the untested gap symbol (used by the generation-lane test). */
function fakePaymentTest(): GeneratedTest {
  return fakeTest({
    id: "gen-pay",
    title: "creates payment id",
    target_symbol_external_id: SYM_PAYMENT,
    grounding: { entity_ids: [SYM_PAYMENT], source_refs: [], weak_relationships_used: [] },
    body: [
      "import { describe, expect, it } from 'vitest';",
      "import { createPayment } from './paymentService';",
      "describe('createPayment', () => { it('works', () => { expect(createPayment('1')).toBe('payment-1'); }); });",
      ""
    ].join("\n")
  });
}

describe("autoProve — PR 1.5 existing-associated-tests-first", () => {
  it("1. no key + Associated edges → existing-tests lane proves via opDynamicProof; generation NOT invoked", async () => {
    const W = makeWorkspaceWithExistingTests();
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);

    const gen = fakeGenerate([fakeTest()]);
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { generate: gen, dynamicProofRunner: proofRunner("proven") }));

    expect(res.ran).toBe(true);
    expect(res.status).toBe("proven-run");
    expect(res.proven).toBe(2); // createOrder + createInvoice, both via the real oracle
    expect(res.attempts.every((a) => a.classification === "proven")).toBe(true);
    expect(res.generated_files).toEqual([]);
    expect(gen).not.toHaveBeenCalled(); // no key → generation lane never runs
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(2);
  });

  it("1b. existingOnly runs only the existing-tests lane even when a provider key exists", async () => {
    const W = makeWorkspaceWithExistingTests();
    const gen = fakeGenerate([fakeTest()]);
    const res = await autoProve(W, { existingOnly: true }, baseDeps(KEY_ENV, { generate: gen, dynamicProofRunner: proofRunner("non_killing") }));

    expect(res.ran).toBe(true);
    expect(res.status).toBe("ran-no-proof");
    expect(res.generated_files).toEqual([]);
    expect(gen).not.toHaveBeenCalled();
    expect(res.attempts.some((a) => a.classification === "non_killing" && a.mutant_status === "associated_survived")).toBe(true);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("2. an eligible target whose existing test SURVIVES → not Proven; a prior Proven is unchanged", async () => {
    const W = makeWorkspaceWithExistingTests();
    const root = loadGraph(workspacePaths(W).graphPath).workspace.root;
    // Seed a genuine dynamic proof for createInvoice (matching fingerprint).
    opDynamicProof(
      W,
      { target_symbol: SYM_INVOICE, source: root, test_path: EXISTING_TEST, replacement: "return null;", runner: "vitest", run_id: "seed" },
      { clock, env: NO_ENV, dynamicProofRunner: proofRunner("proven") }
    );
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);

    // No key; every target's existing test SURVIVES the null mutant this run.
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { dynamicProofRunner: proofRunner("non_killing") }));

    expect(res.proven).toBe(0);
    expect(res.attempts.some((a) => a.target_symbol === SYM_ORDER && a.classification === "non_killing")).toBe(true);
    expect(res.attempts.find((a) => a.target_symbol === SYM_ORDER)?.mutant_status).toBe("associated_survived");
    // #162: a failing re-attempt on createInvoice does NOT demote its prior Proven.
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);
  });

  it("3. a non-assertion failure (target crashes pre-assert) → not Proven (not a false close)", async () => {
    const W = makeWorkspaceWithExistingTests();
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { dynamicProofRunner: proofRunner("crash") }));

    expect(res.proven).toBe(0);
    expect(res.attempts.length).toBeGreaterThanOrEqual(1);
    expect(res.attempts.every((a) => a.classification !== "proven")).toBe(true);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("4. an EXCLUDED infra symbol that has an Associated edge is NEVER selected", () => {
    const infra = {
      kind: "CodeSymbol",
      external_id: "sym:registry.ts#getRegistrationIdentifier",
      title: "getRegistrationIdentifier",
      denominator_eligible: false,
      properties: { file: "registry.ts", behavior_surface: "entrypoint_adjacent", denominator_reason_code: "infra_behavior_surface" }
    };
    const eligible = {
      kind: "CodeSymbol",
      external_id: SYM_ORDER,
      title: "createOrder",
      denominator_eligible: true,
      properties: { file: "orderService.ts", behavior_surface: "entrypoint_adjacent" }
    };
    const testCase = { kind: "TestCase", external_id: "test:svc.test.ts", title: "svc", properties: { file: "svc.test.ts" } };
    // Both symbols carry a HARD TESTED_BY edge to the SAME test — the infra one only differs by eligibility.
    const graph = {
      nodes: [infra, eligible, testCase],
      edges: [
        { relationship_type: "TESTED_BY", from_external_id: infra.external_id, to_external_id: testCase.external_id },
        { relationship_type: "TESTED_BY", from_external_id: eligible.external_id, to_external_id: testCase.external_id }
      ],
      candidate_edges: []
    } as unknown as LocalGraph;
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n as unknown as GraphNode]));

    expect(isEligibleProvableTarget(infra as unknown as GraphNode)).toBe(false);
    const map = existingAssociatedTests(graph, nodeById);
    // The eligible symbol is selected (hard TESTED_BY edge); the infra symbol is filtered out DESPITE its edge.
    expect(map.get(eligible.external_id)).toEqual([{ test: "svc.test.ts", hard: true }]);
    expect(map.has(infra.external_id)).toBe(false);
  });

  it("4b. a not_entry_point_adjacent symbol with a HARD edge IS selected (relaxed hard lane); infra stays excluded; weak stays strict", () => {
    // The PetTypeFormatter#print shape: not entry-point-adjacent (below the denominator bar),
    // but the repo's own test exercises it via a HARD TESTED_BY edge → the relaxed hard lane
    // admits it (the oracle is the sole judge of Proven). Infra plumbing is still excluded, and
    // a WEAK-only association to a not_entry_point_adjacent symbol stays strict (not selected).
    const belowBar = {
      kind: "CodeSymbol",
      external_id: "sym:Formatter.java#print",
      title: "print",
      denominator_eligible: false,
      properties: { file: "Formatter.java", symbol_kind: "method", denominator_reason_code: "not_entry_point_adjacent" }
    };
    const infra = {
      kind: "CodeSymbol",
      external_id: "sym:Registry.java#getIdentifier",
      title: "getIdentifier",
      denominator_eligible: false,
      properties: { file: "Registry.java", symbol_kind: "method", denominator_reason_code: "infra_behavior_surface" }
    };
    const weakOnly = {
      kind: "CodeSymbol",
      external_id: "sym:Other.java#compute",
      title: "compute",
      denominator_eligible: false,
      properties: { file: "Other.java", symbol_kind: "method", denominator_reason_code: "not_entry_point_adjacent" }
    };
    const testCase = { kind: "TestCase", external_id: "test:FormatterTest.java", title: "t", properties: { file: "FormatterTest.java" } };
    const graph = {
      nodes: [belowBar, infra, weakOnly, testCase],
      edges: [
        { relationship_type: "TESTED_BY", from_external_id: belowBar.external_id, to_external_id: testCase.external_id },
        { relationship_type: "TESTED_BY", from_external_id: infra.external_id, to_external_id: testCase.external_id }
      ],
      candidate_edges: [
        { relationship_type: "MAY_BE_TESTED_BY", from_external_id: weakOnly.external_id, to_external_id: testCase.external_id, review_status: "auto_detected" }
      ]
    } as unknown as LocalGraph;
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n as unknown as GraphNode]));

    // Strict eligibility still rejects all three (they are not_entry_point_adjacent / infra).
    expect(isEligibleProvableTarget(belowBar as unknown as GraphNode)).toBe(false);

    const map = existingAssociatedTests(graph, nodeById);
    // Relaxed: the not_entry_point_adjacent Java method with a HARD edge IS now selected.
    expect(map.get(belowBar.external_id)).toEqual([{ test: "FormatterTest.java", hard: true }]);
    // Infra plumbing stays excluded even with a hard edge.
    expect(map.has(infra.external_id)).toBe(false);
    // A WEAK-only association to a not_entry_point_adjacent symbol stays strict → not selected.
    expect(map.has(weakOnly.external_id)).toBe(false);
  });

  it("4c. Python hard edges preserve exact pytest selectors through the existing-tests queue", () => {
    const target = {
      kind: "CodeSymbol",
      external_id: "sym:src/app/calc.py#add",
      title: "add",
      denominator_eligible: false,
      properties: { file: "src/app/calc.py", symbol_kind: "function", denominator_reason_code: "not_entry_point_adjacent" }
    };
    const testCase = { kind: "TestCase", external_id: "test:src/app/test_calc.py", title: "test_calc.py", properties: { file: "src/app/test_calc.py" } };
    const graph = {
      nodes: [target, testCase],
      edges: [
        {
          relationship_type: "COVERS",
          from_external_id: testCase.external_id,
          to_external_id: target.external_id,
          properties: { test_name: "TestCalc::test_add" }
        }
      ],
      candidate_edges: []
    } as unknown as LocalGraph;
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n as unknown as GraphNode]));

    const map = existingAssociatedTests(graph, nodeById);
    expect(map.get(target.external_id)).toEqual([{ test: "src/app/test_calc.py", hard: true, testName: "TestCalc::test_add" }]);
    expect(orderExistingAttempts(map)[0]).toEqual({
      symId: target.external_id,
      testRel: "src/app/test_calc.py",
      hard: true,
      testName: "TestCalc::test_add"
    });
  });

  it("5. report refresh reflects the Proven delta (before 0 → after N)", async () => {
    const W = makeWorkspaceWithExistingTests();
    const before = opRtm(W, { format: "json" }).summary.proven;
    expect(before).toBe(0);

    const res = await autoProve(W, {}, baseDeps(NO_ENV, { dynamicProofRunner: proofRunner("proven") }));

    const after = opRtm(W, { format: "json" }).summary.proven;
    expect(res.proven).toBeGreaterThan(0);
    expect(after).toBe(before + res.proven);
  });

  it("6. with key: after the existing-tests lane, generation fills ONLY the remaining gaps", async () => {
    const W = makeWorkspaceWithExistingTests();
    const genSpy = vi.fn(async (_graph: unknown, opts: { target_ids?: string[]; limit?: number }): Promise<GenerateResult> =>
      (opts.target_ids ?? []).includes(SYM_PAYMENT)
        ? { run: null, generated_tests: [fakePaymentTest()], missing_evidence: [], warnings: [] }
        : { run: null, generated_tests: [], missing_evidence: [], warnings: [] }
    );
    const res = await autoProve(
      W,
      { autoLimit: 5 },
      baseDeps(KEY_ENV, { generate: genSpy, dynamicProofRunner: proofRunner("proven") })
    );

    const genTargetIds = genSpy.mock.calls.flatMap((c) => c[1].target_ids ?? []);
    // createOrder + createInvoice were already proven by the existing-tests lane → excluded.
    expect(genTargetIds).toContain(SYM_PAYMENT);
    expect(genTargetIds).not.toContain(SYM_ORDER);
    expect(genTargetIds).not.toContain(SYM_INVOICE);
    // 2 existing-test proofs + 1 generated proof = 3 total.
    expect(res.proven).toBe(3);
    expect(res.generated_files.length).toBe(1);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(3);
  });
});

// ── PR #166 fail-safe fixes (efficacy/UX; no trust invariant changed) ──────────
describe("autoProve — Fix 1: dedup already-Proven symbols across runs", () => {
  it("a 2nd run on unchanged code mints 0 new, RTM delta 0, and appends no extra cert", async () => {
    const W = makeWorkspaceWithExistingTests();

    const run1 = await autoProve(W, {}, baseDeps(NO_ENV, { dynamicProofRunner: proofRunner("proven") }));
    expect(run1.proven).toBe(2); // createOrder + createInvoice
    const rtmAfter1 = opRtm(W, { format: "json" }).summary.proven;
    const certsAfter1 = loadLedger(W).records.length;
    expect(rtmAfter1).toBe(2);
    expect(certsAfter1).toBe(2);

    // Same code, same key-less run again: both symbols are already Proven (fingerprint match) → skipped.
    const run2 = await autoProve(W, {}, baseDeps(NO_ENV, { dynamicProofRunner: proofRunner("proven") }));
    expect(run2.proven).toBe(0); // NEWLY-minted only
    expect(run2.attempted).toBe(0); // both eligible symbols skipped as already-proven
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(rtmAfter1); // RTM total delta 0
    expect(loadLedger(W).records.length).toBe(certsAfter1); // no redundant closed cert appended
  });
});

describe("autoProve — Fix 2: no-key run that mints 0 Proven still surfaces the add-a-key guidance", () => {
  it("opStart next_actions includes NO_KEY_MESSAGE when every existing test survives with no key", async () => {
    const W = makeWorkspaceWithExistingTests();
    // No key; every eligible symbol's existing test SURVIVES the null mutant → attempted > 0, proven 0.
    const res = await opStart(
      W,
      { ai: false, aiFlows: false },
      { clock, env: NO_ENV, dynamicProofRunner: proofRunner("non_killing") }
    );
    expect(res.auto_prove.proven).toBe(0);
    expect(res.auto_prove.attempted).toBeGreaterThan(0);
    expect(res.next_actions).toContain(NO_KEY_MESSAGE);
  });
});

describe("autoProve — Fix 3: rank hard edges first + cap weak fan-out", () => {
  it("hard TESTED_BY pairs precede all weak pairs; a hot file's weak fan-out is capped per symbol", () => {
    // A hot file's symbol carries 5 weak MAY_RELATE_TO tests and is inserted BEFORE the provable
    // hard-edge symbol; ordering must still surface the hard pair first (within budget) and bound
    // the hot symbol's weak contribution so it cannot starve the shared budget.
    const testsBySymbol = new Map<string, { test: string; hard: boolean }[]>([
      ["sym:hot.ts#hot", [
        { test: "a.test.ts", hard: false },
        { test: "b.test.ts", hard: false },
        { test: "c.test.ts", hard: false },
        { test: "d.test.ts", hard: false },
        { test: "e.test.ts", hard: false }
      ]],
      ["sym:svc.ts#prov", [{ test: "prov.test.ts", hard: true }]]
    ]);
    const order = orderExistingAttempts(testsBySymbol, 3);

    // The provable hard-edge pair is attempted first, before ANY weak pair.
    expect(order[0]).toEqual({ symId: "sym:svc.ts#prov", testRel: "prov.test.ts", hard: true });
    const firstWeak = order.findIndex((o) => !o.hard);
    expect(order.slice(0, firstWeak).every((o) => o.hard)).toBe(true);
    // The hot symbol contributes at most K=3 weak pairs → total queue is bounded, not 5.
    expect(order.filter((o) => o.symId === "sym:hot.ts#hot").length).toBe(3);
    expect(order.length).toBe(4);
  });
});

// ── R-1: baseline classification + sibling dedup (loop-level, no proof-semantics change) ──
/** A synthetic proveLoop result: baseline RED with a given (already-redacted) failure line. */
function baselineRed(failureSummary: string): ProveLoopResult {
  return {
    ledger_path: "x",
    record: { closed: false, dynamic_proof: { proof_kind: "dynamic_targeted", baseline_green: false } },
    oracle: { status: "unrunnable", proven: false, baseline: { exitCode: 1, timedOut: false, failureSummary } }
  } as unknown as ProveLoopResult;
}

/**
 * Same-file siblings (createOrder + createInvoice) whose package declares an impossible
 * engines.node, so ANY runner Node is out of range → a genuine package-level engine_mismatch
 * (the sole IMPORT_TIME_CATEGORY that dedups same-file siblings).
 */
function makeWorkspaceEngineMismatch(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-engine-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", type: "module", engines: { node: ">=999.0.0" } }, null, 2),
    "utf8"
  );
  writeFileSync(
    join(dir, "orderService.ts"),
    [
      "export function createOrder(id: string): string {",
      "  return `order-${id}`;",
      "}",
      "export function createInvoice(id: string): string {",
      "  return `invoice-${id}`;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dir, "orderService.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { createInvoice, createOrder } from './orderService';",
      "describe('orderService', () => {",
      "  it('creates an order id', () => { expect(createOrder('42')).toBe('order-42'); });",
      "  it('creates an invoice id', () => { expect(createInvoice('7')).toBe('invoice-7'); });",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

/** A synthetic proveLoop result: baseline GREEN and the mutant killed → Proven (closed cert). */
function provenLoop(): ProveLoopResult {
  return {
    ledger_path: "x",
    record: { closed: true, dynamic_proof: { proof_kind: "dynamic_targeted", baseline_green: true } },
    oracle: { status: "proven", proven: true, baseline: { exitCode: 0, timedOut: false } }
  } as unknown as ProveLoopResult;
}

describe("autoProve — R-1 sibling dedup + accurate classification", () => {
  it("K same-file siblings sharing one engine_mismatch root cause → 1 attempt, K-1 deduped (budget preserved)", async () => {
    const W = makeWorkspaceEngineMismatch(); // createOrder + createInvoice share orderService.ts; engines.node >=999
    // A NON-assertion baseline-red: the runner Node is out of the declared engines range → engine_mismatch,
    // a package-level fact shared by every sibling in the file (safe to dedup).
    const proveLoop = vi.fn(() => baselineRed("SyntaxError: Unexpected reserved word"));
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { proveLoop }));

    expect(proveLoop).toHaveBeenCalledTimes(1); // second sibling deduped WITHOUT re-running
    expect(res.attempted).toBe(1); // dedup did not consume the attempt budget
    expect(res.proven).toBe(0);
    expect(res.needs_setup.length).toBe(2); // one real + one deduped, both needs_setup
    const deduped = res.needs_setup.filter((a) => a.deduped === true);
    expect(deduped.length).toBe(1);
    expect(deduped[0].category).toBe("engine_mismatch");
    // Every needs_setup here is the package-level engine_mismatch root cause (no generic DB label).
    expect(res.needs_setup.every((a) => a.category === "engine_mismatch")).toBe(true);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("module_not_found from a sibling's TEST file does NOT drop a clean provable same-file sibling", async () => {
    const W = makeWorkspaceWithExistingTests(); // createOrder + createInvoice share orderService.ts
    // First attempt fails with module_not_found (typically a missing fixture/helper in the TEST
    // file, NOT a target-file property). module_not_found must not be cached/deduped, so the
    // second, clean sibling is still attempted and proves — the whole point of Fix 2.
    let call = 0;
    const proveLoop = vi.fn(() => (++call === 1 ? baselineRed("Cannot find module './fixtures/helper'") : provenLoop()));
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { proveLoop }));

    expect(proveLoop).toHaveBeenCalledTimes(2); // second sibling attempted, NOT deduped away
    expect(res.proven).toBe(1); // the clean sibling proved
    expect(res.needs_setup.length).toBe(1); // only the module_not_found attempt
    expect(res.needs_setup[0].category).toBe("module_not_found");
    expect(res.needs_setup.every((a) => a.deduped !== true)).toBe(true); // nothing dropped
  });

  it("no raw stderr / failureSummary lands in the persisted needs_setup record", async () => {
    const W = makeWorkspaceWithExistingTests();
    const leak = "Cannot find module './x' from /workspace/private-path/thing";
    const proveLoop = vi.fn(() => baselineRed(leak));
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { proveLoop }));

    expect(res.needs_setup.length).toBeGreaterThan(0);
    for (const a of res.needs_setup) {
      expect(a.category).toBe("module_not_found");
      expect(a.reason ?? "").not.toContain("private-path");
      expect(a.reason ?? "").not.toContain(leak);
    }
  });

  it("a genuine baseline assertion failure is logic_failure → NOT needs_setup (never re-run-deduped)", async () => {
    const W = makeWorkspaceWithExistingTests();
    const proveLoop = vi.fn(() => baselineRed("AssertionError: expected 'order-1' to be 'order-2'"));
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { proveLoop }));

    expect(res.needs_setup.length).toBe(0); // logic failures are honest non-proofs, not setup
    expect(res.proven).toBe(0);
    // Logic failures are NOT import-time → each sibling is attempted (no false dedup).
    expect(proveLoop).toHaveBeenCalledTimes(2);
    expect(res.attempts.some((a) => a.category === "logic_failure" && a.classification !== "needs_setup")).toBe(true);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });
});

// ── R-2: node:sqlite env profile is auto-applied via the existing test_env path ──
/** A workspace whose eligible target references node:sqlite, with an existing associated test. */
function makeWorkspaceSqlite(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-sqlite-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", type: "module" }, null, 2), "utf8");
  writeFileSync(
    join(dir, "store.ts"),
    [
      "import { DatabaseSync } from 'node:sqlite';",
      "export function sumViaSqlite(a: number, b: number): number {",
      "  const db = new DatabaseSync(':memory:');",
      "  const row = db.prepare('SELECT ? + ? AS total').get(a, b) as { total: number };",
      "  db.close();",
      "  return row.total;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dir, "store.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { sumViaSqlite } from './store';",
      "describe('sumViaSqlite', () => { it('adds', () => { expect(sumViaSqlite(2, 3)).toBe(5); }); });",
      ""
    ].join("\n"),
    "utf8"
  );
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

describe("autoProve — R-2 node:sqlite env profile wiring", () => {
  const provenResult = {
    ledger_path: "x",
    record: { closed: true, dynamic_proof: { proof_kind: "dynamic_targeted", baseline_green: true } },
    oracle: { status: "proven", proven: true, baseline: { exitCode: 0, timedOut: false } }
  } as unknown as ProveLoopResult;

  it("a target referencing node:sqlite → --experimental-sqlite forwarded to proveLoop only where the runner Node accepts the flag", async () => {
    const W = makeWorkspaceSqlite();
    const seen: Array<{ test_env?: string[] }> = [];
    const proveLoop = vi.fn((_r: string, opts: { test_env?: string[] }) => {
      seen.push(opts);
      return provenResult;
    });
    await autoProve(W, {}, baseDeps(NO_ENV, { proveLoop }));

    expect(proveLoop).toHaveBeenCalled();
    const injected = seen.some((o) => Array.isArray(o.test_env) && o.test_env.includes("NODE_OPTIONS=--experimental-sqlite"));
    // Node-gated: injected on Node >=22.5 (flag valid), NOT on older Node where NODE_OPTIONS would
    // reject it ("not allowed in NODE_OPTIONS") — node:sqlite is unavailable there anyway.
    expect(injected).toBe(process.allowedNodeEnvironmentFlags.has("--experimental-sqlite"));
  });

  it("a non-referencing target → NO env injection (never guesses a flag)", async () => {
    const W = makeWorkspaceWithExistingTests(); // orderService, no node:sqlite
    const seen: Array<{ test_env?: string[] }> = [];
    const proveLoop = vi.fn((_r: string, opts: { test_env?: string[] }) => {
      seen.push(opts);
      return provenResult;
    });
    await autoProve(W, {}, baseDeps(NO_ENV, { proveLoop }));

    expect(proveLoop).toHaveBeenCalled();
    expect(seen.every((o) => o.test_env === undefined)).toBe(true);
  });
});

// ── "Static map first, dynamically prove top 5": ONE unified dynamic-proof budget ──
const MULTI_NAMES = ["createOrder", "createBravo", "createCharlie", "createDelta", "createEcho", "createFoxtrot", "createGolf", "createHotel"];

/** A generated test targeting a distinct eligible symbol in service.ts (for budget paging). */
function fakeTestFor(fn: string): GeneratedTest {
  const sym = `sym:service.ts#${fn}`;
  return fakeTest({
    id: `gen-${fn}`,
    title: `covers ${fn}`,
    target_symbol_external_id: sym,
    grounding: { entity_ids: [sym], source_refs: [], weak_relationships_used: [] },
    body: [
      "import { describe, expect, it } from 'vitest';",
      `import { ${fn} } from './service';`,
      `describe('${fn}', () => { it('works', () => { expect(${fn}('1')).toBe('${fn}-1'); }); });`,
      ""
    ].join("\n")
  });
}

describe("autoProve — unified dynamic-proof budget (default 5)", () => {
  it("default budget attempts at most 5 targets even with >5 eligible gaps", async () => {
    const W = makeWorkspaceMulti(8); // 8 eligible behaviors
    const gen = fakeGenerate(MULTI_NAMES.map(fakeTestFor));
    const res = await autoProve(W, {}, baseDeps(KEY_ENV, { generate: gen, dynamicProofRunner: proofRunner("proven") }));

    expect(res.attempted).toBe(5); // capped at the default budget, not 8
    expect(res.attempted).toBeLessThanOrEqual(5);
  });

  it("--auto-limit 8 raises the unified budget to 8 attempts", async () => {
    const W = makeWorkspaceMulti(8);
    const gen = fakeGenerate(MULTI_NAMES.map(fakeTestFor));
    const res = await autoProve(W, { autoLimit: 8 }, baseDeps(KEY_ENV, { generate: gen, dynamicProofRunner: proofRunner("proven") }));

    expect(res.attempted).toBe(8);
  });

  it("existing + generation share ONE budget: existing consumes it, generation gets the remainder", async () => {
    const W = makeWorkspaceWithExistingTests(); // 2 hard-associated eligible symbols + a payment gap
    const genSpy = vi.fn(async (): Promise<GenerateResult> => ({ run: null, generated_tests: [fakePaymentTest()], missing_evidence: [], warnings: [] }));
    // Budget of 1: the existing-tests lane spends the whole budget on its first target;
    // generation must get 0 remaining budget and never be called → TOTAL attempts ≤ 1.
    const res = await autoProve(W, { autoLimit: 1 }, baseDeps(KEY_ENV, { generate: genSpy, dynamicProofRunner: proofRunner("proven") }));

    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(1);
    expect(genSpy).not.toHaveBeenCalled(); // generation lane got no budget
  });
});

describe("autoProve — trust guard: static Associated never becomes Dynamically Proven", () => {
  it("all attempts setup-blocked → proven 0, RTM proven 0, Associated tier preserved", async () => {
    const W = makeWorkspaceWithExistingTests();
    // Epistemic fix (Jul 17): lexical matches surface as the CANDIDATE tier
    // (associated requires a hard TestCase edge). The trust-guard intent is
    // unchanged: whatever static tier exists must never inflate proven.
    const before = opRtm(W, { format: "json" }).summary;
    const staticBefore = before.associated + before.candidate;
    expect(staticBefore).toBeGreaterThan(0);

    // Every baseline fails → every attempt is an honest non-proof, never proven.
    const res = await autoProve(W, {}, baseDeps(NO_ENV, { dynamicProofRunner: proofRunner("baseline_fail") }));

    expect(res.attempted).toBeGreaterThan(0); // the statically-linked tests WERE attempted
    expect(res.proven).toBe(0); // but none closed
    const after = opRtm(W, { format: "json" }).summary;
    expect(after.proven).toBe(0); // static signals did NOT inflate proven
    expect(after.associated + after.candidate).toBe(staticBefore); // breadth preserved
  });
});

describe("autoProve — links node_modules so dep-importing targets can boot", () => {
  it("passes link_node_modules:true to proveLoop (the isolated proof copy drops node_modules)", async () => {
    const W = makeWorkspace();
    const seen: Array<{ link_node_modules?: boolean }> = [];
    const spyProveLoop: typeof opProveLoop = (root, opts, d) => {
      seen.push(opts);
      return opProveLoop(root, opts, d);
    };
    await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fakeGenerate([fakeTest()]), dynamicProofRunner: proofRunner("proven"), proveLoop: spyProveLoop })
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((o) => o.link_node_modules === true)).toBe(true);
  });
});

/**
 * v5 track: opt-in `prompt_version:"v5"` must thread through autoProve into the KEY-GATED
 * generation lane's `generateTests` call, WITHOUT touching the default (v2) path or the
 * prove/mint gate. These tests exercise the wiring with a FAKE provider (no live LLM):
 *   - the flag reaches `generate` opts, and the DEFAULT omits it (stays v2);
 *   - driven through the REAL `generateTests`, the v5 batched two-phase path is TAKEN
 *     (planning → batch), the emitted test carries the `orangepro.local.testgen.v5`
 *     lineage tag, and it flows to the UNCHANGED prove oracle → Proven via the real cert.
 */
describe("autoProve — v5 track wiring (opt-in, fake provider)", () => {
  /** A spy over the generate dep that records the opts it was called with. */
  function spyGenerate(tests: GeneratedTest[]) {
    const calls: GenerateOptions[] = [];
    let called = false;
    const fn = vi.fn(async (_graph: LocalGraph, opts: GenerateOptions): Promise<GenerateResult> => {
      calls.push(opts);
      if (called) return { run: null, generated_tests: [], missing_evidence: [], warnings: [] };
      called = true;
      return { run: null, generated_tests: tests, missing_evidence: [], warnings: [] };
    });
    return { fn, calls };
  }

  it("10. prompt_version:'v5' threads into the generation lane's generate() opts", async () => {
    const W = makeWorkspace();
    const { fn, calls } = spyGenerate([fakeTest()]);
    await autoProve(
      W,
      { autoLimit: 1, prompt_version: "v5" },
      baseDeps(KEY_ENV, { generate: fn, dynamicProofRunner: proofRunner("proven") })
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((o) => o.prompt_version === "v5")).toBe(true);
  });

  it("11. DEFAULT (no flag) omits prompt_version → generation stays v2/deterministic", async () => {
    const W = makeWorkspace();
    const { fn, calls } = spyGenerate([fakeTest()]);
    await autoProve(
      W,
      { autoLimit: 1 },
      baseDeps(KEY_ENV, { generate: fn, dynamicProofRunner: proofRunner("proven") })
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((o) => o.prompt_version === undefined)).toBe(true);
  });

  it("12. end-to-end: the REAL v5 batched path is taken and its test flows to Proven", async () => {
    const W = makeWorkspace();
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);

    // Fake provider driving the REAL two-phase v5 branch: planning call → JSON scenario
    // array; batch call → a runnable vitest body importing the TS subject and asserting on
    // it (aligns with the scenario assertion_target "returns an order id"). No live LLM.
    const seen: ModelCompletionRequest[] = [];
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-autoprove",
      complete: async (req) => {
        seen.push(req);
        if (req.system.includes("test gap identification")) {
          return JSON.stringify([
            {
              id: 1,
              title: "returns an order id",
              concern: "contract",
              technique: "contract_verification",
              rationale: "contract risk",
              assertion_targets: ["returns an order id"],
              complexity: "basic",
              risk_rank: 1
            }
          ]);
        }
        // No import line: let the generator derive/synthesize the subject import from the
        // graph (resolver-relative), so it resolves from the generated test's location.
        return [
          "// ═══ SCENARIO 1 ═══",
          "describe('createOrder', () => {",
          "  it('returns an order id', () => {",
          "    expect(createOrder('42')).toBe('order-42');",
          "  });",
          "});"
        ].join("\n");
      }
    };

    // Bind the fake provider to the REAL generateTests so autoProve runs the true v5 branch
    // (the generation lane is key-gated; KEY_ENV supplies a stand-in key so it engages).
    const generate: typeof generateTests = (graph, opts, _provider, reader, clockArg) =>
      generateTests(graph, opts, provider, reader, clockArg);

    const res = await autoProve(
      W,
      { autoLimit: 1, prompt_version: "v5" },
      baseDeps(KEY_ENV, { generate, dynamicProofRunner: proofRunner("proven") })
    );

    // The v5 two-phase path actually ran: a planning prompt AND a batch prompt were issued
    // (these markers are unique to the v5 prompt builders — the v2 path never emits them).
    expect(seen.some((r) => r.system.includes("test gap identification"))).toBe(true);
    expect(seen.some((r) => r.system.includes("Never mock, stub, or spy on the behavior-under-test itself"))).toBe(true);

    // A generated test flowed to the UNCHANGED prove oracle and minted Proven via the cert.
    expect(res.ran).toBe(true);
    expect(res.attempted).toBe(1);
    expect(res.proven).toBe(1);
    expect(res.generated_files.length).toBe(1);
    expect(res.attempts[0].classification).toBe("proven");
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);

    // The generated file carries the v5 lineage tag — proof it was authored by the v5 path.
    const genRoot = loadGraph(workspacePaths(W).graphPath).workspace.root;
    const genBody = readFileSync(join(genRoot, res.generated_files[0]), "utf8");
    expect(genBody).toContain("createOrder");
  });
});
