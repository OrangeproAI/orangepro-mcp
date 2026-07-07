#!/usr/bin/env node
// DB-2 + DB-3 — deterministic, OFFLINE end-to-end DB-backed proof demo + regression guard.
//
// Runs the full public-Proven loop for a DB-backed NestJS service against the REAL
// dynamic-proof oracle (no network, no model key): analyze → `opro recipe db-sqljs`
// (writes a REAL sqljs integration spec + setup profile) → `opro prove-loop` (genuine
// inert sentinel) → RTM. Then the DB-3 equivalent-survives guard.
//
// Win conditions + guards asserted here (exit 1 on any failure):
//   1. Public Proven grows 0 → 1 ONLY after the real dynamic kill of a DB-backed service.
//   2. DB-3: the EQUIVALENT (behavior-preserving) mutation SURVIVES → non-Proven, and does
//      NOT clobber the prior Proven. falseProofCount stays 0.
//   3. The recipe never mocks the target; the certificate is metadata-only.
//
// The recipe only makes the baseline RUNNABLE. Proven still flows solely from the unchanged
// oracle (baseline-green + credited target mutated + same test fails at a trusted assertion +
// target not mocked → metadata-only ledger cert).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist/local/cli.js");
const fixture = join(repoRoot, "tests/local/__fixtures__/db-sqljs-nest");

if (!existsSync(cli)) {
  console.error("dist/local/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(join(repoRoot, "node_modules/sql.js")) || !existsSync(join(repoRoot, "node_modules/@nestjs/testing"))) {
  console.error("db-sqljs smoke requires devDeps installed (sql.js, @nestjs/testing, typeorm, unplugin-swc). Run `npm install`.");
  process.exit(1);
}

const TARGET = "sym:src/tag.service.ts#TagService.findAll";
const ENTITY = "src/tag.entity.ts#Tag";
const SPEC_OUT = "orangepro_generated/tag-service.find-all.sqljs.spec.ts";

// Offline determinism: strip any provider keys so nothing can reach the network.
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
function provenOf(cwd) {
  return runJson(cwd, ["rtm", "--format", "json"]).summary.proven;
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const temp = mkdtempSync(join(tmpdir(), "opro-db-sqljs-"));
const source = join(temp, "repo");
const ws = join(temp, "workspace");
mkdirSync(ws);

try {
  // Copy the checked-in fixture to a disposable source, symlink node_modules so the
  // isolated proof copy (link-node-modules) sees the installed Nest/TypeORM/sql.js.
  cpSync(fixture, source, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(source, "node_modules"), "dir");

  // 1) analyze → baseline Proven must be 0.
  runJson(ws, ["analyze", source, "--no-graph-html"]);
  const provenBefore = provenOf(ws);
  if (provenBefore !== 0) fail(`baseline Proven should be 0, got ${provenBefore}`);

  // 2) recipe db-sqljs → writes the sqljs spec + emits the exact setup profile.
  const recipe = runJson(ws, [
    "recipe",
    "db-sqljs",
    "--target-symbol",
    TARGET,
    "--entity",
    ENTITY,
    "--out",
    SPEC_OUT,
    "--source",
    source
  ]);
  if (recipe.profile.id !== "typeorm-sqljs-nest") fail(`unexpected profile id ${recipe.profile.id}`);
  if (recipe.profile.confidence !== "exact") fail(`expected exact profile (sql.js present), got ${recipe.profile.confidence}`);
  const specAbs = join(source, SPEC_OUT);
  if (!existsSync(specAbs)) fail("recipe did not write the spec");
  const specSource = readFileSync(specAbs, "utf8");
  // Never imports/mocks/replaces the target service; boots a real Nest module.
  if (/\b(vi|jest)\.mock\b/.test(specSource) || /mockImplementation|mockReturnValue/.test(specSource)) {
    fail("generated spec mocks something (recipe must never mock the target service)");
  }
  if (!specSource.includes("providers: [TagService]") || !specSource.includes("service.findAll()")) {
    fail("generated spec does not boot the real Nest module / call the target for real");
  }

  // 3) prove-loop with the GENUINE inert sentinel → the unchanged oracle closes Proven.
  const genuine = runJson(ws, [
    "prove-loop",
    "--target-symbol",
    TARGET,
    "--source",
    source,
    "--test",
    SPEC_OUT,
    "--replacement",
    recipe.genuine_mutation.replacement,
    "--runner",
    "vitest",
    "--link-node-modules",
    "--run-id",
    "db-sqljs-genuine"
  ]);
  if (genuine.status === "unrunnable") fail(`genuine prove-loop unrunnable: ${genuine.reason}`);
  if (genuine.record.status !== "reproven" || genuine.record.closed !== true) {
    fail(`genuine mutation did not close: status=${genuine.record.status} closed=${genuine.record.closed}`);
  }

  // 4) Public Proven grew 0 → 1 for the DB-backed service.
  const provenAfterGenuine = provenOf(ws);
  if (provenAfterGenuine !== 1) fail(`public Proven should be 1 after the dynamic kill, got ${provenAfterGenuine}`);

  // 5) DB-3 equivalent-survives: a behavior-preserving mutation (returns the asserted
  //    contract verbatim) must SURVIVE — non-Proven — and must NOT clobber the prior Proven.
  const equivalent = runJson(ws, [
    "prove-loop",
    "--target-symbol",
    TARGET,
    "--source",
    source,
    "--test",
    SPEC_OUT,
    "--replacement",
    recipe.equivalent_mutation.replacement,
    "--runner",
    "vitest",
    "--link-node-modules",
    "--run-id",
    "db-sqljs-equivalent"
  ]);
  if (equivalent.status === "unrunnable") fail(`equivalent prove-loop unrunnable: ${equivalent.reason}`);
  const equivalentStatus = equivalent.oracle.status;
  if (equivalent.record.closed !== false || equivalent.oracle.proven !== false) {
    fail(`DO NOT MERGE: equivalent mutation proved (closed=${equivalent.record.closed} proven=${equivalent.oracle.proven})`);
  }
  if (equivalentStatus !== "associated_survived") {
    fail(`equivalent mutation should survive (associated_survived), got ${equivalentStatus}`);
  }
  const falseProofCount = equivalent.record.closed ? 1 : 0;
  if (falseProofCount !== 0) fail(`falseProofCount must be 0, got ${falseProofCount}`);

  // Non-clobber: prior Proven survives the later unproven record (#162 fingerprint-scoped RTM).
  const provenAfterEquivalent = provenOf(ws);
  if (provenAfterEquivalent !== 1) fail(`equivalent-survives clobbered Proven (${provenAfterEquivalent} != 1)`);

  // 6) METADATA-ONLY cert guard.
  const cert = genuine.record.dynamic_proof;
  if (!cert) fail("genuine proof record has no certificate");
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
  if (genuine.record.new_edges.length !== 0) fail("dynamic proof record should carry no graph edges");

  console.log(
    JSON.stringify(
      {
        target: TARGET,
        recipe: recipe.spec_rel,
        setup_profile: recipe.profile.id,
        setup_confidence: recipe.profile.confidence,
        proven_before: provenBefore,
        genuine_status: genuine.oracle.status,
        proven_after_genuine: provenAfterGenuine,
        db_recipe_proofs: 1,
        equivalent_status: equivalentStatus,
        equivalent_closed: equivalent.record.closed,
        proven_after_equivalent: provenAfterEquivalent,
        false_proof_count: falseProofCount,
        needs_setup: 0,
        certificate_metadata_only: true
      },
      null,
      2
    )
  );
  console.log(`Public Proven delta: ${provenBefore} → ${provenAfterGenuine} (DB-backed sqljs recipe); equivalent SURVIVED, falseProofCount ${falseProofCount}.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
