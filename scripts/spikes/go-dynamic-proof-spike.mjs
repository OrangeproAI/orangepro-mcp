#!/usr/bin/env node
// go-dynamic-proof-spike.mjs — Go dynamic-proof MECHANISM (G-1).
//
// Proves ONE free function or receiver method 0->1 on a single Go module by
// mutation: it byte-copies
// the module into a hermetic sandbox, runs `go test -json` baseline, replaces the
// target function body with a signature-derived sentinel (via go-mutate.go), reruns
// the SAME test, and classifies. It emits a JSON verdict mirroring the TS/JS spike's
// shape: { status: "proven" | "associated_survived" | "unrunnable", ... }.
//
// TRUST: no false Proven. Both `go test` runs are scoped to the TARGET's PACKAGE
// ONLY (the directory of --target, `./<dir>` — never `./...`), so a same-named
// test in another package can never be credited to this target. `proven` requires
// (0) --test-run binds to EXACTLY ONE target test — a fully anchored plain literal
// `^TestName$` (broad/regex patterns that could match >1 test are rejected
// upfront), (a) baseline builds AND that
// target test PASSES, (b) the mutant builds, (c) the SAME target test FAILS, (d)
// the failure is TEST-LEVEL — a `fail` Action on the target test that is NOT a
// build error and NOT a panic, AND (e) it fails at a GENUINE value ASSERTION by
// SOURCE-LINE BINDING — the failing frame's `file:line` (Go's `\t<file>:<line>:`
// or testify's `Error Trace:`) is read back in the test SOURCE and must be a real
// assertion call (`t.Error`/`t.Errorf`, or testify `assert.`/`require.`), NOT a
// `t.Fatal`/`t.Fatalf`/`t.FailNow`/`t.SkipNow` hard-stop or a helper call. A build
// error, a panic, a t.Fatal precondition, a setup/helper failure, an unbindable
// failure, and an ambiguous or no-return name all classify as `unrunnable`,
// never `proven`. An equivalent-value mutation survives -> `associated_survived`.
//
// This is a spike harness only: it writes no graph edges or product artifacts and is
// NOT wired into autoProve / cert / RTM / the mint path. Use only on trusted checkouts
// for local measurement.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 60_000;

function usage() {
  return [
    "Usage: node scripts/spikes/go-dynamic-proof-spike.mjs --root <module> --test-run <^TestName$> --target <rel.go> --func <name> [--json]",
    "",
    "Runs a Go baseline test, mutates the target free function or method body in an isolated byte-copy, reruns the same test, and classifies the result.",
    "--test-run is passed verbatim to `go test -run` and should anchor a single test, e.g. '^TestCompute$'.",
    "--recv <T> (optional): receiver base type — mutate only `func (x T) <name>` / `func (x *T) <name>`, so a same-named method on another receiver (or a free function) can never be the mutation target.",
    "--go-assertion-line <n> (optional): 1-based test-source line of the target's assertion. When set, the mutant's failure must bind to a frame at EXACTLY that line and subtest frames are considered — so a runtime-named subtest can prove while a sibling asserting elsewhere is refused.",
    "Scope: free functions and receiver methods whose name is unique in the target file (collisions and generic receivers are refused). Equivalent-value mutations survive (associated_survived).",
    "This is a spike harness only; it does not write graph edges or product artifacts and is not wired into prove/RTM/mint."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { json: false, mode: "sentinel" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    args[key] = value;
    i += 1;
  }
  for (const required of ["root", "testRun", "target", "func"]) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw new Error(`Missing required --${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
    }
  }
  if (args.mode !== "sentinel" && args.mode !== "equivalent") {
    throw new Error("--mode must be sentinel or equivalent");
  }
  return args;
}

function parseTimeoutMs(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return parsed;
}

// Slice 2 (OPTIONAL): 1-based test-source line of the assertion that witnesses the target.
// When set, the mutant's failure must bind to a frame at EXACTLY this line, and output is
// collected from the target test AND its subtests (so a runtime-named subtest counts). When
// absent (undefined), behavior is UNCHANGED: exact `e.Test === name`, any-assertion line.
function parseAssertionLine(value) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--go-assertion-line must be a positive integer");
  }
  return parsed;
}

function isSecretEnvKey(key) {
  return /TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION/i.test(key);
}

function resolveInside(root, relOrAbs) {
  const resolved = path.resolve(root, relOrAbs);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${relOrAbs}`);
  }
  return resolved;
}

// Byte-copy the module into a temp sandbox. Never follow symlinks (a source-repo
// symlink must not leak an outside dir into the sandbox); exclude .git and
// .orangepro. node_modules is a JS concept and irrelevant to Go, but excluded for
// symmetry/safety. Local source is copied, never writable-symlinked.
function copyModuleRoot(root, label) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), `opro-go-proof-${label}-`));
  const repoRoot = path.join(tmpRoot, "module");
  cpSync(root, repoRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      if (source !== root && lstatSync(source).isSymbolicLink()) {
        return false;
      }
      return name !== "node_modules" && name !== ".git" && name !== ".orangepro";
    }
  });
  return { tmpRoot, repoRoot };
}

// Resolve the developer's EXISTING Go module cache so the sandbox module can
// resolve deps it already downloaded (a real `opro` user has built the repo).
// `go env GOMODCACHE` is canonical; fall back to $GOMODCACHE then $HOME/go/pkg/mod.
// Result is cached (queried once). Returns null if nothing resolvable exists, in
// which case we degrade to a per-run empty cache (self-contained fixtures with no
// external deps still build). The cache is used READ-ONLY: with GOPROXY=off +
// -mod=readonly (below) `go` never downloads and so never writes to it — a missing
// dep errors out instead of mutating the cache.
let cachedModCache;
function resolveModCache() {
  if (cachedModCache !== undefined) {
    return cachedModCache;
  }
  let dir = "";
  try {
    const r = spawnSync(goBin(), ["env", "GOMODCACHE"], { encoding: "utf8" });
    if ((r.status ?? 1) === 0) {
      dir = String(r.stdout ?? "").trim();
    }
  } catch {
    dir = "";
  }
  if (!dir) {
    dir = process.env.GOMODCACHE || (process.env.HOME ? path.join(process.env.HOME, "go", "pkg", "mod") : "");
  }
  cachedModCache = dir && existsSync(dir) ? dir : null;
  return cachedModCache;
}

// A per-run hermetic GOCACHE inside the sandbox tmp dir, plus a sanitized allowlist
// env. The module cache (GOMODCACHE) is the developer's EXISTING read-only cache so
// a real repo's already-downloaded deps resolve; with GOPROXY=off + -mod=readonly
// nothing writes to that cache or mutates go.mod/go.sum. No ambient secrets are
// forwarded to `go test`: only a fixed set of process-control vars is passed, and
// any secret-looking key is stripped defensively. This keeps proofs deterministic
// and prevents credentials from reaching repo test code.
function hermeticEnv(cacheRoot) {
  const gocache = path.join(cacheRoot, "gocache");
  mkdirSync(gocache, { recursive: true });
  // Reuse the developer's read-only module cache; degrade to a per-run empty one
  // (used only by self-contained fixtures) when none is resolvable.
  let gomodcache = resolveModCache();
  if (!gomodcache) {
    gomodcache = path.join(cacheRoot, "gomodcache");
    mkdirSync(gomodcache, { recursive: true });
  }
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GOCACHE: gocache,
    GOMODCACHE: gomodcache,
    // -mod=readonly: never mutate the module or download into the reused cache.
    GOFLAGS: "-mod=readonly",
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GONOSUMCHECK: "1",
    GOFLAGS_TEST: "",
    CGO_ENABLED: "0",
    CI: "1",
    NO_COLOR: "1"
  };
  // GOPATH is derived from HOME by default; keep it explicit and inside the sandbox
  // so nothing writes to the developer's real GOPATH.
  env.GOPATH = path.join(cacheRoot, "gopath");
  mkdirSync(env.GOPATH, { recursive: true });
  for (const key of Object.keys(env)) {
    if (isSecretEnvKey(key)) {
      delete env[key];
    }
  }
  return env;
}

function goBin() {
  return process.env.OPRO_GO_BIN || "go";
}

function runGoTest({ repoRoot, testRun, timeoutMs, cacheRoot, pkgPath }) {
  const started = performance.now();
  // TRUST (cross-package): scope BOTH runs to the TARGET's package ONLY, never
  // `./...`. Go's `-run '^TestName$'` matches by name, so a same-named test in
  // ANOTHER package could fail the mutant and be miscredited to the target. A
  // single-package path (`./<dir>` — no `...`) makes `-run` reach only the target
  // package's tests. `pkgPath` is derived from --target's directory.
  const result = spawnSync(goBin(), ["test", "-json", "-count=1", "-run", testRun, pkgPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: hermeticEnv(cacheRoot),
    maxBuffer: 32 * 1024 * 1024
  });
  const elapsedMs = Math.round(performance.now() - started);
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    events: parseTestEvents(result.stdout ?? ""),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs
  };
}

// go test -json emits one JSON object per line. Non-JSON lines (rare, e.g. a raw
// panic before the framework starts) are ignored here and surface via the raw
// `hadBuildFailure` / stderr signals instead.
function parseTestEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed line
    }
  }
  return events;
}

// Resolve --test-run to EXACTLY ONE target test name, or null if the pattern is
// broad/ambiguous. TRUST: a broad pattern (e.g. `TestCompute`, `^Test`, or any
// regex metacharacter) could match more than one test, and Go's `-run` treats an
// unanchored value as a substring match. So we accept ONLY a fully anchored plain
// literal `^Name$` (optionally a subtest path `^Outer$/^Inner$`): both `^` and `$`
// present, and the body containing only `[A-Za-z0-9_]` plus the `$/^` subtest
// joiner — nothing that Go's regexp could expand to a second test. Anything else
// (no anchors, partial anchors, `.`, `*`, `|`, `()`, `[]`, `?`, `+`, etc.) → null,
// which the classifier rejects as unrunnable. Never match-any.
function targetTestName(testRun) {
  const trimmed = testRun.trim();
  // Fully anchored: ^...$  — reject if either anchor is missing.
  if (!trimmed.startsWith("^") || !trimmed.endsWith("$")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  // The inner literal may only contain identifier chars, optionally split into a
  // subtest path by the anchored joiner `$/^` (e.g. `^TestA$/^sub$` → `TestA/sub`).
  // Any other regexp metacharacter makes the match potentially non-unique → reject.
  const segments = inner.split("$/^");
  if (segments.some(seg => seg.length === 0 || !/^[A-Za-z0-9_]+$/.test(seg))) {
    return null;
  }
  return segments.join("/");
}

function hasBuildFailure(run) {
  return run.events.some(e => e.Action === "build-fail")
    || run.events.some(e => e.Action === "fail" && typeof e.FailedBuild === "string");
}

// All target-test predicates require a CONCRETE exact name and match ONLY that
// test. A null name (broad/ambiguous --test-run) is rejected upfront by classify,
// so these never fall back to match-any — a null name yields false everywhere.
function targetTestPassed(run, name) {
  return Boolean(name) && run.events.some(e => e.Action === "pass" && e.Test === name);
}

function targetTestFailed(run, name) {
  return Boolean(name) && run.events.some(e => e.Action === "fail" && e.Test === name);
}

// A panic aborts the test with a `fail` action on the target test just like an
// assertion does, so we must inspect the target test's output lines for a panic
// marker and reject it (a panic is NOT a trusted assertion signal).
function targetTestPanicked(run, name, includeChildren = false) {
  if (!name) {
    return false;
  }
  const prefix = name + "/";
  return run.events.some(e =>
    e.Action === "output"
    && typeof e.Output === "string"
    && (e.Test === name || (includeChildren && typeof e.Test === "string" && e.Test.startsWith(prefix)))
    && /^panic:|\bpanic:\s|\[signal SIGSEGV/.test(e.Output));
}

// Collect the target test's output lines (in order) so FIX 2 can inspect the
// failure shape for a TRUSTED assertion signal.
function targetTestOutput(run, name, includeChildren = false) {
  if (!name) {
    return [];
  }
  // Default: EXACT match only (unchanged). With `includeChildren` (Slice 2, line-gated),
  // also collect the target test's SUBTESTS (`TestX/...`) so a runtime-named child's
  // assertion frame is visible — the exact-line gate then rejects a sibling's frame.
  const prefix = name + "/";
  return run.events
    .filter(e => e.Action === "output" && typeof e.Output === "string"
      && (e.Test === name || (includeChildren && typeof e.Test === "string" && e.Test.startsWith(prefix))))
    .map(e => e.Output);
}

// FIX 2 — the mutant's failure for the EXACT target test must fail at a GENUINE
// value ASSERTION in the test SOURCE, not a t.Fatal precondition, a setup/helper
// failure, or an unrecognized error shape. This is SOURCE-LINE BINDING, mirroring
// the TS/JS gate's `isAssertionFailure` (parse the failing frame's file:line, read
// the test source at that line, require a real assertion call there). It replaces
// the earlier TEXT heuristic, which Codex reproduced a false-Proven against: a
// mutant-triggered `t.Fatalf("got %v, want %v", got, want)` carries "got/want"
// text but is a hard-stop precondition, not a value assertion of the target.
//
// Go prints the failing frame as `\t<file>:<line>: <message>` and, for testify,
// an `Error Trace:\t<file>:<line>` frame. The reported <line> is the SOURCE line
// of the assertion/Fatal CALL (Go's t.Helper() re-attributes a helper failure to
// the CALLER line — so a helper failure binds to the helper-call line, which is
// not an assertion, and is rejected). We read the copied test source at that line
// and require a genuine assertion: `t.Error(`/`t.Errorf(` (stdlib) or a testify
// `assert.`/`require.` call. We REJECT `t.Fatal(`/`t.Fatalf(`/`t.FailNow(`/
// `t.SkipNow(` and any line that is a helper call rather than an assertion.
//
// Fail CLOSED: if we cannot bind the failure to a genuine-assertion source line
// (no parseable frame, unreadable source, or the bound line is a Fatal/helper),
// this returns false and the classifier calls it unrunnable — never Proven.

// A genuine value-assertion call: stdlib t.Error/t.Errorf, or a testify
// assert.*/require.* call. A Fatal/FailNow/Skip hard-stop and a plain helper call
// do NOT match. Anchored to the assertion so `t.Fatalf` cannot pass as `t.Error`.
const GO_ASSERTION_LINE = /\bt\.Errorf?\s*\(|\b(?:assert|require)\.[A-Za-z]\w*\s*\(/;
// Explicit hard-stop reject list. These abort the test as a PRECONDITION, not a
// value assertion of the target, so a line bound to one is never trusted.
const GO_HARD_STOP_LINE = /\bt\.(?:Fatal|Fatalf|FailNow|SkipNow)\s*\(/;

// Parse Go per-line failure frames from the target test's output. Both the stdlib
// `\t<file>:<line>: <msg>` line and testify's `Error Trace:\t<file>:<line>` frame
// carry a basename + line. Return { file, line } for every frame, in order.
function parseGoFailFrames(lines) {
  const frames = [];
  for (const raw of lines) {
    for (const segment of String(raw).split(/\r?\n/)) {
      // Go stdlib prints `\t<file>:<line>: <msg>` (trailing colon); testify's
      // `Error Trace:\t<file>:<line>` has none — so the trailing `:` is optional.
      const match = /(?:^|\bError Trace:\s*)\s*([^\s:]+\.go):(\d+)(?::|\b)/.exec(segment);
      if (match) {
        frames.push({ file: match[1], line: Number(match[2]) });
      }
    }
  }
  return frames;
}

// Read the copied test SOURCE at `line` and decide if it is a genuine assertion.
// Bind to the EXACT reported line (Go reports the call-start line, even for a
// multi-line call), and reject a hard-stop even if it also looks assertion-shaped.
function goLineIsAssertion(sourceLines, line) {
  const index = line - 1;
  if (index < 0 || index >= sourceLines.length) {
    return false;
  }
  const text = sourceLines[index];
  if (GO_HARD_STOP_LINE.test(text)) {
    return false;
  }
  return GO_ASSERTION_LINE.test(text);
}

// SOURCE-LINE BINDING: at least one failing frame must resolve to a test source
// line that is a genuine assertion. `pkgDirAbs` is the copied module's package
// directory (Go prints frame files as basenames relative to it). Reads are
// wrapped so an unreadable/absent source fails CLOSED (returns false).
function mutantFailedAtTrustedAssertion(run, name, pkgDirAbs, assertionLine) {
  // Slice 2 (line-gated): when an assertion line is provided, widen frame collection to
  // the target test's subtests too, then require a failing frame at EXACTLY that line.
  // A SIBLING subtest asserting at a DIFFERENT line is refused (its frame line != assertionLine).
  // No line ⇒ unchanged: exact-name frames, any genuine-assertion line.
  const useLine = typeof assertionLine === "number";
  const frames = parseGoFailFrames(targetTestOutput(run, name, useLine));
  if (frames.length === 0) {
    return false;
  }
  const sourceCache = new Map();
  for (const frame of frames) {
    // Line-gated: the frame MUST be at the recorded assertion line (exact). Then
    // `goLineIsAssertion` still runs as defense-in-depth (that line must be a real assertion).
    if (useLine && frame.line !== assertionLine) {
      continue;
    }
    const abs = path.join(pkgDirAbs, path.basename(frame.file));
    if (!sourceCache.has(abs)) {
      try {
        sourceCache.set(abs, readFileSync(abs, "utf8").split(/\r?\n/));
      } catch {
        sourceCache.set(abs, null);
      }
    }
    const sourceLines = sourceCache.get(abs);
    if (sourceLines && goLineIsAssertion(sourceLines, frame.line)) {
      return true;
    }
  }
  return false;
}

function failureSummary(run, name) {
  for (const e of run.events) {
    if (e.Action === "output" && typeof e.Output === "string" && name && e.Test === name) {
      const line = e.Output.trim();
      if (line && !/^(=== RUN|=== PAUSE|=== CONT|--- FAIL|--- PASS)/.test(line)) {
        return redactSecrets(line);
      }
    }
  }
  for (const e of run.events) {
    if (e.Action === "build-output" && typeof e.Output === "string" && e.Output.trim()) {
      return redactSecrets(e.Output.trim().split("\n", 1)[0]);
    }
  }
  const stderr = String(run.stderr ?? "").trim();
  return stderr ? redactSecrets(stderr.split("\n", 1)[0]) : null;
}

function redactSecrets(text) {
  return String(text)
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION)[A-Z0-9_]*=)[^\s'"]+/gi, "$1[REDACTED]")
    .replace(/(:\/\/[^:/@\s]+:)[^@/\s]+(@)/g, "$1[REDACTED]$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

// Run the AST mutator (go run go-mutate.go). Because `go run` collapses any
// non-zero child status to 1, we classify on the MUTATE_ERROR:<code> marker the
// helper prints to stderr, not the exit code.
function mutateFunc({ targetAbs, func, recv, mode, cacheRoot, timeoutMs }) {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "go-mutate.go");
  const result = spawnSync(goBin(), ["run", helper, "--file", targetAbs, "--func", func, ...(recv ? ["--recv", recv] : []), "--mode", mode], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: hermeticEnv(cacheRoot),
    maxBuffer: 8 * 1024 * 1024
  });
  const stderr = String(result.stderr ?? "");
  const marker = /MUTATE_ERROR:(\d+)/.exec(stderr);
  if (marker) {
    return { ok: false, code: Number(marker[1]), message: redactSecrets(stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "") };
  }
  if ((result.status ?? 1) !== 0) {
    return { ok: false, code: 2, message: redactSecrets((stderr.split("\n", 1)[0] || "mutation failed").trim()) };
  }
  return { ok: true };
}

function mutateErrorReason(code) {
  switch (code) {
    case 3: return "target name is ambiguous (more than one free function or method)";
    case 4: return "target free function or method was not found";
    // code 5 (method out of scope) is retired — methods are mutable now, never emitted.
    case 6: return "target function has no return value (not mutable)";
    default: return "mutation could not be applied";
  }
}

function classify({ baseline, mutant, name, pkgDirAbs, assertionLine }) {
  // (FIX 1) --test-run must bind to EXACTLY ONE target test. A broad/ambiguous
  // pattern resolves to a null name; reject it before any pass/fail reasoning so a
  // Proven can never rest on an unrelated test's event.
  if (!name) {
    return {
      status: "unrunnable",
      proven: false,
      reason: "ambiguous or broad --test-run; require exactly one target test"
    };
  }
  // (a) baseline must build AND the target test must pass.
  if (baseline.exitCode !== 0 || baseline.timedOut || hasBuildFailure(baseline) || !targetTestPassed(baseline, name)) {
    return { status: "unrunnable", proven: false, reason: "baseline target test did not pass" };
  }
  // (b) mutant must build.
  if (hasBuildFailure(mutant)) {
    return { status: "unrunnable", proven: false, reason: "mutant did not compile" };
  }
  if (mutant.timedOut) {
    return { status: "unrunnable", proven: false, reason: "mutant timed out" };
  }
  // Equivalent-value mutation: the target test still passes -> survives.
  if (mutant.exitCode === 0 && targetTestPassed(mutant, name) && !targetTestFailed(mutant, name)) {
    return { status: "associated_survived", proven: false, reason: "mutated target did not change the test outcome" };
  }
  // (d) a panic is NOT a trusted assertion signal (line-gated: also reject a subtest panic).
  if (targetTestPanicked(mutant, name, typeof assertionLine === "number")) {
    return { status: "unrunnable", proven: false, reason: "mutant failed with a panic, not a test assertion" };
  }
  // (c) the SAME target test must fail (a subtest failure fails the parent too, so the
  // parent-name `fail` action already reflects a runtime-named child's failure)...
  if (!targetTestFailed(mutant, name)) {
    return { status: "unrunnable", proven: false, reason: "mutant failed, but not at the target test" };
  }
  // (FIX 2) ...and that failure must bind to a GENUINE value-assertion source
  // line. A t.Fatal precondition, a setup/helper failure, or any failure we cannot
  // bind to an assertion line is NOT trusted -> unrunnable, never Proven (fail
  // closed). Slice 2: when an assertion line is given, the frame must be at THAT line.
  if (!mutantFailedAtTrustedAssertion(mutant, name, pkgDirAbs, assertionLine)) {
    return {
      status: "unrunnable",
      proven: false,
      reason: "mutant failed the target test, but not at a trusted value assertion"
    };
  }
  return { status: "proven", proven: true, reason: "baseline passed and the mutant failed the same target test at a trusted assertion" };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const targetAbs = resolveInside(root, args.target);
  const targetRel = path.relative(root, targetAbs);
  const timeoutMs = parseTimeoutMs(args.timeoutMs);
  const name = targetTestName(args.testRun);
  const assertionLine = parseAssertionLine(args.goAssertionLine);
  // TARGET-PACKAGE SCOPE: Go packages ARE directories. The target's package is the
  // directory of --target; scope `go test` to just it (`./<dir>`, no `...`) so a
  // same-named test in another package can never be credited to this target. Use
  // POSIX separators (Go accepts `./a/b` even on Windows) and `./` for the module
  // root (dirname of a root-level file is ".").
  const pkgDirRel = path.dirname(targetRel);
  const pkgPath = pkgDirRel === "." ? "./" : `./${pkgDirRel.split(path.sep).join("/")}`;

  const baselineCopy = copyModuleRoot(root, "baseline");
  const mutantCopy = copyModuleRoot(root, "mutant");
  // The mutant sandbox's package directory: Go prints failure-frame files as
  // basenames relative to it, so FIX 2 resolves the test source there.
  const pkgDirAbs = path.join(mutantCopy.repoRoot, path.dirname(targetRel));
  try {
    const baseline = runGoTest({ repoRoot: baselineCopy.repoRoot, testRun: args.testRun, timeoutMs, cacheRoot: baselineCopy.tmpRoot, pkgPath });

    const mutation = mutateFunc({
      targetAbs: path.join(mutantCopy.repoRoot, targetRel),
      func: args.func,
      recv: args.recv,
      mode: args.mode,
      cacheRoot: mutantCopy.tmpRoot,
      timeoutMs
    });

    let verdict;
    let mutant = null;
    if (!mutation.ok) {
      // Baseline still reported so a caller can see it built/passed; the refusal
      // classifies unrunnable without ever running a mutant.
      verdict = {
        status: "unrunnable",
        proven: false,
        reason: mutateErrorReason(mutation.code)
      };
    } else {
      mutant = runGoTest({ repoRoot: mutantCopy.repoRoot, testRun: args.testRun, timeoutMs, cacheRoot: mutantCopy.tmpRoot, pkgPath });
      verdict = classify({ baseline, mutant, name, pkgDirAbs, assertionLine });
    }

    const output = {
      ...verdict,
      mode: args.mode,
      testRun: args.testRun,
      target: targetRel,
      func: args.func,
      baseline: {
        exitCode: baseline.exitCode,
        timedOut: baseline.timedOut,
        elapsedMs: baseline.elapsedMs,
        buildFailure: hasBuildFailure(baseline),
        targetTestPassed: targetTestPassed(baseline, name),
        failureSummary: failureSummary(baseline, name)
      },
      mutant: mutant
        ? {
            exitCode: mutant.exitCode,
            timedOut: mutant.timedOut,
            elapsedMs: mutant.elapsedMs,
            buildFailure: hasBuildFailure(mutant),
            targetTestFailed: targetTestFailed(mutant, name),
            panicked: targetTestPanicked(mutant, name, typeof assertionLine === "number"),
            // MUST pass assertionLine so this reported field matches classify's verdict —
            // `mapGoOracle` reads THIS `trustedAssertion` to close the cert.
            trustedAssertion: mutantFailedAtTrustedAssertion(mutant, name, pkgDirAbs, assertionLine),
            failureSummary: failureSummary(mutant, name)
          }
        : { skipped: true, reason: mutation.message ?? null },
      medianProofMs: mutant ? Math.round((baseline.elapsedMs + mutant.elapsedMs) / 2) : baseline.elapsedMs
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`${output.status}: ${output.reason}\n`);
      process.stdout.write(`baseline=${baseline.exitCode} mutant=${mutant ? mutant.exitCode : "skipped"} median_ms=${output.medianProofMs}\n`);
    }
    process.exitCode = output.status === "unrunnable" ? 2 : 0;
  } finally {
    rmSync(baselineCopy.tmpRoot, { recursive: true, force: true });
    rmSync(mutantCopy.tmpRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
}
