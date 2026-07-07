#!/usr/bin/env node
// v5 track smoke — drive the auto-prove generate→prove loop with the OPT-IN v5 batched
// generation (`opro start --prompt-version v5`) against a tiny fixture repo, using a LIVE
// BYOK provider resolved from env. This is the FIRST committed exerciser of the live v5
// path from the `start`/auto-prove lane (v5 was previously reachable only via an explicit
// `generate --prompt-version v5`).
//
// Trust: the flag only changes WHICH tests are drafted. Proven is still minted solely by
// the UNCHANGED dynamic-proof oracle (baseline-green + null-sentinel mutant that fails an
// assertion). A v5 draft that does not genuinely kill the mutant is an honest skip.
//
// Modes:
//   (default, LIVE)  Requires a BYOK key (OPENAI_API_KEY | ANTHROPIC_API_KEY | OLLAMA_BASE_URL).
//                    No key => EXIT 2 with the exact env var to set. Never silently falls back.
//   --fake           Offline plumbing smoke: runs `start --prompt-version v5` with NO key to
//                    prove the flag is accepted by the CLI and `start` completes cleanly. The
//                    generation lane is key-gated, so it is honestly skipped (no live LLM to
//                    drive the v5 batch). The real end-to-end v5→Proven wiring (flag → real
//                    generateTests v5 branch → prove oracle) is proven by
//                    tests/local/autoProve.test.ts ("end-to-end: the REAL v5 batched path").
//
// Run LIVE:   OPENAI_API_KEY=sk-... node scripts/smoke-generate-prove-v5.mjs
//   (or)      ANTHROPIC_API_KEY=sk-ant-... node scripts/smoke-generate-prove-v5.mjs
//   (or)      OLLAMA_BASE_URL=http://localhost:11434 node scripts/smoke-generate-prove-v5.mjs
// Run FAKE:   node scripts/smoke-generate-prove-v5.mjs --fake
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist/local/cli.js");

if (!existsSync(cli)) {
  console.error("dist/local/cli.js not found. Run `npm run build` first.");
  process.exit(1);
}

const FAKE = process.argv.includes("--fake");

// LIVE mode fails CLEARLY (never silently v2/deterministic) when no BYOK key is present.
function requireLiveKey(env) {
  const hasKey = env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.OLLAMA_BASE_URL;
  if (hasKey) return;
  console.error(
    [
      "No BYOK provider key found — the LIVE v5 smoke cannot run without a real model.",
      "Set ONE of these env vars and re-run (or pass --fake for the offline plumbing smoke):",
      "  OPENAI_API_KEY=sk-...            (optional OPENAI_MODEL, OPENAI_BASE_URL)",
      "  ANTHROPIC_API_KEY=sk-ant-...     (optional ANTHROPIC_MODEL, ANTHROPIC_BASE_URL)",
      "  OLLAMA_BASE_URL=http://localhost:11434   (optional OLLAMA_MODEL)"
    ].join("\n")
  );
  process.exit(2);
}

function run(args, opts = {}) {
  return execFileSync("node", [cli, ...args], { encoding: "utf8", ...opts });
}
function runJson(cwd, args, env) {
  return JSON.parse(run([...args, "--json"], { cwd, env }));
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Tiny provable fixture: a single entry-point-adjacent TS behavior with a real return value
// the null-sentinel mutant can flip. Mirrors the offline e2e fixture.
function writeFixture(root) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "opro-generate-prove-v5", version: "1.0.0", type: "module", devDependencies: { vitest: "^2.0.0" } }, null, 2),
    "utf8"
  );
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(
    join(root, "service.ts"),
    ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
    "utf8"
  );
}

const childEnv = { ...process.env };
if (FAKE) {
  // Offline determinism: strip provider keys so nothing reaches the network, and force the
  // deterministic stand-in via --provider deterministic below.
  for (const k of Object.keys(childEnv)) {
    if (/_API_KEY$|_API_BASE_URL$|_BASE_URL$|ANTHROPIC_|OPENAI_|OLLAMA_/i.test(k)) delete childEnv[k];
  }
} else {
  requireLiveKey(childEnv);
}

const temp = mkdtempSync(join(tmpdir(), "opro-gen-prove-v5-"));
const source = join(temp, "repo");
const ws = join(temp, "workspace");
mkdirSync(source);
mkdirSync(ws);

try {
  writeFixture(source);

  // Baseline: public Proven must start at 0.
  runJson(ws, ["analyze", source, "--no-graph-html"], childEnv);
  const before = runJson(ws, ["rtm", "--format", "json"], childEnv);
  if (before.summary.proven !== 0) fail(`baseline summary.proven should be 0, got ${before.summary.proven}`);

  // Drive `opro start --prompt-version v5`. --no-ai / --no-ai-flows isolate the auto-prove
  // generation lane (the thing under test) from the weak-link / candidate-flow passes.
  const startArgs = ["start", source, "--no-ai", "--no-ai-flows", "--auto-limit", "3", "--prompt-version", "v5"];
  const res = runJson(ws, startArgs, childEnv);

  const ap = res.auto_prove;
  if (!ap) fail("start result carried no auto_prove summary");

  if (FAKE) {
    // Plumbing-only: `--prompt-version v5` was accepted and `start` produced a valid result.
    // The generation lane is key-gated, so with no key it is honestly skipped (status
    // "skipped-no-key") — no live LLM to drive the v5 batch here. The real v5 branch wiring
    // is proven by tests/local/autoProve.test.ts.
    if (typeof ap.attempted !== "number") fail("auto_prove.attempted missing in --fake run");
    if (ap.status !== "skipped-no-key") {
      fail(`--fake run expected auto_prove.status=skipped-no-key (no key), got ${ap.status}`);
    }
    console.log(
      JSON.stringify(
        { mode: "fake", prompt_version: "v5", auto_prove_status: ap.status, attempted: ap.attempted, proven: ap.proven, note: "flag accepted + start completed; generation lane key-gated. Real v5→Proven wiring proven by autoProve.test.ts" },
        null,
        2
      )
    );
    console.log("v5 plumbing smoke OK: --prompt-version v5 accepted; start completed (generation lane needs a BYOK key).");
    process.exit(0);
  }

  // LIVE mode: assert the auto-prove lane actually ran with a real provider. A live model
  // SHOULD author a killing test for this trivial target and mint Proven; we assert it ran
  // and report the Proven delta (a model that fails to kill is an honest 0, not a crash).
  if (!ap.ran) fail(`LIVE v5 auto-prove did not run: status=${ap.status} reason=${ap.reason ?? ""}`);
  const after = runJson(ws, ["rtm", "--format", "json"], childEnv);
  console.log(
    JSON.stringify(
      {
        mode: "live",
        prompt_version: "v5",
        auto_prove_status: ap.status,
        attempted: ap.attempted,
        proven: ap.proven,
        generated_files: ap.generated_files,
        public_proven_before: before.summary.proven,
        public_proven_after: after.summary.proven
      },
      null,
      2
    )
  );
  if (after.summary.proven < 1) {
    console.warn(
      "WARN: LIVE v5 ran but minted 0 Proven for this fixture. The model did not author a killing test; " +
        "this is an honest non-proof, not a wiring failure. Inspect ap.attempts / warnings above."
    );
  } else {
    console.log(`Public Proven via LIVE v5: ${before.summary.proven} → ${after.summary.proven}.`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
