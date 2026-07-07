#!/usr/bin/env node
// Slice 7a — deterministic, OFFLINE end-to-end generate→prove demo + regression guard.
//
// Runs the full public-Proven loop against the REAL dynamic-proof oracle (no network,
// no live model): analyze → generate (deterministic provider) → write a runnable test to
// the generated suggested_path → static record_run → dynamic prove → RTM.
//
// Win condition + guards asserted here (exit 1 on any failure):
//   1. Public Proven grows 0 → 1 ONLY after the real dynamic kill.
//   2. Static record_run alone does NOT move public Proven (adds an Associated signal, not Proven).
//   3. The dynamic-proof certificate is metadata-only — no raw test source, no failure-message bodies.
//
// The deterministic offline provider emits only a trivially-passing skeleton (runnable:false — it
// cannot author a genuinely-killing assertion), so the loop drives the REAL generation handoff
// (target symbol + the kit's own suggested_path) and then writes an authored killing test to that
// suggested_path, running it through the real write→run→orangepro_prove path. No proof semantics
// are weakened: prove still requires baseline-green AND a null-sentinel mutant that fails an assertion.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { suggestedTestPath } from "../dist/local/generate/runHints.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist/local/cli.js");

if (!existsSync(cli)) {
  console.error("dist/local/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}

// Unique markers proving the metadata-only guard: neither the raw test source (comment)
// nor the assertion failure message may ever land in the ledger/cert.
const RAW_SOURCE_MARKER = "OPRO_SMOKE_RAW_TEST_SOURCE_MARKER_7a";
const FAILURE_MSG_MARKER = "OPRO_SMOKE_ASSERTION_FAILURE_MESSAGE_7a";

// Offline determinism: strip any provider keys so nothing can reach the network, and
// force the deterministic stand-in. Mirrors the empty-env contract the other smokes use.
const childEnv = { ...process.env };
for (const k of Object.keys(childEnv)) {
  if (/_API_KEY$|_API_BASE_URL$|ANTHROPIC_|OPENAI_/i.test(k)) delete childEnv[k];
}

function run(args, opts = {}) {
  return execFileSync("node", [cli, ...args], { encoding: "utf8", env: childEnv, ...opts });
}
function runJson(cwd, args) {
  return JSON.parse(run([...args, "--json"], { cwd }));
}
function rowFor(rtm, id) {
  return rtm.rows.find((row) => row.behavior_id === id);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function writeFixture(root) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "opro-generate-prove-e2e", version: "1.0.0", type: "module" }, null, 2),
    "utf8"
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "service.ts"),
    [
      "export class OrderService {",
      "  createOrder(id: string): string {",
      "    return `order-${id}`;",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

// Authored KILLING test written to the generated suggested_path. `subjectImport` is the
// relative path back to service.ts from wherever the kit suggested placing the test.
// Passes on baseline; the null-sentinel mutant (return null;) fails the toBe assertion.
// Markers let us prove the cert stays metadata-only.
function killingTest(subjectImport) {
  return [
    "import { describe, expect, it } from 'vitest';",
    `import { OrderService } from '${subjectImport}';`,
    `// ${RAW_SOURCE_MARKER}`,
    "",
    "describe('OrderService', () => {",
    "  it('creates observable order ids', () => {",
    "    const actual = new OrderService().createOrder('42');",
    `    expect(actual, '${FAILURE_MSG_MARKER}').toBe('order-42');`,
    "  });",
    "});",
    ""
  ].join("\n");
}

const temp = mkdtempSync(join(tmpdir(), "opro-gen-prove-e2e-"));
const source = join(temp, "repo");
const ws = join(temp, "workspace");
mkdirSync(source);
mkdirSync(ws);

try {
  writeFixture(source);

  // 1) analyze
  runJson(ws, ["analyze", source, "--no-graph-html"]);
  const target = "sym:service.ts#OrderService.createOrder";

  // Baseline RTM: public Proven must be 0 for the target.
  const before = runJson(ws, ["rtm", "--format", "json"]);
  const beforeRow = rowFor(before, target);
  const provenBefore = before.summary.proven;
  if (provenBefore !== 0) fail(`baseline summary.proven should be 0, got ${provenBefore}`);
  if (beforeRow?.evidence_tier === "proven") fail("baseline target row should not be proven");

  // 2) generate via the REAL deterministic path — confirm it targets our symbol and take
  //    the kit's own suggested_path for the draft (the offline draft is a runnable:false
  //    skeleton; the agent fills it in — which is what step 3 does).
  const generated = runJson(ws, [
    "generate",
    "--single",
    "--provider",
    "deterministic",
    "--target",
    target,
    "--limit",
    "1"
  ]);
  const draft = (generated.generated_tests ?? [])[0];
  if (!draft || draft.target_symbol_external_id !== target) {
    fail("generation produced no draft targeting the requested symbol");
  }
  const suggestedPath = suggestedTestPath(draft, 0);

  // 3) Agent writes the runnable (killing) test to the generated suggested_path.
  const testAbs = join(source, suggestedPath);
  mkdirSync(dirname(testAbs), { recursive: true });
  let subjectImport = relative(dirname(testAbs), join(source, "service")).split(sep).join("/");
  if (!subjectImport.startsWith(".")) subjectImport = `./${subjectImport}`;
  writeFileSync(testAbs, killingTest(subjectImport), "utf8");

  // 4) STATIC guard — record_run must NOT move public Proven.
  runJson(ws, [
    "record",
    "--target-symbol",
    target,
    "--source",
    source,
    "--test",
    suggestedPath,
    "--run-id",
    "e2e-static-record"
  ]);
  const afterStatic = runJson(ws, ["rtm", "--format", "json"]);
  const provenAfterStatic = afterStatic.summary.proven;
  const staticRow = rowFor(afterStatic, target);
  if (provenAfterStatic !== 0) fail(`static record_run moved public Proven to ${provenAfterStatic} (must stay 0)`);
  if (staticRow?.evidence_tier === "proven") fail("static record_run marked the target row proven (must not)");

  // 5) DYNAMIC prove — the same handoff the generator's prove_run emits: null-sentinel mutant.
  const proof = runJson(ws, [
    "prove",
    "--target-symbol",
    target,
    "--source",
    source,
    "--test",
    suggestedPath,
    "--replacement",
    "return null;",
    "--runner",
    "vitest",
    "--link-node-modules",
    "--run-id",
    "e2e-dynamic-prove"
  ]);
  if (proof.record.status !== "reproven" || proof.record.closed !== true) {
    fail(`dynamic proof did not close: status=${proof.record.status} closed=${proof.record.closed}`);
  }

  // 6) WIN: public Proven grew 0 → 1 for the credited symbol.
  const after = runJson(ws, ["rtm", "--format", "json"]);
  const afterRow = rowFor(after, target);
  const provenAfter = after.summary.proven;
  if (provenAfter !== 1) fail(`public Proven should be 1 after the dynamic kill, got ${provenAfter}`);
  if (afterRow?.evidence_tier !== "proven" || afterRow?.status !== "Reproven (this run)") {
    fail(`target row not proven after dynamic kill: tier=${afterRow?.evidence_tier} status=${afterRow?.status}`);
  }

  // 7) METADATA-ONLY guard: cert carries only metadata; no raw source, no failure bodies.
  const ledgerText = readFileSync(proof.ledger_path, "utf8");
  if (ledgerText.includes(RAW_SOURCE_MARKER)) fail("ledger leaked raw test source");
  if (ledgerText.includes(FAILURE_MSG_MARKER)) fail("ledger leaked an assertion failure message body");
  const cert = proof.record.dynamic_proof;
  if (!cert) fail("dynamic proof record has no certificate");
  const allowed = new Set([
    "proof_kind",
    "baseline_green",
    "mutant_failed_assertion",
    "target_not_mocked",
    "sentinel",
    "runner",
    "test_path",
    "mutant_status"
  ]);
  const extra = Object.keys(cert).filter((k) => !allowed.has(k));
  if (extra.length) fail(`certificate carries non-metadata fields: ${extra.join(", ")}`);
  if (proof.record.new_edges.length !== 0) fail("dynamic proof record should carry no graph edges");

  console.log(
    JSON.stringify(
      {
        target,
        baseline_status: beforeRow?.status,
        generated_draft_targets_symbol: true,
        suggested_path: suggestedPath,
        proven_before: provenBefore,
        proven_after_static_record: provenAfterStatic,
        static_record_status: staticRow?.status,
        proof_status: proof.record.status,
        proof_closed: proof.record.closed,
        proven_after_dynamic: provenAfter,
        final_status: afterRow?.status,
        certificate_metadata_only: true
      },
      null,
      2
    )
  );
  console.log(`Public Proven delta: ${provenBefore} → ${provenAfter} (static record_run held at ${provenAfterStatic}).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
