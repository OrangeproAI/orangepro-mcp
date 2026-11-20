/**
 * F3a: what each model call used.
 *
 * Every provider call goes through one HTTP helper (generate/providers.ts). It reports the
 * model and the token counts the provider returned to the collector of the operation that is
 * running. The operation puts the total in its result and in `.orangepro/model-usage.json`,
 * so a spending cap can be checked against a file instead of guessed.
 *
 * Counts are the provider's own. A response that carries none is counted as a call with
 * unreported use, never as zero tokens.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ModelUsageByModel {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ModelUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** Calls whose response carried no token counts. Their use is not in the totals. */
  unreported_calls: number;
  by_model: ModelUsageByModel[];
}

class Collector {
  private readonly byModel = new Map<string, ModelUsageByModel>();
  private unreported = 0;
  constructor(private readonly parent?: Collector) {}

  record(model: string, input: number | undefined, output: number | undefined): void {
    this.parent?.record(model, input, output);
    const row = this.byModel.get(model) ?? { model, calls: 0, input_tokens: 0, output_tokens: 0 };
    row.calls += 1;
    if (input === undefined && output === undefined) this.unreported += 1;
    row.input_tokens += input ?? 0;
    row.output_tokens += output ?? 0;
    this.byModel.set(model, row);
  }

  summary(): ModelUsage {
    const by_model = [...this.byModel.values()].sort((a, b) => a.model.localeCompare(b.model)).map((row) => ({ ...row }));
    return {
      calls: by_model.reduce((sum, row) => sum + row.calls, 0),
      input_tokens: by_model.reduce((sum, row) => sum + row.input_tokens, 0),
      output_tokens: by_model.reduce((sum, row) => sum + row.output_tokens, 0),
      unreported_calls: this.unreported,
      by_model
    };
  }
}

const store = new AsyncLocalStorage<Collector>();

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/**
 * Called once per provider response, with the request body and the parsed response. Reads the
 * shapes providers use: `usage.input_tokens/output_tokens`, `usage.prompt_tokens/completion_tokens`,
 * and a local runner's `prompt_eval_count/eval_count`. Outside an operation it does nothing.
 */
export function recordModelCall(requestBody: unknown, response: unknown): void {
  const collector = store.getStore();
  if (!collector) return;
  const model = typeof (requestBody as { model?: unknown } | null)?.model === "string" ? (requestBody as { model: string }).model : "unknown";
  const data = (response ?? {}) as { usage?: Record<string, unknown>; prompt_eval_count?: unknown; eval_count?: unknown };
  const usage = data.usage ?? {};
  const input = count(usage.input_tokens) ?? count(usage.prompt_tokens) ?? count(data.prompt_eval_count);
  const output = count(usage.output_tokens) ?? count(usage.completion_tokens) ?? count(data.eval_count);
  collector.record(model, input, output);
}

/** The calls recorded so far in the running operation (zeros outside one). */
export function modelUsageSoFar(): ModelUsage {
  return (store.getStore() ?? new Collector()).summary();
}

/**
 * Runs one operation with its own collector. An operation started inside another reports to
 * both, so the outer total includes it. `outermost` tells the caller whether to write the file.
 */
export async function collectModelUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: ModelUsage; outermost: boolean }> {
  const parent = store.getStore();
  const collector = new Collector(parent);
  const result = await store.run(collector, fn);
  return { result, usage: collector.summary(), outermost: parent === undefined };
}

/** "Model use: 12 calls, 45,210 input and 6,880 output tokens (model-a 10, model-b 2)." Empty at zero calls. */
export function modelUsageLine(usage: ModelUsage | undefined): string {
  if (!usage || usage.calls === 0) return "";
  const n = (value: number): string => value.toLocaleString("en-US");
  const models = usage.by_model.map((row) => (usage.by_model.length === 1 ? row.model : `${row.model} ${n(row.calls)}`)).join(", ");
  const unreported = usage.unreported_calls > 0 ? `; ${n(usage.unreported_calls)} ${usage.unreported_calls === 1 ? "call" : "calls"} reported no token counts` : "";
  return `Model use: ${n(usage.calls)} ${usage.calls === 1 ? "call" : "calls"}, ${n(usage.input_tokens)} input and ${n(usage.output_tokens)} output tokens (${models})${unreported}.`;
}
