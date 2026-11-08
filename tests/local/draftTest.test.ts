import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { opTestBrief } from "../../src/local/candidateTest.js";
import { verifyRunFolder } from "../../src/local/contracts/io.js";
import { draftPrompt, insertTest, opDraftTest, parseReply, repairChange, type DraftTestDeps, type DraftTestResult } from "../../src/local/draftTest.js";
import { ProbeFaultRefusal } from "../../src/local/faultProbe.js";
import type { ModelProvider, ModelCompletionRequest } from "../../src/local/types.js";
import { deps, hostExecutor, OFFSETS, probe, workspace, type Workspace } from "./support/probeWorkspace.js";

// J1: `opro draft-test` with a fake provider on the synthetic Mocha fixture (no Express code, no network).

const ROUNDING = `rounding_floor_ceil@${OFFSETS.floorInSeconds}`;
const NEGATION = `negation_removal@${OFFSETS.bangInSeconds}`;
const KEY = "sk-ant-test-0123456789abcdefghijklmnopqrstuv";
const PROVIDER_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "ORANGEPRO_PROVIDER"];

const ASSERT = "assert.strictEqual(api.seconds(1500), 1);";
const reply = (over: Partial<{ file: string; describe: string[]; test: string; assertion_line: string; condition: string }> = {}): string =>
  JSON.stringify({
    file: "test/api.test.js",
    describe: ["api.seconds"],
    test: `it('rounds a sub-second value down', function () {\n  var ms = 1500;\n  ${ASSERT}\n});`,
    assertion_line: ASSERT,
    condition: "seconds(1500) is 1, the oracle's value",
    ...over
  });

class FakeProvider implements ModelProvider {
  readonly providerName = "anthropic";
  readonly modelName = "claude-opus-5-5";
  readonly prompts: string[] = [];
  constructor(private readonly replies: Array<string | Error>) {}
  async complete(req: ModelCompletionRequest): Promise<string> {
    this.prompts.push(req.user);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return next;
  }
}

type Survived = { w: Workspace; faultRun: string; brief: string };
let counter = 0;
function survived(): Survived {
  const w = workspace();
  const run = probe(w, ROUNDING, { full_suite: true });
  if (run.classification.classification !== "survived_unverified") throw new Error("fixture error");
  counter += 1;
  const brief = opTestBrief(w.repo, { from_run: run.run_dir }, { runId: () => `run_brief_${counter}` });
  return { w, faultRun: run.run_dir, brief: brief.run_dir };
}

let ids = 0;
const envSeen: string[][] = [];
function draftDeps(provider: FakeProvider | undefined, env: NodeJS.ProcessEnv | undefined): DraftTestDeps {
  const inner = hostExecutor();
  return {
    clock: deps.clock,
    runId: () => `run_j1_${++ids}`,
    env,
    provider,
    container: (request) => {
      envSeen.push(PROVIDER_VARS.filter((name) => process.env[name] !== undefined));
      return inner(request);
    }
  };
}

async function draft(s: Survived, provider: FakeProvider | undefined, env: NodeJS.ProcessEnv | undefined = { ANTHROPIC_API_KEY: KEY }, opts: { provider?: string; brief?: string; from_run?: string } = {}): Promise<DraftTestResult> {
  return opDraftTest(s.w.repo, { from_run: opts.from_run ?? s.faultRun, brief: opts.brief ?? s.brief, provider: opts.provider }, draftDeps(provider, env));
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal) return `${error.code}: ${error.message}`;
    throw error;
  }
  return "not refused";
}

const runs = (w: Workspace): string[] => readdirSync(path.join(w.repo, ".orangepro", "proof-runs")).sort();
const readRun = (w: Workspace, rel: string, file: string): any => JSON.parse(readFileSync(path.join(w.repo, rel, file), "utf8"));

function everyFile(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...everyFile(abs));
    else out.push(abs);
  }
  return out;
}

afterEach(() => {
  for (const name of PROVIDER_VARS) delete process.env[name];
});

describe("opro draft-test (J1)", { timeout: 180_000 }, () => {
  it("verified_gap from one reply: OrangePro writes the patch and record, verify-test runs unchanged, and the key is nowhere (J-P1, J-P5, J-P6, J-P7, N8)", async () => {
    const s = survived();
    const provider = new FakeProvider([reply()]);
    process.env.ANTHROPIC_API_KEY = KEY;
    envSeen.length = 0;
    const result = await draft(s, provider, undefined);
    expect(result).toMatchObject({ result: "verified_gap", provider: "anthropic", model: "claude-opus-5-5" });
    expect(result.statement).toContain("OrangePro drafted the test with the owner's model key from its brief; OrangePro verified it.");
    expect(result.attempts).toHaveLength(1);

    // J-P1: the prompt is the fixed header and generation-request.json's bytes, verbatim, and nothing else.
    const requestBytes = readFileSync(path.join(s.w.repo, s.brief, "brief", "generation-request.json"));
    expect(provider.prompts[0]).toBe(draftPrompt(requestBytes));
    expect(provider.prompts[0]!.split(requestBytes.toString("utf8")).join("")).not.toContain("api.seconds = function");

    // J-P5: who wrote it.
    const draftRun = result.attempts[0]!.draft_run;
    const record = readRun(s.w, draftRun, "assertion-record.json");
    expect(record.generation).toEqual({ by: "provider", agent: "anthropic/claude-opus-5-5", assisted: true, saw: [`generation-request.json ${record.generation_request_sha256}`], attempt: 1 });
    const verdict = readRun(s.w, result.verified_run!, "classification.json");
    expect(verdict).toMatchObject({ result: "verified_gap", attribution: { by: "provider", agent: "anthropic/claude-opus-5-5", attempt: 1 }, assisted: true });

    // J-P6: the attempt has its own sealed run folder, naming its verify run.
    expect(verifyRunFolder(path.join(s.w.repo, draftRun)).ok).toBe(true);
    expect(readRun(s.w, draftRun, "draft.json")).toMatchObject({ attempt: 1, counted: true, failure: null, result: "verified_gap", verify_run: verdict.run_id });
    expect(readRun(s.w, draftRun, "fault-run.json")).toMatchObject({ kind: "test_draft", provider: "anthropic", model: "claude-opus-5-5", attempt: 1 });

    // N8 and J-P7: no provider variable reached any container call, none is left, and no file holds the key.
    expect(envSeen.length).toBeGreaterThan(0);
    expect(envSeen.every((names) => names.length === 0)).toBe(true);
    expect(PROVIDER_VARS.filter((name) => process.env[name] !== undefined)).toEqual([]);
    for (const file of everyFile(path.join(s.w.repo, ".orangepro"))) expect(readFileSync(file).includes(Buffer.from(KEY))).toBe(false);
  });

  it("the real Anthropic provider, on a fake network, sends the key in its header and nowhere else", async () => {
    const s = survived();
    const seen: Array<{ url: string; key: string | null; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url, key: headers["x-api-key"] ?? null, body: String(init.body) });
      return new Response(JSON.stringify({ content: [{ type: "text", text: reply() }], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await opDraftTest(s.w.repo, { from_run: s.faultRun, brief: s.brief }, { ...draftDeps(undefined, { ANTHROPIC_API_KEY: KEY }), fetchImpl });
    expect(result).toMatchObject({ result: "verified_gap", provider: "anthropic", model: "claude-opus-5-5" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.key).toBe(KEY);
    expect(JSON.parse(seen[0]!.body).model).toBe("claude-opus-5-5");
    expect(seen[0]!.body).not.toContain(KEY);
    for (const file of everyFile(path.join(s.w.repo, ".orangepro"))) expect(readFileSync(file).includes(Buffer.from(KEY))).toBe(false);
  });

  it("N1: no key, two keys with no provider named, or a named provider without its key: refused before any write", async () => {
    const s = survived();
    const before = runs(s.w);
    expect(await refusal(() => draft(s, new FakeProvider([]), {}))).toMatch(/^no_provider: .*ANTHROPIC_API_KEY/);
    expect(await refusal(() => draft(s, new FakeProvider([]), { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-0123456789" }))).toMatch(/^provider_ambiguous: .*ANTHROPIC_API_KEY, OPENAI_API_KEY/);
    expect(await refusal(() => draft(s, new FakeProvider([]), { OPENAI_API_KEY: "sk-openai-0123456789" }, { provider: "anthropic" }))).toMatch(/^no_provider: .*anthropic is named/);
    expect(runs(s.w)).toEqual(before);
    // Naming one of the two is enough.
    const named = await draft(s, new FakeProvider([reply()]), { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-openai-0123456789" }, { provider: "anthropic" });
    expect(named.result).toBe("verified_gap");
  });

  it("J-P2 and N9: an edited brief, or a fault the existing tests catch, is refused with no provider call", async () => {
    const s = survived();
    const provider = new FakeProvider([reply()]);
    const requestPath = path.join(s.w.repo, s.brief, "brief", "generation-request.json");
    const bytes = readFileSync(requestPath);
    writeFileSync(requestPath, Buffer.concat([bytes, Buffer.from(" ")]));
    expect(await refusal(() => draft(s, provider))).toMatch(/^brief_invalid/);
    writeFileSync(requestPath, bytes);
    const w = workspace();
    const caught = probe(w, NEGATION);
    expect(await refusal(() => opDraftTest(w.repo, { from_run: caught.run_dir, brief: s.brief }, draftDeps(provider, { ANTHROPIC_API_KEY: KEY })))).toMatch(/^no_gap/);
    expect(provider.prompts).toHaveLength(0);
  });

  it("N2: a reply that is not the JSON is an attempt; the next attempt is told what happened", async () => {
    const s = survived();
    const provider = new FakeProvider(["I can't help with that.", reply()]);
    const result = await draft(s, provider);
    expect(result.result).toBe("verified_gap");
    expect(result.attempts.map((a) => [a.attempt, a.result])).toEqual([
      [1, "not_run"],
      [2, "verified_gap"]
    ]);
    expect(result.attempts[0]!.reason).toContain("not the JSON asked for");
    expect(provider.prompts[1]!.startsWith(provider.prompts[0]!)).toBe(true);
    expect(provider.prompts[1]).toContain("It was not run: the reply is not the JSON asked for");
    // verify-test numbers its own attempts: the first test that ran is its attempt 1.
    expect(readRun(s.w, result.attempts[1]!.draft_run, "assertion-record.json").generation.attempt).toBe(1);
  });

  it("N3 and N5: a repair that changes the assertion is not run but counted; three attempts end it, and a fourth is refused before any call", async () => {
    const s = survived();
    const wrong = "assert.strictEqual(api.seconds(1500), 7);";
    const failing = reply({ test: `it('rounds a sub-second value down', function () {\n  ${wrong}\n});`, assertion_line: wrong });
    const changed = reply({ test: `it('rounds a sub-second value down', function () {\n  ${ASSERT}\n});` });
    const provider = new FakeProvider([failing, changed, failing]);
    const result = await draft(s, provider);
    expect(result.result).toBe("not_verified");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]!.result).toBe("candidate_failed");
    expect(result.attempts[1]).toMatchObject({ result: "not_run", reason: "the repair changed the declared assertion line; a repair may change only setup lines" });
    expect(provider.prompts[1]).toContain("# Your previous attempt");
    expect(provider.prompts[1]).toContain("Result: candidate_failed");
    const fourth = new FakeProvider([reply()]);
    expect(await refusal(() => draft(s, fourth))).toMatch(/^attempts_exhausted/);
    expect(fourth.prompts).toHaveLength(0);
  });

  it("N4: a file outside the neighbours, or a describe block that is not there, is an attempt that is not run", async () => {
    const s = survived();
    const result = await draft(s, new FakeProvider([reply({ file: "lib/api.js" }), reply({ describe: ["nope"] }), reply()]));
    expect(result.attempts.map((a) => a.reason ?? null)).toEqual(['"lib/api.js" is not one of the brief\'s neighbours (test/api.test.js)', 'test/api.test.js has no describe block ["nope"]', null]);
    expect(result.result).toBe("verified_gap");
  });

  it("N6: a provider error that echoes the key is written redacted, is not counted, and stops the loop", async () => {
    const s = survived();
    const result = await draft(s, new FakeProvider([new Error(`401 invalid x-api-key ${KEY} for this account`)]));
    expect(result.result).toBe("not_verified");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.reason).toContain("the model call failed: 401 invalid x-api-key <key>");
    const draftRun = result.attempts[0]!.draft_run;
    expect(readRun(s.w, draftRun, "draft.json")).toMatchObject({ counted: false });
    for (const file of everyFile(path.join(s.w.repo, ".orangepro"))) expect(readFileSync(file).includes(Buffer.from(KEY))).toBe(false);
    // Not counted: three attempts are still available.
    expect((await draft(s, new FakeProvider([reply()]))).result).toBe("verified_gap");
  });

  it("a provider endpoint in an error is recorded and printed by its variable's name, never by value", async () => {
    const s = survived();
    const endpoint = "https://llm.internal.example/v1";
    const result = await draft(s, new FakeProvider([new Error(`connect ECONNREFUSED ${endpoint}/messages`)]), { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: endpoint });
    expect(result.attempts[0]!.reason).toBe("the model call failed: connect ECONNREFUSED <ANTHROPIC_BASE_URL>/messages");
    expect(result.statement).not.toContain("llm.internal.example");
    for (const file of everyFile(path.join(s.w.repo, ".orangepro"))) expect(readFileSync(file, "utf8")).not.toContain("llm.internal.example");
  });

  it("N7: a reply that would put the key in a file is not written, and draft-test stops naming the file", async () => {
    const s = survived();
    const result = await draft(s, new FakeProvider([`{"note": "${KEY}"}`]));
    expect(result.result).toBe("not_verified");
    expect(result.statement).toContain("the key would have been written to");
    expect(result.statement).toContain("response.txt");
    for (const file of everyFile(path.join(s.w.repo, ".orangepro"))) expect(readFileSync(file).includes(Buffer.from(KEY))).toBe(false);
  });

  it("reads one JSON object, alone or fenced, and nothing else; places the test at its neighbours' indentation; names what a repair changed", () => {
    expect(parseReply(reply())).not.toBeNull();
    expect(parseReply("```json\n" + reply() + "\n```")).not.toBeNull();
    expect(parseReply("Here it is: " + reply())).toBeNull();
    expect(parseReply(JSON.stringify({ describe: ["a"], test: "it()", assertion_line: "x", condition: "y" }))).toBeNull();
    const placed = insertTest("t.js", "describe('a', function () {\n  it('b', function () {});\n});\n", ["a"], "it('c', function () {\n  x();\n});");
    expect(placed!.patched).toBe("describe('a', function () {\n  it('b', function () {});\n\n  it('c', function () {\n    x();\n  });\n});\n");
    const base = JSON.parse(reply());
    expect(repairChange(base, { ...base, test: base.test.replace("var ms = 1500;", "var ms = 1500; var other = 2;") })).toBeNull();
    expect(repairChange(base, { ...base, describe: ["other"] })).toBe("the describe block");
    expect(repairChange(base, { ...base, test: base.test.replace("rounds", "floors") })).toBe("the test's title");
    expect(repairChange(base, { ...base, condition: "something else" })).toBe("the condition");
    expect(repairChange(base, { ...base, test: base.test.replace("var ms = 1500;", "assert.ok(true);") })).toBe("another assertion line");
    // A chain continuation is an assertion line to verify-test, though no regex for an assertion call matches it alone.
    const file = "describe('api.seconds', function () {\n  it('x', function () {});\n});\n";
    const chained = { file: "test/api.test.js", describe: ["api.seconds"], test: "it('rounds', function () {\n  var ms = 1500;\n  expect(api.seconds(ms))\n    .to.equal(1);\n});", assertion_line: "expect(api.seconds(ms))", condition: "is 1" };
    const weakened = { ...chained, test: chained.test.replace(".to.equal(1);", ".to.equal(2);") };
    expect(repairChange(chained, weakened)).toBeNull();
    expect(repairChange(chained, weakened, file)).toBe("another assertion line");
    expect(repairChange(chained, { ...chained, test: chained.test.replace("var ms = 1500;", "var ms = 1000 + 500;") }, file)).toBeNull();
  });
});
