import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { applyAdditivePatch, parseAdditivePatch, readNewTest } from "./candidatePatch.js";
import { checkBrief, earlierAttempts, loadFaultRun, opVerifyTest, setRefusingCommand, type FaultRun, type VerifyTestResult } from "./candidateTest.js";
import { ASSERTION_RECORD_VERSION, MAX_CANDIDATE_ATTEMPTS, type AssertionRecord, type GenerationRequest } from "./contracts/candidate.js";
import { unifiedFileDiff } from "./contracts/faultRecord.js";
import { newRunId, recordBytes, sha256Hex, writeFileAtomic, writeRunManifest } from "./contracts/io.js";
import { ProbeFaultRefusal, type ProbeFaultDeps } from "./faultProbe.js";
import { buildProvider, type FetchLike } from "./generate/providers.js";
import { resolveProviderConfig, type ProviderName } from "./localConfig.js";
import { ProofRefusalError } from "./operations.js";
import { toWorkspaceRel } from "./reprove/paths.js";
import type { ModelProvider } from "./types.js";
import { PROVIDER_ENDPOINT_VARS, redactProviderEndpoints, redactSecrets } from "./util/redact.js";
import { ORANGEPRO_VERSION } from "./version.js";
import { workspacePaths } from "./workspace.js";

// J1, "OrangePro writes the test": `opro draft-test` sends a test-brief run's generation-request.json, and
// nothing else, to the owner's model with the owner's key; takes back one test; writes candidate.patch and
// assertion-record.json itself; and runs verify-test on them unchanged. At most three attempts per fault,
// counted as verify-test counts them; a repair is shown its own earlier test and verify-test's verdict, and
// may change only setup lines. Every attempt keeps its own run folder.
//
// The key is read once from this command's environment, then every provider variable is removed from the
// environment before verify-test, git or docker starts. Every byte this command writes is checked for the
// key's exact value first, and error text is redacted by that value, not only by a key's usual shape.

const PROVIDER_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "ORANGEPRO_PROVIDER"];
const PROVIDERS: ProviderName[] = ["anthropic", "openai", "ollama"];
const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = { anthropic: "claude-opus-5-5" };
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 16_000;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

export const DRAFT_REFUSALS = ["no_provider", "provider_ambiguous", "key_exposed"] as const;

const refuse = (code: string, detail: string): never => {
  throw new ProbeFaultRefusal(code, detail, "draft-test");
};

export interface DraftTestOptions {
  from_run: string;
  brief: string;
  provider?: string;
  model?: string;
  source?: string;
}

export interface DraftTestDeps extends ProbeFaultDeps {
  /** Where provider variables are read from; process.env when not given. Provider variables are removed from process.env either way. */
  env?: NodeJS.ProcessEnv;
  /** A provider to use instead of the one built from the environment (tests). The environment is still read and checked. */
  provider?: ModelProvider;
  fetchImpl?: FetchLike;
  /** Total deadline for the command (default 30 minutes). */
  deadlineMs?: number;
  now?: () => number;
}

export interface DraftAttempt {
  attempt: number;
  draft_run: string;
  verify_run: string | null;
  result: string;
  reason: string | null;
  statement: string;
}

export interface DraftTestResult {
  result: "verified_gap" | "not_verified" | "inconclusive";
  provider: string;
  model: string;
  attempts: DraftAttempt[];
  verified_run: string | null;
  statement: string;
}

interface ModelReply {
  file: string;
  describe: string[];
  test: string;
  assertion_line: string;
  condition: string;
}

/** The provider named on the command line or in ORANGEPRO_PROVIDER; with neither, the one provider whose key is set. Two or more keys and no name is refused. */
function chooseProvider(env: NodeJS.ProcessEnv, opts: DraftTestOptions): { name: ProviderName; model: string | undefined } {
  const named = (opts.provider || env.ORANGEPRO_PROVIDER || "").trim().toLowerCase();
  const present = PROVIDERS.filter((p) => (p === "ollama" ? Boolean(env.OLLAMA_BASE_URL) : Boolean(env[`${p.toUpperCase()}_API_KEY`])));
  let name: ProviderName;
  if (named) {
    if (!PROVIDERS.includes(named as ProviderName)) return refuse("no_provider", `unknown provider ${JSON.stringify(named)}: name anthropic, openai or ollama.`);
    name = named as ProviderName;
  } else if (present.length === 0) {
    return refuse("no_provider", "no model key in this command's environment: give ANTHROPIC_API_KEY (or OPENAI_API_KEY, or OLLAMA_BASE_URL) to this one command. Keys are never read from a file.");
  } else if (present.length > 1) {
    return refuse("provider_ambiguous", `more than one provider is set (${present.map((p) => (p === "ollama" ? "OLLAMA_BASE_URL" : `${p.toUpperCase()}_API_KEY`)).join(", ")}): name one with --provider or ORANGEPRO_PROVIDER.`);
  } else {
    name = present[0]!;
  }
  const model = opts.model || env[`${name.toUpperCase()}_MODEL`] || DEFAULT_MODELS[name];
  return { name, model };
}

const SYSTEM = "You write one repository-native Mocha test from OrangePro's brief. You reply with one JSON object and nothing else.";

const HEADER = [
  "# Task",
  "OrangePro's brief below is generation-request.json exactly as `opro test-brief` wrote it. It describes a fault the existing tests missed and the approved expected behavior. Write the one new test it asks for, following every rule in its \"rules\" about the test itself.",
  "OrangePro, not you, makes the patch and the assertion record from your reply: ignore the rules about writing assertion-record.json, making the patch and restoring the checkout.",
  "",
  "# Reply",
  "One JSON object and nothing else:",
  '{"file": "<the path of one of the brief\'s neighbours>", "describe": ["<outermost describe title>", "...", "<innermost>"], "test": "<the whole it(...) call, as code>", "assertion_line": "<the one line of the test whose failure must catch the fault, exactly as in test>", "condition": "<what that line checks, in words, from the oracle>"}',
  "OrangePro adds the test at the end of the innermost describe block you name (titles exactly as written in the file), indented like its neighbours. Put the one assertion call whose failure must catch the fault on a line of its own, and copy that line exactly into assertion_line."
].join("\n");

/** Attempt 1's prompt: the fixed header, then the request's bytes, verbatim, in one fenced block. */
export function draftPrompt(requestBytes: Buffer): string {
  const text = requestBytes.toString("utf8");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${HEADER}\n\n# The brief (generation-request.json)\n${fence}json\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

function repairPrompt(first: string, previous: ModelReply | null, outcome: string): string {
  return [
    first,
    "# Your previous attempt",
    ...(previous ? [`In ${previous.file}, inside ${JSON.stringify(previous.describe)}:`, "```js", previous.test, "```", ""] : []),
    "# What happened when OrangePro ran it",
    outcome,
    "",
    "# Repair",
    previous
      ? "Change only setup lines: variables, the app or request set-up, and which of the modules the file already loads you use. Keep the file, the describe block, the it(...) title, the assertion line, the condition and every other assertion line exactly as they were. Reply with the same JSON shape."
      : "Reply with the JSON shape asked for above.",
    ""
  ].join("\n");
}

/** The reply: one JSON object, alone or as the only content of one fenced block. Null for anything else. */
export function parseReply(text: string): ModelReply | null {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  try {
    const value = JSON.parse(body) as Partial<ModelReply>;
    const ok =
      typeof value.file === "string" &&
      Array.isArray(value.describe) &&
      value.describe.length > 0 &&
      value.describe.every((t) => typeof t === "string") &&
      typeof value.test === "string" &&
      typeof value.assertion_line === "string" &&
      value.assertion_line.trim() !== "" &&
      typeof value.condition === "string" &&
      value.condition.trim() !== "";
    return ok ? { file: value.file!, describe: value.describe!, test: value.test!, assertion_line: value.assertion_line!, condition: value.condition! } : null;
  } catch {
    return null;
  }
}

/** The new test's title, read from its code; null unless the code is one it(...) call with a plain title. */
export function testTitle(code: string): string | null {
  const source = ts.createSourceFile("draft.js", code, ts.ScriptTarget.Latest, true);
  if ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) return null;
  const statements = source.statements;
  if (statements.length !== 1 || !ts.isExpressionStatement(statements[0]!)) return null;
  const call = statements[0]!.expression;
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "it") return null;
  const first = call.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** Insert the test at the end of the named describe block, indented as that block's tests are. Lines start..end (1-based) hold the test. */
export function insertTest(path: string, original: string, describe: string[], code: string): { patched: string; start: number; end: number } | null {
  const source = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true);
  let scope: ts.NodeArray<ts.Statement> = source.statements;
  let body: ts.Block | null = null;
  for (const title of describe) {
    const match = scope.find(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        ["describe", "context", "suite"].includes(statement.expression.expression.text) &&
        statement.expression.arguments[0] !== undefined &&
        ts.isStringLiteralLike(statement.expression.arguments[0]!) &&
        statement.expression.arguments[0]!.text === title
    ) as ts.ExpressionStatement | undefined;
    const fn = match ? (match.expression as ts.CallExpression).arguments.find((a) => ts.isFunctionExpression(a) || ts.isArrowFunction(a)) : undefined;
    if (!fn || !(ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) || !ts.isBlock(fn.body)) return null;
    body = fn.body;
    scope = fn.body.statements;
  }
  if (!body) return null;
  const lines = original.split("\n");
  const lineOf = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line;
  const last = body.statements[body.statements.length - 1];
  const afterLine = last ? lineOf(last.getEnd()) : lineOf(body.getStart(source));
  const indentLine = last ? lines[lineOf(last.getStart(source))]! : `${lines[lineOf(body.getStart(source))]!.match(/^\s*/)![0]}  `;
  const indent = indentLine.match(/^\s*/)![0];
  // The closing line sits at the it( level, whether or not the model indented the first line.
  const codeLines = code.replace(/\r\n/g, "\n").replace(/\s+$/, "").replace(/^\s+/, "").split("\n");
  const base = codeLines.length > 1 ? codeLines[codeLines.length - 1]!.match(/^\s*/)![0].length : 0;
  const dedent = (l: string): string => l.slice(Math.min(base, l.match(/^\s*/)![0].length));
  const placed = codeLines.map((l, i) => (l.trim() === "" ? "" : `${indent}${i === 0 ? l : dedent(l)}`));
  const out = [...lines.slice(0, afterLine + 1), "", ...placed, ...lines.slice(afterLine + 1)];
  return { patched: out.join("\n"), start: afterLine + 3, end: afterLine + 2 + placed.length };
}

const ASSERTION_LINE_RE = /\bassert\w*\s*[.(]|\bexpect\s*\(|\.expect\s*\(|\.should\b/;

/**
 * The new test's assertion lines as verify-test reads them (every line where an assertion call names its check,
 * chain continuations included), or null when verify-test would not read the test at all.
 */
function assertionLinesAsVerified(original: string, reply: ModelReply): string[] | null {
  const inserted = insertTest(reply.file, original, reply.describe, reply.test);
  if (!inserted) return null;
  try {
    const applied = applyAdditivePatch(Buffer.from(original, "utf8"), parseAdditivePatch(Buffer.from(unifiedFileDiff(reply.file, original, inserted.patched), "utf8")));
    const read = readNewTest({ path: applied.path, patched: applied.bytes, original: Buffer.from(original, "utf8"), added: applied.added });
    const lines = applied.bytes.toString("utf8").split("\n");
    return [...read.assertionPositions.keys()].sort((a, b) => a - b).map((line) => lines[line - 1]!.trim());
  } catch {
    return null;
  }
}

/**
 * What a repair changed that it may not: null when it changed only setup lines. With the file's text, the
 * assertion lines are also read as verify-test reads them for the first attempt, so a repair meets the same rule.
 */
export function repairChange(previous: ModelReply, next: ModelReply, fileText?: string): string | null {
  if (previous.file !== next.file) return "the file";
  if (JSON.stringify(previous.describe) !== JSON.stringify(next.describe)) return "the describe block";
  if (testTitle(previous.test) !== testTitle(next.test)) return "the test's title";
  if (previous.assertion_line.trim() !== next.assertion_line.trim()) return "the declared assertion line";
  if (previous.condition.trim() !== next.condition.trim()) return "the condition";
  const asserts = (code: string): string[] => code.split("\n").map((l) => l.trim()).filter((l) => ASSERTION_LINE_RE.test(l));
  if (JSON.stringify(asserts(previous.test)) !== JSON.stringify(asserts(next.test))) return "another assertion line";
  if (fileText !== undefined) {
    const before = assertionLinesAsVerified(fileText, previous);
    const after = assertionLinesAsVerified(fileText, next);
    if (before && after && JSON.stringify(before) !== JSON.stringify(after)) return "another assertion line";
  }
  return null;
}

interface DraftTag {
  kind?: string;
  fault_key?: string;
}

/** Earlier drafts of this fault, written by the model (a provider error is not one), whose test never ran in a verify run that verify-test counts. */
function draftsNotRun(runsDir: string, faultKey: string, countedVerifyRuns: Set<string>): number {
  let n = 0;
  for (const name of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, name);
    try {
      if (!lstatSync(dir).isDirectory() || !existsSync(join(dir, "MANIFEST.json"))) continue;
      const tag = JSON.parse(readFileSync(join(dir, "fault-run.json"), "utf8")) as DraftTag;
      if (tag.kind !== "test_draft" || tag.fault_key !== faultKey) continue;
      const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) as { counted?: boolean; verify_run?: string | null };
      if (draft.counted === true && !(draft.verify_run && countedVerifyRuns.has(draft.verify_run))) n += 1;
    } catch {
      continue;
    }
  }
  return n;
}

export async function opDraftTest(root: string, opts: DraftTestOptions, deps: DraftTestDeps): Promise<DraftTestResult> {
  setRefusingCommand("draft-test");
  try {
    return await draft(root, opts, deps);
  } finally {
    setRefusingCommand("verify-test");
  }
}

async function draft(root: string, opts: DraftTestOptions, deps: DraftTestDeps): Promise<DraftTestResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  // ── the key: read once, handed to the provider, then gone from the environment ──
  const env = deps.env ?? process.env;
  const chosen = chooseProvider(env, opts);
  const only: NodeJS.ProcessEnv = {};
  for (const name of PROVIDER_VARS) if (env[name]) only[name] = env[name];
  const config = resolveProviderConfig(only, { provider: chosen.name, model: chosen.model });
  if (!config) return refuse("no_provider", `${chosen.name} is named, but ${chosen.name === "ollama" ? "OLLAMA_BASE_URL" : `${chosen.name.toUpperCase()}_API_KEY`} is not set in this command's environment.`);
  // The endpoints are not secrets, but they are settings: redacted from everything printed or recorded, by value.
  const endpoints: Partial<Record<string, string>> = Object.fromEntries(PROVIDER_ENDPOINT_VARS.map((name) => [name, env[name]]));
  const secrets = [...new Set(PROVIDER_VARS.filter((name) => name.endsWith("_API_KEY")).map((name) => env[name]).filter((v): v is string => typeof v === "string" && v.length >= 8))];
  // The provider gets its own copy of the settings; this command keeps no reference to the key after this line.
  const provider = deps.provider ?? buildProvider({ ...config }, deps.fetchImpl);
  config.apiKey = undefined;
  for (const name of PROVIDER_VARS) {
    delete process.env[name];
    if (deps.env) delete deps.env[name];
  }
  const holdsKey = (bytes: Buffer | string): boolean => {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    return secrets.some((secret) => buf.includes(Buffer.from(secret, "utf8")));
  };
  const redact = (text: string): string => redactSecrets(redactProviderEndpoints(secrets.reduce((acc, secret) => acc.split(secret).join("<key>"), text), endpoints));
  const agent = `${provider.providerName}/${provider.modelName}`;

  // ── the fault run and the brief, checked as verify-test checks them, before any provider call ──
  const run: FaultRun = loadFaultRun(root, opts.from_run);
  const sourceRoot = resolve(opts.source ?? root);
  const { requestBytes, requestSha, briefCheck } = checkBrief(root, run, opts.brief, sourceRoot);
  const request = JSON.parse(requestBytes.toString("utf8")) as GenerationRequest;
  const runsDir = join(workspacePaths(root).dir, "proof-runs");
  const counted = (): number => {
    const verified = earlierAttempts(runsDir, run.faultKey);
    return verified.length + draftsNotRun(runsDir, run.faultKey, new Set(verified.map((a) => a.run_id)));
  };
  if (counted() >= MAX_CANDIDATE_ATTEMPTS) {
    refuse("attempts_exhausted", `${counted()} attempts were already made on this fault (counting every run of it); the limit is ${MAX_CANDIDATE_ATTEMPTS}.`);
  }

  const firstPrompt = draftPrompt(requestBytes);
  const attempts: DraftAttempt[] = [];
  let baseline: ModelReply | null = null;
  let previous: ModelReply | null = null;
  let outcomeText = "";
  let verifiedRun: string | null = null;
  let stop: string | null = null;
  let timedOut = false;

  while (!verifiedRun && !stop && attempts.length < MAX_CANDIDATE_ATTEMPTS && counted() < MAX_CANDIDATE_ATTEMPTS) {
    if (now() - startedAt > deadlineMs) {
      timedOut = true;
      break;
    }
    const attempt = counted() + 1;
    const prompt = attempts.length === 0 ? firstPrompt : repairPrompt(firstPrompt, previous, outcomeText);
    const draftId = (deps.runId ?? newRunId)();
    const draftDir = join(runsDir, draftId);
    if (existsSync(draftDir)) throw new Error(`${draftDir} already exists.`);
    mkdirSync(draftDir, { recursive: true });
    let failure: string | null = null;
    let countedAttempt = true;
    let keyIn: string | null = null;
    // Every file of the attempt is checked for the key before it is written; a file that would hold it is not written.
    const put = (rel: string, bytes: Buffer | string): boolean => {
      if (holdsKey(bytes)) {
        keyIn = keyIn ?? rel;
        return false;
      }
      writeFileAtomic(join(draftDir, rel), bytes);
      return true;
    };
    put(
      "fault-run.json",
      recordBytes({
        kind: "test_draft",
        fault_run: { run_id: run.runId, manifest_sha256: run.manifestSha },
        fault_key: run.faultKey,
        brief_run: { run_id: briefCheck.ok ? briefCheck.manifest.run_id : null },
        generation_request_sha256: requestSha,
        provider: provider.providerName,
        model: provider.modelName,
        attempt
      })
    );
    put("prompt.md", `<!-- system -->\n${SYSTEM}\n\n<!-- user -->\n${prompt}`);
    let responseText = "";
    try {
      responseText = await provider.complete({ system: SYSTEM, user: prompt, maxTokens: MAX_OUTPUT_TOKENS });
    } catch (error) {
      failure = `the model call failed: ${redact(String(error instanceof Error ? error.message : error)).slice(0, 300)}`;
      countedAttempt = false;
    }
    if (!put("response.txt", responseText)) failure = failure ?? "the reply holds the key";
    let reply: ModelReply | null = null;
    if (!failure) {
      if (Buffer.byteLength(responseText, "utf8") > MAX_REPLY_BYTES) failure = `the reply is longer than ${MAX_REPLY_BYTES} bytes`;
      else {
        reply = parseReply(responseText);
        if (!reply) failure = "the reply is not the JSON asked for (the model may have declined)";
      }
    }
    if (reply && !failure && baseline) {
      const changed = repairChange(baseline, reply, request.neighbours.find((file) => file.path === baseline!.file)?.text);
      if (changed) failure = `the repair changed ${changed}; a repair may change only setup lines`;
    }
    const neighbour = reply ? request.neighbours.find((file) => file.path === reply!.file) : undefined;
    if (reply && !failure && !neighbour) failure = `${JSON.stringify(reply.file)} is not one of the brief's neighbours (${request.neighbours.map((file) => file.path).join(", ")})`;
    const title = reply && !failure ? testTitle(reply.test) : null;
    if (reply && !failure && title === null) failure = "the test is not one it(...) call with a plain title";
    const original = neighbour ? neighbour.text : "";
    const inserted = reply && !failure ? insertTest(neighbour!.path, original, reply.describe, reply.test) : null;
    if (reply && !failure && !inserted) failure = `${neighbour!.path} has no describe block ${JSON.stringify(reply.describe)}`;
    let verify: VerifyTestResult | null = null;
    if (reply && !failure && inserted) {
      const patchedLines = inserted.patched.split("\n");
      const declared = patchedLines.map((l, i) => ({ l, i: i + 1 })).filter(({ l, i }) => i >= inserted.start && i <= inserted.end && l.trim() === reply!.assertion_line.trim());
      if (declared.length !== 1) failure = "the assertion line is not exactly one line of the test";
      else {
        const patch = Buffer.from(unifiedFileDiff(neighbour!.path, original, inserted.patched), "utf8");
        const record: AssertionRecord = {
          version: ASSERTION_RECORD_VERSION,
          generation_request_sha256: requestSha,
          fault_record_sha256: run.profile.fault_record_sha256,
          candidate: { patch_sha256: sha256Hex(patch), files: [{ path: neighbour!.path, sha256_after: sha256Hex(Buffer.from(inserted.patched, "utf8")) }] },
          test: { file: neighbour!.path, full_title: [...reply.describe, title!].join(" ") },
          assertion: { file: neighbour!.path, line: declared[0]!.i, text: declared[0]!.l.trim(), condition: reply.condition.trim() },
          failure_recognition: "first_frame_at_declared_line",
          generation: { by: "provider", agent, assisted: true, saw: [`generation-request.json ${requestSha}`], attempt: earlierAttempts(runsDir, run.faultKey).length + 1 }
        };
        const recordText = recordBytes(record);
        if (!put("candidate.patch", patch) || !put("assertion-record.json", recordText)) failure = "the test holds the key";
        else {
          try {
            verify = opVerifyTest(root, { from_run: opts.from_run, brief: opts.brief, candidate_bytes: patch, assertion: record, source: opts.source }, deps);
          } catch (error) {
            if (!(error instanceof ProbeFaultRefusal || error instanceof ProofRefusalError)) throw error;
            failure = `verify-test refused it: ${redact(error.message.replace(/^[a-z-]+ refused /, ""))}`;
          } finally {
            setRefusingCommand("draft-test");
          }
        }
      }
    }
    const v = verify?.verdict;
    // A test that ran in verify-test is counted there; one that never ran is counted here; a provider error is neither.
    const draftRecord = {
      attempt,
      provider: provider.providerName,
      model: provider.modelName,
      prompt_sha256: sha256Hex(Buffer.from(prompt, "utf8")),
      response_sha256: sha256Hex(Buffer.from(responseText, "utf8")),
      counted: countedAttempt,
      failure: keyIn ? `the key would have been written to ${keyIn}; it was not written` : failure,
      verify_run: verify ? verify.run_id : null,
      result: v ? v.result : null,
      reason: v ? v.reason : null
    };
    put("draft.json", recordBytes(draftRecord));
    writeRunManifest(draftDir, draftId, ORANGEPRO_VERSION);
    attempts.push({
      attempt,
      draft_run: toWorkspaceRel(root, draftDir),
      verify_run: verify ? verify.run_dir : null,
      result: v ? v.result : "not_run",
      reason: v ? v.reason : draftRecord.failure,
      statement: v ? v.statement : (draftRecord.failure ?? "")
    });
    if (keyIn) {
      stop = `the key would have been written to ${toWorkspaceRel(root, join(draftDir, keyIn))}; nothing holding it was written, and draft-test stopped`;
      break;
    }
    if (v?.result === "verified_gap") verifiedRun = verify!.run_dir;
    // The test a repair keeps is the first one verify-test ran, as verify-test's own rule has it; any well-formed reply is shown back.
    if (reply && !(failure && failure.startsWith("the repair changed"))) previous = reply;
    if (reply && verify) baseline = baseline ?? reply;
    outcomeText = v
      ? [
          `Result: ${v.result}${v.reason ? ` (${v.reason})` : ""}.`,
          v.statement,
          ...Object.entries(v.observed).map(([stage, o]) => `- ${stage}: ${o.executed} ran, ${o.passed} passed, ${o.failed} failed; the new test ${o.new_test}${o.new_test_failed_at ? ` at line ${o.new_test_failed_at.line}` : ""}`)
        ].join("\n")
      : `It was not run: ${failure}.`;
    // Not caught: the test reached the fault and passed, which a change of setup lines cannot fix. Blocked: the boundary did not hold.
    if (v && (v.result === "blocked" || v.result === "not_caught")) stop = v.result;
    // A provider error (no credits, a network failure) is not a draft the model wrote: stop, and say so.
    if (!countedAttempt) stop = draftRecord.failure;
  }

  const result: DraftTestResult["result"] = verifiedRun ? "verified_gap" : timedOut ? "inconclusive" : "not_verified";
  const statement = verifiedRun
    ? `OrangePro drafted the test with the owner's model key from its brief; OrangePro verified it. The test was written by ${agent} from generation-request.json alone${run.oracle.assisted.flag ? "; the target and the fault were known before the run, so the run is assisted" : ""}.`
    : timedOut
      ? `No claim: draft-test stopped at its ${Math.round(deadlineMs / 60000)}-minute deadline after ${attempts.length} attempt(s); every attempt is kept.`
      : `No draft verified after ${attempts.length} attempt(s)${stop ? ` (${stop})` : ""}. Every attempt is kept; the coding-agent route stays the fallback.`;
  return { result, provider: provider.providerName, model: provider.modelName, attempts, verified_run: verifiedRun, statement };
}

export function renderDraftTest(result: DraftTestResult): string[] {
  const lines = [`Result: ${result.result} (drafted with ${result.provider}/${result.model}, the owner's key)`, result.statement];
  for (const a of result.attempts) lines.push(`  attempt ${a.attempt}: ${a.result}${a.reason ? ` — ${a.reason}` : ""} (draft run ${a.draft_run}${a.verify_run ? `, verify run ${a.verify_run}` : ""})`);
  return lines;
}
