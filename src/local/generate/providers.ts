import { ProviderConfig } from "../localConfig.js";
import { ModelCompletionRequest, ModelProvider } from "../types.js";

export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Error thrown by postJson on a non-2xx response, carrying the raw body for adaptation. */
interface ProviderHttpError extends Error {
  status?: number;
  bodyText?: string;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Model provider HTTP ${res.status}: ${text.slice(0, 300)}`) as ProviderHttpError;
      err.status = res.status;
      err.bodyText = text;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } catch (e) {
    // Map the cryptic AbortError ("This operation was aborted") to an actionable
    // timeout message — the #1 cause is a reasoning model thinking past the cap.
    if ((e as { name?: string })?.name === "AbortError") {
      throw new Error(
        `Model call timed out after ${Math.round(timeoutMs / 1000)}s. Reasoning models (gpt-5/o-series) can spend ` +
          `minutes on hidden reasoning before responding; retry, or try a smaller --limit or a different model.`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Newer OpenAI models (GPT-5.x, o-series reasoning models) require
// `max_completion_tokens` instead of `max_tokens` and reject a non-default
// `temperature`. Used only to SEED the request; the adapter still self-corrects
// from the API's own error, so this list need not be exhaustive or current.
const REASONING_MODEL = /(?:gpt-5|^o[0-9]|[-/]o[0-9])/i;

/**
 * Reasoning models spend minutes on hidden reasoning before the (non-streaming)
 * response returns — the 60s default killed live gpt-5 runs mid-generation
 * ("This operation was aborted"), and the starvation retry's 4x budget makes
 * calls even longer. 10 minutes is a ceiling, not an expectation.
 */
const REASONING_TIMEOUT_MS = 600_000;

/** Per-call timeout: generous for reasoning models, default for the rest. */
export function providerTimeoutMs(model: string): number {
  return REASONING_MODEL.test(model) ? REASONING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * From a 400, determine which token param the model actually WANTS. OpenAI's error
 * is explicit — "'max_tokens' is not supported ... Use 'max_completion_tokens'
 * instead" — so we honor the "Use X instead" directive instead of guessing from the
 * offending param name. That avoids flipping a reasoning model onto `max_tokens`
 * (which always fails) when the first `max_completion_tokens` call errored for an
 * unrelated reason. Returns null when the 400 is not about the token param.
 */
function wantedTokenParam(e: unknown): "max_tokens" | "max_completion_tokens" | null {
  const err = e as ProviderHttpError;
  if (err?.status !== 400 || !err.bodyText) return null;
  const text = err.bodyText;
  if (/use\s+['"`]?max_completion_tokens/i.test(text)) return "max_completion_tokens";
  if (/use\s+['"`]?max_tokens\b/i.test(text)) return "max_tokens";
  return null;
}

/** True when a 400 says the model rejects a non-default `temperature`. */
function temperatureRejected(e: unknown): boolean {
  const err = e as ProviderHttpError;
  if (err?.status !== 400 || !err.bodyText) return false;
  return /\btemperature\b/i.test(err.bodyText) && /unsupported|does not support|only the default/i.test(err.bodyText);
}

/** OpenAI-compatible Chat Completions adapter (OpenAI, Azure-compatible, local gateways). */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly providerName = "openai";
  constructor(private readonly cfg: ProviderConfig, private readonly fetchImpl: FetchLike = fetch) {}
  get modelName(): string {
    return this.cfg.model;
  }
  async complete(req: ModelCompletionRequest): Promise<string> {
    const modern = REASONING_MODEL.test(this.cfg.model);
    // Reasoning models spend tokens on hidden reasoning, so give them more room.
    let maxTokens = req.maxTokens ?? (modern ? 4000 : 900);
    // Seed from the model name, then self-correct from the API's explicit directive.
    let tokenParam: "max_tokens" | "max_completion_tokens" = modern ? "max_completion_tokens" : "max_tokens";
    let sendTemperature = !modern;
    const tried = new Set<string>();

    for (;;) {
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        [tokenParam]: maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user }
        ]
      };
      if (sendTemperature) body.temperature = req.temperature ?? 0.2;
      try {
        const data = (await postJson(
          this.fetchImpl,
          `${this.cfg.baseUrl}/chat/completions`,
          { Authorization: `Bearer ${this.cfg.apiKey ?? ""}` },
          body,
          providerTimeoutMs(this.cfg.model)
        )) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? "";
        // Reasoning starvation: the model spent the ENTIRE completion budget on
        // hidden reasoning and returned no visible content (finish_reason
        // "length"). Long grounded prompts trigger this on gpt-5/o-series at the
        // 4000-token seed. Retry ONCE with 4x the budget; if it still comes back
        // empty, return "" and let the caller refuse to emit an empty test.
        if (!content.trim() && choice?.finish_reason === "length" && !tried.has("starved")) {
          tried.add("starved");
          maxTokens = maxTokens * 4;
          continue;
        }
        return content;
      } catch (e) {
        // Switch to the token param the API explicitly asked for (once) — never guess,
        // so a reasoning model is never flipped onto max_tokens by an unrelated 400.
        const want = wantedTokenParam(e);
        if (want && want !== tokenParam && !tried.has("token-swap")) {
          tried.add("token-swap");
          tokenParam = want;
          continue;
        }
        if (temperatureRejected(e) && sendTemperature && !tried.has("temp-drop")) {
          tried.add("temp-drop");
          sendTemperature = false;
          continue;
        }
        throw e;
      }
    }
  }
}

/** Ollama local-model adapter (no API key). */
export class OllamaProvider implements ModelProvider {
  readonly providerName = "ollama";
  constructor(private readonly cfg: ProviderConfig, private readonly fetchImpl: FetchLike = fetch) {}
  get modelName(): string {
    return this.cfg.model;
  }
  async complete(req: ModelCompletionRequest): Promise<string> {
    const data = (await postJson(this.fetchImpl, `${this.cfg.baseUrl}/api/chat`, {}, {
      model: this.cfg.model,
      stream: false,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user }
      ]
    })) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }
}

/** Anthropic Messages API adapter. */
export class AnthropicProvider implements ModelProvider {
  readonly providerName = "anthropic";
  constructor(private readonly cfg: ProviderConfig, private readonly fetchImpl: FetchLike = fetch) {}
  get modelName(): string {
    return this.cfg.model;
  }
  async complete(req: ModelCompletionRequest): Promise<string> {
    const data = (await postJson(
      this.fetchImpl,
      `${this.cfg.baseUrl}/messages`,
      { "x-api-key": this.cfg.apiKey ?? "", "anthropic-version": "2023-06-01" },
      {
        model: this.cfg.model,
        max_tokens: req.maxTokens ?? 900,
        temperature: req.temperature ?? 0.2,
        system: req.system,
        messages: [{ role: "user", content: req.user }]
      }
    )) as { content?: Array<{ text?: string }> };
    return (data.content ?? []).map((c) => c.text ?? "").join("");
  }
}

/**
 * Deterministic, offline provider. Used when no BYOK credentials are present
 * (tests + offline internal validation). It renders the grounded prompt into a
 * framework-hinted scaffold whose specificity tracks the evidence it was given —
 * so a grounded prompt yields concrete assertions while a bare raw-prompt
 * baseline collapses to a generic smoke test. Clearly labeled as deterministic.
 */
export class DeterministicProvider implements ModelProvider {
  readonly providerName = "deterministic";
  readonly modelName = "orangepro-local-deterministic-v0";
  async complete(req: ModelCompletionRequest): Promise<string> {
    return renderDeterministic(req.user);
  }
}

function extractSection(text: string, label: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (new RegExp(`^${label}:`, "i").test(line.trim())) {
      inSection = true;
      const inline = line.split(":").slice(1).join(":").trim();
      if (inline) out.push(inline);
      continue;
    }
    if (inSection) {
      // A section ends at the next ALL-CAPS header — with or without a trailing
      // parenthetical (e.g. "EXISTING TESTS (already covered ...):"). Without the
      // `(` alternative, prompt-v1 sections bled into the previous extraction.
      if (/^[A-Z][A-Z _]+\s*[(:]/.test(line.trim())) break;
      const item = line.replace(/^[-*\d.\s]+/, "").trim();
      if (item) out.push(item);
    }
  }
  return out;
}

function snakeIdent(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "behavior";
}

function pascalIdent(text: string): string {
  const s = text
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z]/.test(s) ? s : "Behavior";
}

function goStringLiteral(text: string): string {
  return JSON.stringify(text);
}

function camelIdent(text: string): string {
  const p = pascalIdent(text);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function renderDeterministic(user: string): string {
  const behavior = extractSection(user, "BEHAVIOR")[0] || "the target behavior";
  const framework = (extractSection(user, "FRAMEWORK")[0] || "vitest").toLowerCase();
  const criteria = extractSection(user, "ACCEPTANCE CRITERIA");
  const assertions = criteria.length
    ? criteria
    : ["the primary expected outcome is observable"]; // generic fallback for raw baseline
  return renderSkeleton(framework, behavior, assertions);
}

/**
 * The offline stand-in's body: VALID, runnable framework code (NOT Markdown).
 * It is a grounded skeleton — names the behavior, lists the acceptance criteria as
 * a comment, and includes one trivially-passing placeholder assertion so the file
 * compiles and runs. A real BYOK model replaces the placeholder with concrete
 * assertions; imports for the grounded arm are prepended by synthesizeImports.
 */
function renderSkeleton(framework: string, behavior: string, assertions: string[]): string {
  // Escape for embedding in a double-quoted JS string: backslash FIRST, then quote,
  // so titles with Windows paths / regex (\d, \U) or quotes can't emit invalid code.
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const title = esc(behavior);
  const first = esc(assertions[0] ?? "behaves as specified");
  const ac = assertions.join("; ");

  if (framework.includes("pytest") || framework.includes("python")) {
    return [
      `def test_${snakeIdent(behavior)}():`,
      // Behavior + acceptance go in line comments (no docstring) so backslashes or
      // embedded quotes in the title can never break the Python source.
      `    # ${behavior}`,
      `    # acceptance: ${ac}`,
      "    # TODO: arrange + act on the subject under test, then assert the real outcome.",
      "    assert True  # placeholder — replace with a concrete assertion",
      ""
    ].join("\n");
  }

  if (framework.includes("go")) {
    return [
      "package main",
      "",
      "import \"testing\"",
      "",
      `func Test${pascalIdent(behavior)}(t *testing.T) {`,
      `\t// ${behavior}`,
      `\t// acceptance: ${ac}`,
      "\t// TODO: arrange + act on the subject under test, then assert the real outcome.",
      "\tif false {",
      `\t\tt.Fatalf("expected %q", ${goStringLiteral(first)})`,
      "\t}",
      "}",
      ""
    ].join("\n");
  }

  if (framework.includes("junit") || framework.includes("java")) {
    const className = `${pascalIdent(behavior)}Test`;
    if (framework.includes("junit4")) {
      return [
        "import org.junit.Test;",
        "",
        "import static org.junit.Assert.assertTrue;",
        "",
        `class ${className} {`,
        "  @Test",
        `  public void ${camelIdent(behavior)}() {`,
        `    // ${behavior}`,
        `    // acceptance: ${ac}`,
        "    // TODO: arrange + act on the subject under test, then assert the real outcome.",
        `    assertTrue(${JSON.stringify(`expected ${first}`)}, true);`,
        "  }",
        "}",
        ""
      ].join("\n");
    }
    return [
      "import org.junit.jupiter.api.Test;",
      "",
      "import static org.junit.jupiter.api.Assertions.assertTrue;",
      "",
      `class ${className} {`,
      "  @Test",
      `  void ${camelIdent(behavior)}() {`,
      `    // ${behavior}`,
      `    // acceptance: ${ac}`,
      "    // TODO: arrange + act on the subject under test, then assert the real outcome.",
      `    assertTrue(true, ${JSON.stringify(`expected ${first}`)});`,
      "  }",
      "}",
      ""
    ].join("\n");
  }

  if (framework.includes("playwright")) {
    return [
      `test("${title}", async ({ page }) => {`,
      `  // acceptance: ${ac}`,
      "  // TODO: navigate (page.goto), interact, then assert the real outcome.",
      "  expect(true).toBeTruthy(); // placeholder — replace with a concrete assertion",
      "});",
      ""
    ].join("\n");
  }

  if (framework.includes("cypress")) {
    return [
      `describe("${title}", () => {`,
      `  it("${first}", () => {`,
      `    // acceptance: ${ac}`,
      "    // TODO: drive the UI with cy.* and assert the real outcome.",
      '    cy.wrap(true).should("eq", true); // placeholder — replace with a concrete assertion',
      "  });",
      "});",
      ""
    ].join("\n");
  }

  if (framework.includes("ava")) {
    return [
      'import test from "ava";',
      "",
      `test("${title}", (t) => {`,
      `  // acceptance: ${ac}`,
      "  // TODO: arrange + act on the subject under test, then assert the real outcome.",
      "  t.true(true); // placeholder — replace with a concrete assertion",
      "});",
      ""
    ].join("\n");
  }

  // jest / vitest / mocha / generic
  return [
    `describe("${title}", () => {`,
    `  it("${first}", () => {`,
    `    // acceptance: ${ac}`,
    "    // TODO: arrange + act on the subject under test, then assert the real outcome.",
    "    expect(true).toBe(true); // placeholder — replace with a concrete assertion",
    "  });",
    "});",
    ""
  ].join("\n");
}

/**
 * Construct a real BYOK provider from a resolved config. Requires a non-null
 * config and throws on an unknown provider — it never silently falls back to the
 * deterministic stand-in. The deterministic provider must be requested
 * explicitly (`new DeterministicProvider()` at the call site) so the BYOK
 * contract cannot be reintroduced by accident.
 */
export function buildProvider(cfg: ProviderConfig, fetchImpl: FetchLike = fetch): ModelProvider {
  switch (cfg.provider) {
    case "openai":
      return new OpenAICompatibleProvider(cfg, fetchImpl);
    case "ollama":
      return new OllamaProvider(cfg, fetchImpl);
    case "anthropic":
      return new AnthropicProvider(cfg, fetchImpl);
    default:
      throw new Error(
        `Unknown model provider: ${String((cfg as ProviderConfig).provider)}. Use provider="deterministic" for the offline stand-in.`
      );
  }
}
