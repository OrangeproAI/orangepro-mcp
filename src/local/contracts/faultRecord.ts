import ts from "typescript";
import { parseErrorCount } from "../analyze/exportShapes.js";
import { validateLocation, type SourceLocation } from "./location.js";
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

/**
 * A fault given as its own edit: the place, the text there and the text written. Not in the
 * operator table and never named in `--fault`; planned by `planEdit`, with the same record.
 */
export const EDIT_OPERATOR = { id: "edit", version: 1, description: "replace the text at one place" } as const;
export type RecordedOperatorId = FaultOperatorId | typeof EDIT_OPERATOR.id;

/** The edit `planEdit` works on: byte offsets in the target file, the text there and the text written. */
export interface FaultEdit {
  start: number;
  end: number;
  original_text: string;
  replacement_text: string;
}

/**
 * What `--fault-edit` reads, and what an add-on may propose in place of an operator: the
 * target's location in the one exact-position format, with its `edit`, and the original
 * text beside it (the location holds only that text's hash).
 */
export interface FaultEditInput {
  location: SourceLocation;
  original_text: string;
}

/** Shape check only; says what is wrong and never repairs. */
export function checkFaultEditInput(value: unknown): { ok: true; input: FaultEditInput } | { ok: false; message: string } {
  const fail = (message: string): { ok: false; message: string } => ({ ok: false, message: `fault edit: ${message}` });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("not a JSON object.");
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((key) => !["location", "original_text"].includes(key));
  if (unknown.length > 0) return fail(`unknown field(s): ${unknown.join(", ")}.`);
  const located = validateLocation(v.location);
  if (!located.ok) return fail(`location: ${located.reason}`);
  const edit = located.location.edit;
  if (!edit) return fail("the location has no edit.");
  if (typeof v.original_text !== "string" || v.original_text === "") return fail("original_text must be the non-empty text at that place.");
  if (sha256Hex(Buffer.from(v.original_text, "utf8")) !== edit.original_sha256) return fail("original_text is not the text the location's edit names (sha256 differs).");
  if (Buffer.byteLength(v.original_text, "utf8") !== edit.end - edit.start) return fail("original_text is not as long as the edit's span.");
  return { ok: true, input: { location: located.location, original_text: v.original_text } };
}

/**
 * The edit of a checked input, once its location is seen to be this target's own: the same
 * file, route, name, spans and hashes the engine reads from the file itself.
 */
export function editForTarget(input: FaultEditInput, own: SourceLocation): { ok: true; edit: FaultEdit } | { ok: false; message: string } {
  const bare = (loc: SourceLocation): string => {
    const { edit: _edit, ...rest } = loc;
    return JSON.stringify(Object.keys(rest).sort().map((key) => [key, (rest as Record<string, unknown>)[key]]));
  };
  if (bare(input.location) !== bare(own)) return { ok: false, message: "the edit's location is not this target's location (file, route, name, spans or hashes differ)." };
  const edit = input.location.edit!;
  return { ok: true, edit: { start: edit.start, end: edit.end, original_text: input.original_text, replacement_text: edit.replacement } };
}

export const FAULT_PLAN_REFUSALS = ["operator_not_allowed", "edit_outside_body", "edit_mismatch", "no_op_mutation", "not_parsable", "not_single_site", "edit_no_control"] as const;
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
  operator: { id: RecordedOperatorId; version: number };
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
  operator: RecordedOperatorId;
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

/** Node kinds that hold a list of statements: an edit whose smallest enclosing node is one of these spans more than one place. */
function holdsStatements(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node);
}

/** The tree as `treeShape` lists it, with the outermost node spanning exactly [start, end) written as one marker. Null when no node has that span. */
function shapeAround(sf: ts.SourceFile, start: number, end: number): string[] | null {
  const out: string[] = [];
  let found = false;
  const visit = (node: ts.Node): void => {
    if (!found && !ts.isSourceFile(node) && node.getStart(sf) === start && node.end === end) {
      out.push("site");
      found = true;
      return;
    }
    const raw = ts.isSourceFile(node) ? undefined : (node as { text?: unknown }).text;
    out.push(`${node.kind}:${typeof raw === "string" ? raw : ""}`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found ? out : null;
}

/**
 * Plan a fault given as its own edit. The same promises as `planFault`, without an operator
 * to lean on: the bytes at the place are the bytes named, the place lies strictly inside the
 * function's body, the result is a different program (not only different comments or spacing),
 * and outside the smallest syntax node that holds the whole edit the two files parse the same,
 * node for node and name for name. Writes nothing.
 */
export function planEdit(fileBytes: Buffer, target: TargetDescription, repoPath: string, edit: FaultEdit): FaultPlanResult {
  const refuse = (refused: FaultPlanRefusal, message: string): FaultPlanResult => ({ ok: false, refused, message });
  if (sha256Hex(fileBytes) !== target.file_sha256) return refuse("edit_mismatch", "the file is not the file the target was described from.");
  const body = target.body?.bytes;
  if (!body) return refuse("edit_outside_body", `${target.name} has no block body.`);
  const { start, end } = edit;
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && 0 <= start && start < end && end <= fileBytes.length)) {
    return refuse("edit_mismatch", `[${start}, ${end}) is not a span of the file.`);
  }
  const text = fileBytes.toString("utf8");
  const charStart = fileBytes.subarray(0, start).toString("utf8").length;
  const charEnd = fileBytes.subarray(0, end).toString("utf8").length;
  if (Buffer.byteLength(text.slice(0, charStart), "utf8") !== start || Buffer.byteLength(text.slice(0, charEnd), "utf8") !== end) {
    return refuse("edit_mismatch", `[${start}, ${end}) does not start and end on characters.`);
  }
  if (!fileBytes.subarray(start, end).equals(Buffer.from(edit.original_text, "utf8"))) {
    return refuse("edit_mismatch", `the text at [${start}, ${end}) is not the original text the edit names.`);
  }
  if (!(body.start < start && end < body.end - 1)) return refuse("edit_outside_body", `the edit [${start}, ${end}) does not lie strictly inside ${target.name}'s body [${body.start}, ${body.end}).`);
  const mutated = Buffer.concat([fileBytes.subarray(0, start), Buffer.from(edit.replacement_text, "utf8"), fileBytes.subarray(end)]);
  if (mutated.equals(fileBytes)) return refuse("no_op_mutation", "the edit leaves the file unchanged.");
  const sf = cleanParse(text);
  if (!sf) return refuse("not_parsable", "the file does not parse without errors, so no position in it can be trusted.");
  const mutatedText = mutated.toString("utf8");
  const mutatedSf = parseLike(mutatedText, sf);
  const parses = parseErrorCount(mutatedSf) === 0;
  if (parses) {
    const before = treeShape(sf);
    const after = treeShape(mutatedSf);
    if (before.length === after.length && before.every((entry, i) => entry === after[i])) {
      return refuse("no_op_mutation", "the edit changes comments or spacing only: the program is the same.");
    }
    // The smallest node that holds the whole edit.
    let holder: ts.Node = sf;
    const descend = (node: ts.Node): void => {
      ts.forEachChild(node, (child) => {
        if (child.getStart(sf) <= charStart && charEnd <= child.end) {
          holder = child;
          descend(child);
        }
      });
    };
    descend(sf);
    const bodyCharStart = fileBytes.subarray(0, body.start).toString("utf8").length;
    const bodyCharEnd = fileBytes.subarray(0, body.end).toString("utf8").length;
    const holderStart = holder.getStart(sf);
    if (holdsStatements(holder) || !(bodyCharStart < holderStart && holder.end < bodyCharEnd)) {
      return refuse("not_single_site", "the edit is not inside one statement or expression of the function: it spans more than one place.");
    }
    const deltaChars = mutatedText.length - text.length;
    const promised = shapeAround(sf, holderStart, holder.end);
    const actual = shapeAround(mutatedSf, holderStart, holder.end + deltaChars);
    if (!promised || !actual || promised.length !== actual.length || promised.some((entry, i) => entry !== actual[i])) {
      return refuse("not_single_site", "the edit changes how the code around it parses, not only that place.");
    }
  }
  const delta = mutated.length - fileBytes.length;
  const fn = target.function.bytes;
  return {
    ok: true,
    plan: {
      operator: EDIT_OPERATOR.id,
      site: { bytes: { start, end }, lines: { start: lineOf(fileBytes, start), end: lineOf(fileBytes, end - 1) } },
      original_text: edit.original_text,
      replacement_text: edit.replacement_text,
      original_site_sha256: sha256Hex(fileBytes.subarray(start, end)),
      mutated,
      mutated_file_sha256: sha256Hex(mutated),
      mutated_function_sha256: sha256Hex(mutated.subarray(fn.start, fn.end + delta)),
      parses,
      diff: unifiedFileDiff(repoPath, text, mutatedText)
    }
  };
}

/** Plan again the fault a run recorded, from the record alone: by its operator, or by its own edit. */
export function replanFromRecord(fileBytes: Buffer, target: TargetDescription, repoPath: string, record: Pick<FaultRecord, "operator" | "site" | "original_text" | "replacement_text">): FaultPlanResult {
  if (record.operator.id === EDIT_OPERATOR.id) {
    return planEdit(fileBytes, target, repoPath, { start: record.site.bytes.start, end: record.site.bytes.end, original_text: record.original_text, replacement_text: record.replacement_text });
  }
  return planFault(fileBytes, target, repoPath, record.operator.id, record.site.bytes.start);
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
    operator: { id: plan.operator, version: plan.operator === EDIT_OPERATOR.id ? EDIT_OPERATOR.version : FAULT_OPERATORS[plan.operator].version },
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
