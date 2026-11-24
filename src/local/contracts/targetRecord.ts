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

/**
 * How a function reaches the mutator. Decided by re-parsing the file, never by a flag on a graph node.
 * There is no search by name: every function OrangePro changes is changed at its exact position
 * (`bound` or `position`, see contracts/location.ts), or refused.
 */
export type MutationRoute = "bound" | "position" | "unsupported_shape";

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
  /** Position route only: the name the function is declared under (`default` for an unnamed default export). */
  declared_name?: string;
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

/**
 * The name a function is declared under, as written before its body: the last segment
 * of the symbol name, or of one of its aliases, found there as a whole name. An unnamed
 * default export is `default`. Null when none is written there, which means the
 * parser's span does not show the function under any of its names.
 */
export function declaredNameOf(site: Pick<FunctionSite, "name" | "aliases" | "shape_form" | "statement" | "fn" | "body">, text: string): string | null {
  if (!site.fn || !site.body) return null;
  const signature = text.slice(Math.min(site.statement[0], site.fn[0]), site.body[0]);
  if (site.shape_form === "unnamed_default") return /^export\s+default\b/.test(signature) ? "default" : null;
  const last = (name: string) => name.split(".").filter(Boolean).pop() ?? name;
  for (const name of [site.name, ...(site.aliases ?? [])].map(last)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\p{ID_Continue}$\\u200c\\u200d#])${escaped}(?![\\p{ID_Continue}$\\u200c\\u200d])`, "u").test(signature)) return name;
  }
  return null;
}

/**
 * Which mutator may touch this function.
 *  - bound: prototype and exported-object members (`owner.name = function`), changed by
 *    exact position and checked against the names assigned before them.
 *  - position: every other function the parser binds (declarations, const functions,
 *    class and object-literal methods, `name: function`, the unnamed default, the
 *    implementation of an overloaded function), changed by exact position and checked
 *    against its own bytes and its declared name. A function without a block body is
 *    on this route too and is refused as `no_block_body` before any runner starts.
 *  - unsupported_shape: the declared name is not written before the parser's body
 *    span, so the position cannot be confirmed.
 */
export function mutationRouteOf(
  site: Pick<FunctionSite, "name" | "aliases" | "shape_form" | "statement" | "fn" | "body">,
  text: string
): MutationRoute {
  if (site.shape_form === "member" || site.shape_form === "prototype") return "bound";
  if (!site.body) return "position";
  return declaredNameOf(site, text) !== null ? "position" : "unsupported_shape";
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
export function describeTarget(fileBytes: Buffer, symbolName: string, opts: { helpers?: boolean } = {}): DescribeResult {
  const text = fileBytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(fileBytes)) return { ok: false, refused: "not_utf8" };
  // git counts a line at every line feed; the TypeScript scanner also breaks at a
  // lone carriage return and at U+2028/U+2029. A file containing one of those
  // would get two different line numbers for the same byte.
  if (LINE_RULE_MISMATCH_RE.test(text)) return { ok: false, refused: "line_rule_mismatch" };
  // `helpers`: only to describe the helper a change came through. A helper is never a target itself.
  const site = listFunctionSites(text, opts).sites.find((candidate) => candidate.name === symbolName);
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
      ...((): Pick<TargetDescription, "mutation_route" | "declared_name"> => {
        const route = mutationRouteOf(site, text);
        const declared = route === "position" ? declaredNameOf(site, text) : null;
        return declared ? { mutation_route: route, declared_name: declared } : { mutation_route: route };
      })()
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
