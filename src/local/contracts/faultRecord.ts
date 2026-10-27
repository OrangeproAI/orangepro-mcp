import ts from "typescript";
import { parseErrorCount } from "../analyze/exportShapes.js";
import { sha256Hex, type ByteSpan, type LineSpan, type TargetDescription } from "./targetRecord.js";

// A fault: a few bytes changed at one recorded position inside a bound function body
// (`fault-record.json`). Planned and checked here before any copy is made, written to the
// run folder before any test runs, and never changed afterwards: every later stage names
// its hash. What the runs observed goes to the run's classification, not here. The record
// holds no clock time, run id or absolute path, so the same plan gives the same bytes.

export const FAULT_RECORD_VERSION = "orangepro.fault_record.v1" as const;

/**
 * The closed operator table. An operator is added only when a selected case needs it.
 * Each names the one kind of syntax node it may change and the bytes it writes.
 */
export const FAULT_OPERATORS = {
  rounding_floor_ceil: {
    version: 1,
    description: "swap the rounding direction: Math.floor <-> Math.ceil"
  },
  negation_removal: {
    version: 1,
    description: "remove the ! of a unary negation"
  }
} as const;
export type FaultOperatorId = keyof typeof FAULT_OPERATORS;

export const FAULT_PLAN_REFUSALS = ["operator_not_allowed", "edit_outside_body", "edit_mismatch", "no_op_mutation", "not_parsable", "not_single_site"] as const;
export type FaultPlanRefusal = (typeof FAULT_PLAN_REFUSALS)[number];

export interface FaultRecord {
  version: typeof FAULT_RECORD_VERSION;
  target_record_sha256: string;
  oracle_sha256: string;
  symbol_id: string;
  /** Repo-relative path, in git's terms. */
  file: string;
  file_sha256: string;
  function_sha256: string;
  operator: { id: FaultOperatorId; version: number };
  rationale: string;
  site: { bytes: ByteSpan; lines: LineSpan };
  original_text: string;
  replacement_text: string;
  original_site_sha256: string;
  mutated_file_sha256: string;
  mutated_function_sha256: string;
  diff: { path: "diagnostic-fault.patch"; sha256: string };
  validity: { parse: "ok" | "error"; checked_by: string; only_site_changed: true };
}

export interface FaultPlan {
  operator: FaultOperatorId;
  site: { bytes: ByteSpan; lines: LineSpan };
  original_text: string;
  replacement_text: string;
  original_site_sha256: string;
  mutated: Buffer;
  mutated_file_sha256: string;
  mutated_function_sha256: string;
  /** Whether the mutated file still parses. A plan that does not is an invalid mutation, not a refusal. */
  parses: boolean;
  /** `git apply`-able diff of the one file, with repo-relative paths. */
  diff: string;
}

export type FaultPlanResult = { ok: true; plan: FaultPlan } | { ok: false; refused: FaultPlanRefusal; message: string };

/** `<operator>@<byte offset>`, e.g. `rounding_floor_ceil@18560`. */
export function parseFaultSpec(spec: string): { operator: FaultOperatorId; offset: number } | null {
  const match = /^([a-z_]+)@(0|[1-9]\d*)$/.exec(spec.trim());
  if (!match || !Object.prototype.hasOwnProperty.call(FAULT_OPERATORS, match[1]!)) return null;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) ? { operator: match[1] as FaultOperatorId, offset } : null;
}

/** A clean parse of the file, the way A1's positions were read: TS first, then TSX. */
function cleanParse(text: string): ts.SourceFile | null {
  for (const kind of [ts.ScriptKind.TS, ts.ScriptKind.TSX]) {
    const sf = ts.createSourceFile(kind === ts.ScriptKind.TS ? "fault.ts" : "fault.tsx", text, ts.ScriptTarget.Latest, true, kind);
    if (parseErrorCount(sf) === 0) return sf;
  }
  return null;
}

function parseLike(text: string, like: ts.SourceFile): ts.SourceFile {
  const kind = like.fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(like.fileName, text, ts.ScriptTarget.Latest, false, kind);
}

type ShapeEdit = { kind: "unwrap"; node: ts.PrefixUnaryExpression } | { kind: "rename"; node: ts.Node; to: string };

/**
 * The tree as a list of node kinds and names, in order. With an edit, the tree as the
 * operator promises it: the negation replaced by its operand, or the one name renamed.
 * Two files whose lists are equal differ in nothing else a parser can see.
 */
function treeShape(sf: ts.SourceFile, edit?: ShapeEdit): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (edit?.kind === "unwrap" && node === edit.node) {
      visit(edit.node.operand);
      return;
    }
    // Names and literal values; the source file node's own `text` is the whole file and is not a value.
    const raw = ts.isSourceFile(node) ? undefined : (node as { text?: unknown }).text;
    const text = edit?.kind === "rename" && node === edit.node ? edit.to : typeof raw === "string" ? raw : "";
    out.push(`${node.kind}:${text}`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every node of the operator's kind that starts exactly at `charIndex`. */
function nodesAt(sf: ts.SourceFile, charIndex: number, operator: FaultOperatorId): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node.getStart(sf) === charIndex) {
      if (
        operator === "rounding_floor_ceil" &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Math" &&
        (node.name.text === "floor" || node.name.text === "ceil") &&
        !node.questionDotToken
      ) {
        found.push(node);
      }
      if (operator === "negation_removal" && ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        found.push(node);
      }
    }
    if (node.pos <= charIndex && charIndex < node.end) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function lineOf(bytes: Buffer, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

const DIFF_CONTEXT_LINES = 3;

/** One-hunk unified diff with a `diff --git` header, so `git apply` takes it from the repository root. */
export function unifiedFileDiff(repoPath: string, before: string, after: string): string {
  const split = (text: string): string[] => {
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    else lines[lines.length - 1] += "\n\\ No newline at end of file";
    return lines;
  };
  const a = split(before);
  const b = split(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head === a.length && head === b.length) return "";
  const from = Math.max(0, head - DIFF_CONTEXT_LINES);
  const leading = a.slice(from, head);
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const trailing = a.slice(a.length - tail, a.length - tail + Math.min(tail, DIFF_CONTEXT_LINES));
  const oldCount = leading.length + removed.length + trailing.length;
  const newCount = leading.length + added.length + trailing.length;
  return [
    `diff --git a/${repoPath} b/${repoPath}`,
    `--- a/${repoPath}`,
    `+++ b/${repoPath}`,
    `@@ -${oldCount === 0 ? from : from + 1},${oldCount} +${newCount === 0 ? from : from + 1},${newCount} @@`,
    ...leading.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...trailing.map((line) => ` ${line}`),
    ""
  ].join("\n");
}

/**
 * Plan one fault inside `target` (a description rebuilt from these same bytes). The span
 * must lie strictly inside the function's body and be exactly one syntax node of the
 * operator's kind, so never in a comment, a string, a regular expression or a template.
 * Writes nothing.
 */
export function planFault(fileBytes: Buffer, target: TargetDescription, repoPath: string, operator: FaultOperatorId, offset: number): FaultPlanResult {
  const refuse = (refused: FaultPlanRefusal, message: string): FaultPlanResult => ({ ok: false, refused, message });
  if (!Object.prototype.hasOwnProperty.call(FAULT_OPERATORS, operator)) return refuse("operator_not_allowed", `${operator} is not in the operator table.`);
  if (sha256Hex(fileBytes) !== target.file_sha256) return refuse("edit_mismatch", "the file is not the file the target was described from.");
  const body = target.body?.bytes;
  if (!body) return refuse("edit_outside_body", `${target.name} has no block body.`);
  const text = fileBytes.toString("utf8");
  const charIndex = fileBytes.subarray(0, offset).toString("utf8").length;
  if (offset > fileBytes.length || Buffer.byteLength(text.slice(0, charIndex), "utf8") !== offset) {
    return refuse("edit_mismatch", `byte ${offset} is not the start of a character.`);
  }
  const sf = cleanParse(text);
  if (!sf) return refuse("not_parsable", "the file does not parse without errors, so no position in it can be trusted.");
  const nodes = nodesAt(sf, charIndex, operator);
  if (nodes.length !== 1) {
    return refuse("edit_mismatch", `byte ${offset} is not the start of exactly one ${operator === "rounding_floor_ceil" ? "Math.floor/Math.ceil access" : "unary !"} in code (found ${nodes.length}).`);
  }
  const node = nodes[0]!;
  let originalText: string;
  let replacementText: string;
  if (operator === "rounding_floor_ceil") {
    const access = node as ts.PropertyAccessExpression;
    originalText = text.slice(charIndex, access.getEnd());
    if (originalText !== `Math.${access.name.text}`) return refuse("edit_mismatch", "the access is not written as plain Math.floor or Math.ceil.");
    replacementText = access.name.text === "floor" ? "Math.ceil" : "Math.floor";
  } else {
    originalText = "!";
    replacementText = "";
  }
  const start = offset;
  const end = offset + Buffer.byteLength(originalText, "utf8");
  if (!(body.start < start && end < body.end - 1)) return refuse("edit_outside_body", `the edit [${start}, ${end}) does not lie strictly inside ${target.name}'s body [${body.start}, ${body.end}).`);
  const mutated = Buffer.concat([fileBytes.subarray(0, start), Buffer.from(replacementText, "utf8"), fileBytes.subarray(end)]);
  if (mutated.equals(fileBytes)) return refuse("no_op_mutation", "the edit leaves the file unchanged.");
  const delta = Buffer.byteLength(replacementText, "utf8") - (end - start);
  const fn = target.function.bytes;
  const mutatedText = mutated.toString("utf8");
  // The change must be the operator's change and nothing more. Without semicolons, removing a `!` at the
  // start of a line can join it to the line before; before a regular expression it can open a comment.
  const mutatedSf = parseLike(mutatedText, sf);
  const parses = parseErrorCount(mutatedSf) === 0;
  if (parses) {
    const promised =
      operator === "negation_removal"
        ? treeShape(sf, { kind: "unwrap", node: node as ts.PrefixUnaryExpression })
        : treeShape(sf, { kind: "rename", node: (node as ts.PropertyAccessExpression).name, to: replacementText.slice("Math.".length) });
    const actual = treeShape(mutatedSf);
    if (promised.length !== actual.length || promised.some((entry, i) => entry !== actual[i])) {
      return refuse("not_single_site", `removing or renaming at byte ${offset} changes how the surrounding code parses, not only that site.`);
    }
  }
  return {
    ok: true,
    plan: {
      operator,
      site: { bytes: { start, end }, lines: { start: lineOf(fileBytes, start), end: lineOf(fileBytes, end - 1) } },
      original_text: originalText,
      replacement_text: replacementText,
      original_site_sha256: sha256Hex(fileBytes.subarray(start, end)),
      mutated,
      mutated_file_sha256: sha256Hex(mutated),
      mutated_function_sha256: sha256Hex(mutated.subarray(fn.start, fn.end + delta)),
      parses,
      diff: unifiedFileDiff(repoPath, text, mutatedText)
    }
  };
}

/** The deterministic record of a planned fault. */
export function faultRecordOf(
  plan: FaultPlan,
  ctx: { target_record_sha256: string; oracle_sha256: string; symbol_id: string; file: string; file_sha256: string; function_sha256: string; rationale: string }
): FaultRecord {
  return {
    version: FAULT_RECORD_VERSION,
    target_record_sha256: ctx.target_record_sha256,
    oracle_sha256: ctx.oracle_sha256,
    symbol_id: ctx.symbol_id,
    file: ctx.file,
    file_sha256: ctx.file_sha256,
    function_sha256: ctx.function_sha256,
    operator: { id: plan.operator, version: FAULT_OPERATORS[plan.operator].version },
    rationale: ctx.rationale,
    site: plan.site,
    original_text: plan.original_text,
    replacement_text: plan.replacement_text,
    original_site_sha256: plan.original_site_sha256,
    mutated_file_sha256: plan.mutated_file_sha256,
    mutated_function_sha256: plan.mutated_function_sha256,
    diff: { path: "diagnostic-fault.patch", sha256: sha256Hex(Buffer.from(plan.diff, "utf8")) },
    validity: { parse: plan.parses ? "ok" : "error", checked_by: `typescript ${ts.version}`, only_site_changed: true }
  };
}
