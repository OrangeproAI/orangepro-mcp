import { createHash } from "node:crypto";
import { listFunctionSites, type FunctionSite } from "../analyze/symbols.js";
import type { SeenBy, ShapeForm } from "../analyze/exportShapes.js";

// The changed-target record: what `opro changed-targets` hands to a proof run.
// Two parts with different trust:
//   - identity  — WHICH function, down to its bytes. Compared field by field.
//   - selection — WHY it was picked. Recomputed by the consumer, never trusted.
// A record is a claim: whoever receives one rebuilds it from the file, git and
// the graph and refuses on any difference. It holds no run id, clock time or
// absolute path (those belong to the run manifest), so two runs on the same
// commit produce byte-identical records.

export const TARGET_RECORD_VERSION = "orangepro.target_record.v1" as const;

/** Half-open `[start, end)` offsets into the file's raw bytes. */
export interface ByteSpan {
  start: number;
  end: number;
}

/** Closed 1-based line range, counted the way git counts lines (line feeds in the raw bytes). */
export interface LineSpan {
  start: number;
  end: number;
}

export interface SourceSpan {
  lines: LineSpan;
  bytes: ByteSpan;
}

/** How a function reaches the mutator. Decided by re-parsing the file, never by a flag on a graph node. */
export type MutationRoute = "bound" | "name_search" | "unsupported_shape";

export interface TargetDescription {
  /** Symbol name as in the graph id `sym:<file>#<name>`. */
  name: string;
  seen_by?: SeenBy;
  shape_form?: ShapeForm;
  fn_kind?: FunctionSite["fn_kind"];
  owner?: string;
  property?: string;
  /** How the owner is bound (`object_literal`, `object_create`, `function`, `class`, `const`). */
  owner_binding?: string;
  /** Assignment targets written before the function (`res.set`, `View.prototype.render`), members only. */
  targets?: string[];
  aliases?: string[];
  /** The definition: the top-level statement, the object-literal property, or the declaration. */
  statement: SourceSpan;
  /** The function-like node. */
  function: SourceSpan;
  /** The `{ … }` body, from its opening brace to just past its closing brace. Absent for an expression-bodied arrow. */
  body?: SourceSpan;
  file_sha256: string;
  function_sha256: string;
  mutation_route: MutationRoute;
}

export type DescribeRefusal = "not_utf8" | "line_rule_mismatch" | "symbol_not_found" | "not_a_function";

export type DescribeResult = { ok: true; target: TargetDescription } | { ok: false; refused: DescribeRefusal };

/** The helper a target was reached through (an `affected_through` record). */
export interface ViaHelper {
  symbol_id: string;
  function: SourceSpan;
  function_sha256: string;
  /** Symbol ids from the helper up to the target, in call order (helper first). */
  path: string[];
}

export interface TargetIdentity extends TargetDescription {
  merged_commit: string;
  /** Repo-relative directory of the nearest package manifest (`""` for the repository root). */
  package_root: string;
  /** Repo-relative path, in git's terms. */
  file: string;
  symbol_id: string;
  via_helper?: ViaHelper;
}

export const TARGET_REASONS = ["text_changed", "new_function", "affected_through"] as const;
export type TargetReason = (typeof TARGET_REASONS)[number];

export const TARGET_UNCERTAINTIES = ["owner_passed_to_call", "hunk_spans_boundary", "via_helper", "not_counted"] as const;
export type TargetUncertainty = (typeof TARGET_UNCERTAINTIES)[number];

export interface ChangedBlock {
  file: string;
  /** New-side lines of the block (`count` 0 = a pure deletion positioned after `start`). */
  new_start: number;
  new_count: number;
  old_start: number;
  old_count: number;
}

export interface TargetSelection {
  base_commit: string;
  /** How base relates to merged: its first parent, or any ancestor (a `--range` run). Rebuilt the same way. */
  mode: "first_parent" | "range";
  blocks: ChangedBlock[];
  reason: TargetReason;
  /** Position in the full, uncapped ranking; null when the function is not ranked. */
  rank: number | null;
  uncertainty: TargetUncertainty[];
  /** Whether the function's bytes differ between base and merged. Behavior change is not judged. */
  text_changed: boolean;
  change_kind: "text_not_classified";
}

export interface TargetRecord {
  version: typeof TARGET_RECORD_VERSION;
  identity: TargetIdentity;
  selection: TargetSelection;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The proof script's name search (`mutateMethod` in scripts/spikes/dynamic-proof-spike.mjs),
// repeated pattern for pattern so the route can be decided before any runner starts. It
// stops at the first `)` and has no word boundary before the name: `put(key = d()) {` is
// not matched, and the tail of `function input(key) {` is.
export function nameSearchPatterns(escaped: string): { method: string; freeFn: string } {
  return {
    method: `((?:async\\s+)?${escaped}\\s*(?:<[^\\n\\{]+>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\s*)\\{`,
    freeFn: `(^|\\n)([ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?::\\s*[^=\\n]+)?\\s*=\\s*(?:(?:async\\s+)?(?:<[^(\\n{]+>\\s*)?\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\s*=>\\s*|(?:async\\s+)?function\\s*(?:${escaped})?\\s*(?:<[^(\\n{]+>\\s*)?\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\s*)\\{)`
  };
}

/**
 * The `{ … }` the name search would replace for `method`, as half-open UTF-16 offsets
 * into `text`, or null when the search finds no definition, finds more than one (the
 * script's "Ambiguous method"), or its raw brace count never closes.
 */
export function nameSearchBody(text: string, method: string): [number, number] | null {
  const patterns = nameSearchPatterns(method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const opens = [
    ...[...text.matchAll(new RegExp(patterns.method, "gm"))].map((m) => m.index + m[0].length - 1),
    ...[...text.matchAll(new RegExp(patterns.freeFn, "gm"))].map((m) => m.index + m[1]!.length + m[2]!.length - 1)
  ];
  if (opens.length !== 1) return null;
  let depth = 0;
  for (let i = opens[0]!; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return [opens[0]!, i + 1];
  }
  return null;
}

/**
 * Which mutator may touch this function.
 *  - bound: prototype and exported-object members — changed by exact position.
 *  - name_search: declarations, const functions, class methods, and an object-literal
 *    method written `name(…) {` — today's search matches their real definition.
 *  - unsupported_shape: an object-literal property written `name: function` / `name: (…) =>`,
 *    an object-literal method whose key is not a plain identifier (`"name"(…) {`), and
 *    the unnamed default — the name search cannot find them and can change a
 *    different function, so every prove path refuses before any search runs.
 *
 * A function 0.2.58 already sees (no `seen_by`) keeps the name search exactly as it
 * is. A newly visible one may use it only when the search lands on its own body, to
 * the byte: the search is run here on `text` (the file as the script reads it), and
 * no match, several matches or any other span is `unsupported_shape` too.
 */
export function mutationRouteOf(
  site: Pick<FunctionSite, "name" | "seen_by" | "shape_form" | "fn_kind" | "key_is_identifier" | "body">,
  text: string
): MutationRoute {
  if (site.shape_form === "member" || site.shape_form === "prototype") return "bound";
  if (site.shape_form === "unnamed_default") return "unsupported_shape";
  if (site.shape_form === "literal_inline" && !(site.fn_kind === "method" && site.key_is_identifier === true)) return "unsupported_shape";
  if (!site.seen_by) return "name_search";
  // The name the runner is given: the last segment of the symbol name.
  const picked = nameSearchBody(text, site.name.split(".").filter(Boolean).pop() ?? site.name);
  return picked !== null && site.body !== undefined && picked[0] === site.body[0] && picked[1] === site.body[1] ? "name_search" : "unsupported_shape";
}

/**
 * The mutation route alone, or null when the file does not show `symbolName` as a
 * function. Unlike `describeTarget` it answers for a file that is not valid UTF-8 or
 * breaks the line rule, so a caller can tell which symbols those two refusals apply
 * to (the bound and unsupported shapes) and which keep the name search's behaviour.
 *
 * An exported `name: function` whose key is also a top-level binding emits no symbol
 * (`name_collision`). Asked about that name, the answer is still `unsupported_shape`:
 * the name search would find the other binding and change that function instead.
 */
export function mutationRouteFor(fileBytes: Buffer, symbolName: string): MutationRoute | null {
  const text = fileBytes.toString("utf8");
  const { sites, not_supported } = listFunctionSites(text);
  const site = sites.find((candidate) => candidate.name === symbolName);
  if (site) return site.fn ? mutationRouteOf(site, text) : null;
  return not_supported.some((entry) => entry.code === "name_collision" && entry.name === symbolName) ? "unsupported_shape" : null;
}

// A lone carriage return, U+2028 or U+2029: line breaks to the TypeScript scanner, not to git.
const LINE_RULE_MISMATCH_RE = new RegExp(`\\r(?!\\n)|[${String.fromCharCode(0x2028, 0x2029)}]`);

/**
 * Re-derive one symbol's definition from the file's raw bytes. Never reads the
 * graph: the caller compares what comes back with whatever it was told.
 */
export function describeTarget(fileBytes: Buffer, symbolName: string): DescribeResult {
  const text = fileBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(fileBytes)) return { ok: false, refused: "not_utf8" };
  // git counts a line at every line feed; the TypeScript scanner also breaks at a
  // lone carriage return and at U+2028/U+2029. A file containing one of those
  // would get two different line numbers for the same byte.
  if (LINE_RULE_MISMATCH_RE.test(text)) return { ok: false, refused: "line_rule_mismatch" };
  const site = listFunctionSites(text).sites.find((candidate) => candidate.name === symbolName);
  if (!site) return { ok: false, refused: "symbol_not_found" };
  if (!site.fn) return { ok: false, refused: "not_a_function" };
  // UTF-16 offset → byte offset, and → git line, in one pass over the sorted cut points.
  const cuts = [...new Set([...site.statement, ...site.fn, ...(site.body ?? [])])].sort((a, b) => a - b);
  const byteAt = new Map<number, number>();
  const lineAt = new Map<number, number>();
  let bytes = 0;
  let line = 1;
  let previous = 0;
  for (const cut of cuts) {
    const chunk = text.slice(previous, cut);
    bytes += Buffer.byteLength(chunk, "utf8");
    for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) line++;
    byteAt.set(cut, bytes);
    lineAt.set(cut, line);
    previous = cut;
  }
  const span = ([start, end]: [number, number]): SourceSpan => {
    // The end offset is exclusive: its line is the line of the last byte inside the span.
    const lastChar = Math.max(start, end - 1);
    let endLine = lineAt.get(end) as number;
    if (end > start && text.charCodeAt(lastChar) === 10) endLine--;
    return {
      lines: { start: lineAt.get(start) as number, end: Math.max(lineAt.get(start) as number, endLine) },
      bytes: { start: byteAt.get(start) as number, end: byteAt.get(end) as number }
    };
  };
  const fn = span(site.fn);
  const dot = site.member_of ? site.name.indexOf(".") : -1;
  return {
    ok: true,
    target: {
      name: site.name,
      ...(site.seen_by ? { seen_by: site.seen_by } : {}),
      ...(site.shape_form ? { shape_form: site.shape_form } : {}),
      ...(site.fn_kind ? { fn_kind: site.fn_kind } : {}),
      ...(site.member_of ? { owner: site.member_of } : {}),
      ...(dot >= 0 ? { property: site.name.slice(dot + 1) } : {}),
      ...(site.owner_binding ? { owner_binding: site.owner_binding } : {}),
      ...(site.targets ? { targets: site.targets } : {}),
      ...(site.aliases ? { aliases: site.aliases } : {}),
      statement: span(site.statement),
      function: fn,
      ...(site.body ? { body: span(site.body) } : {}),
      file_sha256: sha256Hex(fileBytes),
      function_sha256: sha256Hex(fileBytes.subarray(fn.bytes.start, fn.bytes.end)),
      mutation_route: mutationRouteOf(site, text)
    }
  };
}

export type FileRuleRefusal = Extract<DescribeRefusal, "not_utf8" | "line_rule_mismatch">;

/**
 * Why a file's bytes cannot be read as text with git's line numbers, or null
 * when they can — the two whole-file refusals of `describeTarget`, for a caller
 * that has to decide before it knows any symbol name.
 */
export function fileRuleRefusal(fileBytes: Buffer): FileRuleRefusal | null {
  const text = fileBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(fileBytes)) return "not_utf8";
  return LINE_RULE_MISMATCH_RE.test(text) ? "line_rule_mismatch" : null;
}
