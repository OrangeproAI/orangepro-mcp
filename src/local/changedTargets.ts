import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { GENERATED_CODE_REASON, isNonProductPath, languageOf, roleOf } from "./analyze/classify.js";
import { parseErrorCount, type NotSupportedEntry } from "./analyze/exportShapes.js";
import { extractSymbolsWithMeta, listFunctionSites } from "./analyze/symbols.js";
import {
  TARGET_RECORD_VERSION,
  TARGET_UNCERTAINTIES,
  describeTarget,
  fileRuleRefusal,
  type ChangedBlock,
  type FileRuleRefusal,
  type LineSpan,
  type TargetDescription,
  type TargetReason,
  type TargetRecord,
  type TargetUncertainty,
  type ViaHelper
} from "./contracts/targetRecord.js";
import { canonicalJson } from "./contracts/io.js";
import type { GraphNode, LocalGraph } from "./graph/ontology.js";
import { builtInRankExclusion } from "./score/rankEligibility.js";
import { rankRiskGaps } from "./score/risk.js";
import { globToRegExp, loadRiskConfig } from "./score/riskConfig.js";
import { hashBuffer } from "./util/hash.js";
import { WORKSPACE_DIR, loadGraph, workspacePaths } from "./workspace.js";

/**
 * `opro changed-targets --base <sha> --merged <sha>`: map the lines one merged
 * change touched to exact functions, and hand each selected function over as a
 * target record (contracts/targetRecord.ts). Read-only: it runs git, reads the
 * graph and the checkout, and writes nothing.
 *
 * Three rules shape everything below:
 *  - It refuses instead of answering for another state: the graph, `HEAD` and
 *    the checkout must all be the merged commit, byte for byte — every file the
 *    graph was analysed from, not only the changed ones.
 *  - Every changed file ends in at least one row. A code line the kit cannot bind
 *    to a function is reported as `unknown` with a named cause, never guessed,
 *    and any `unknown` marks the run incomplete. A blank line, or one that lies
 *    wholly inside a comment, is not code: it is ignored when mapping — unless
 *    the file's functions differ in a way no block shows (a comment delimiter
 *    that switches unchanged lines off or on, a `@private` tag).
 *  - "Changed" means the function's text differs from the base. Whether its
 *    behavior changed is not judged.
 */

/** Runs git in `cwd` and returns its raw stdout, or null when git fails. */
export type GitBytes = (cwd: string, args: string[]) => Buffer | null;

export const gitBytes: GitBytes = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 1024 });
  } catch {
    return null;
  }
};

export interface ChangedTargetsOptions {
  base?: string;
  merged?: string;
  /** Accept a base that is an ancestor of merged but not its first parent; the output then says "range". */
  range?: boolean;
  /** How many functions are selected (default 3). */
  limit?: number;
}

export interface ChangedTargetsDeps {
  git?: GitBytes;
}

export const DEFAULT_TARGET_LIMIT = 3;

export const CHANGED_TARGETS_REFUSALS = [
  "missing_argument",
  "graph_missing",
  "not_a_git_repo",
  "base_not_a_commit",
  "merged_not_a_commit",
  "not_first_parent",
  "base_not_ancestor",
  "head_mismatch",
  "graph_commit_mismatch",
  "dirty_tree",
  "file_hash_mismatch",
  "graph_not_from_commit",
  "not_utf8",
  "line_rule_mismatch",
  "record_failed",
  "git_failed"
] as const;
export type ChangedTargetsRefusal = (typeof CHANGED_TARGETS_REFUSALS)[number];

export interface ChangedTargetsRefused {
  status: "refused";
  refused: ChangedTargetsRefusal;
  message: string;
  /** Repo-relative paths the refusal is about (first few, sorted). */
  paths?: string[];
}

/** Why a changed file has no block rows. The kit cannot say what such a change affects, so each one is an `unknown`. */
export const FILE_ROW_CODES = [
  "no_text_diff",
  "file_not_scanned",
  "outside_scan_root",
  "other_language",
  "file_deleted",
  "submodule",
  "mode_only"
] as const;
export type FileRowCode = (typeof FILE_ROW_CODES)[number];

export interface ChangedFileRow {
  /**
   * Repo-relative path, in git's terms (the old path for a deletion). A code file
   * renamed to a path that is not code, or that lies outside the scan root, gets a
   * second row under its old path: `file_deleted`.
   */
  path: string;
  /** Where a renamed file came from. */
  old_path?: string;
  /** Git's status letter for the file (A, M, D, R, T, …). */
  change: string;
  /** `blocks`: the file's rows are in the block table. `unknown`: this is its only row. */
  status: "blocks" | "unknown";
  unknown?: FileRowCode;
  blocks: number;
}

/**
 * Most specific first: when a block has several causes, the first one here is its `unknown`.
 *  - `comment_changes_code`: the block's own lines are blank or comment text, but the file's
 *    code differs between base and merged in a way no block shows — a comment delimiter that
 *    switches unchanged lines off or on, or a tag that changes what a function is.
 *  - `unmapped_change`: the same finding in a file that has no comment-only block to carry it.
 *  - `unsupported_shape`: the line is inside a shape the kit does not map, or the change
 *    reaches a counted caller that is not a function a record can bind.
 */
export const UNKNOWN_BLOCK_CODES = [
  "symbol_removed",
  "comment_changes_code",
  "unsupported_shape",
  "unrecognised_function",
  "module_level",
  "unmapped_change",
  "no_caller_link"
] as const;
export type UnknownBlockCode = (typeof UNKNOWN_BLOCK_CODES)[number];

export type BlockStatus = "mapped" | "unknown" | "non_code" | "test_file" | "config_file" | "doc_file";

export interface ChangedBlockRow extends ChangedBlock {
  /** `non_code`: every changed line is blank or comment text — listed, not unknown, and no function is mapped. */
  status: BlockStatus;
  /** With `unknown`: the cause. */
  unknown?: UnknownBlockCode;
  /** Further causes, when one block has more than one. */
  unknown_also?: UnknownBlockCode[];
  /**
   * With `comment_changes_code` or `unmapped_change`: symbols of the file that exist, read or
   * are tagged differently at base and merged while no block maps to them. Absent when the
   * difference is in code outside every symbol.
   */
  differs?: string[];
  /** Symbol ids the block maps to. Present with `unknown` too, when part of the block is inside a function. */
  symbols?: string[];
  /** The block is not inside one single function: it maps to each function it touches. */
  spans_boundary?: boolean;
  /** With `symbol_removed`: symbols of the base file that the block's old lines touch and the merged file no longer has. */
  removed?: string[];
  /** With `no_caller_link`: candidate (MAY_CALL) links into the helper. The kit found no hard link; it does not say no caller exists. */
  weak_callers?: number;
}

/** `unsupported_shape`: a ranked function whose definition is not a function a record can bind (a const bound to a call result). */
export type ListedReason = "overlap_text_unchanged" | "beyond_cut" | "not_counted" | "rank_excluded" | "suppressed_by_config" | "unsupported_shape";

/** A function the run found but did not select. */
export interface ListedFunction {
  symbol_id: string;
  /** Repo-relative path, in git's terms. */
  file: string;
  /** The function's lines at merged, when its file was re-parsed in this run. */
  lines?: LineSpan;
  reason: ListedReason;
  /** With `not_counted`: code that is listed and never followed to its callers. */
  detail?: "test_code" | "generated_code" | "type_declaration";
  /** Position in the full ranking; null when the function is not ranked. */
  rank: number | null;
  text_changed: boolean;
  /** What the function was listed as. Absent when its text is unchanged and nothing reaches it. */
  change?: TargetReason;
  /** A changed function that is not counted, whose hard callers were walked. */
  followed?: boolean;
  /** With `followed`: the counted functions that walk reached. */
  callers?: string[];
  /** Changed helpers this function is reached from. */
  affected_through?: string[];
  /** Symbol ids from the nearest helper up to this function. */
  path?: string[];
  steps?: number;
  /** `owner_passed_to_call` is reported on records only: it needs the file's parse. */
  uncertainty: TargetUncertainty[];
  blocks: ChangedBlock[];
}

export interface ChangedTargetsOk {
  status: "ok";
  base: string;
  merged: string;
  mode: "first_parent" | "range";
  /** False when any file or block is `unknown`. */
  complete: boolean;
  limit: number;
  files: ChangedFileRow[];
  blocks: ChangedBlockRow[];
  /** The selected functions, in selection order. */
  targets: TargetRecord[];
  listed: ListedFunction[];
}

export type ChangedTargetsResult = ChangedTargetsOk | ChangedTargetsRefused;

// Pinned so two machines cut the same blocks: no context, no heuristics, no
// external or text-conversion drivers, renames at git's 50% similarity.
const GIT_GLOBAL_ARGS = ["--no-pager", "--no-optional-locks", "-c", "core.quotePath=false"];
const RENAME_ARGS = ["-M50%"];
const BLOCK_DIFF_ARGS = [
  "-U0",
  "--inter-hunk-context=0",
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
  "--no-ext-diff",
  "--no-textconv",
  ...RENAME_ARGS
];
const SUBMODULE_MODE = "160000";
/** Written next to `.orangepro/` by workspace init (workspace.ts). */
const WORKSPACE_IGNORE_FILE = ".orangeproignore";
const PACKAGE_MANIFEST = "package.json";
const HELPER_MAX_STEPS = 2;
const MAX_REFUSAL_PATHS = 20;
const HEX_ID_RE = /^[0-9a-f]{4,64}$/i;
const TYPE_DECLARATION_RE = /\.d\.[cm]?ts$/;

/** Code-unit order: the same on every machine, unlike a locale comparison. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface RawRow {
  oldMode: string;
  newMode: string;
  oldId: string;
  newId: string;
  status: string;
  path: string;
  oldPath?: string;
}

/** `git diff --raw -z`: `:<modes> <ids> <status>\0<path>\0`, with a second path for a rename or copy. */
function parseRawDiff(out: Buffer): RawRow[] | null {
  const fields = out.toString("utf8").split("\0");
  const rows: RawRow[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === "") continue;
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(fields[i]);
    const first = fields[++i];
    if (!meta || first === undefined) return null;
    const row = { oldMode: meta[1], newMode: meta[2], oldId: meta[3], newId: meta[4], status: meta[5] };
    if (row.status === "R" || row.status === "C") {
      const second = fields[++i];
      if (second === undefined) return null;
      rows.push({ ...row, path: second, oldPath: first });
    } else {
      rows.push({ ...row, path: first });
    }
  }
  return rows;
}

type Hunk = Omit<ChangedBlock, "file">;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Only hunk headers are read: every other line of a patch body starts with `+`, `-`, a space or a backslash. */
function parseHunks(patch: Buffer): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of patch.toString("latin1").split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    hunks.push({
      new_start: Number(m[3]),
      new_count: m[4] === undefined ? 1 : Number(m[4]),
      old_start: Number(m[1]),
      old_count: m[2] === undefined ? 1 : Number(m[2])
    });
  }
  return hunks;
}

/** The id git gives these bytes as a blob: equal ids mean the commit holds exactly these bytes. */
function blobId(bytes: Buffer, idLength: number): string {
  return createHash(idLength === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

interface SiteSpan {
  name: string;
  /** `other`: a symbol with no function node that is not a class (a const bound to a call result). */
  kind: "function" | "class" | "other";
  lines: LineSpan;
  /** Text of the function node, or of the whole definition when there is none. */
  text: string;
  /** Code on the function's first line before it (its assignment targets), and on its last line after it; another symbol's function there is left out. */
  before: string;
  after: string;
  /** The whole definition as code — comments and whitespace dropped — without the definitions nested in it. */
  code: string;
  owner?: string;
}

interface ParsedSource {
  sites: SiteSpan[];
  byName: Map<string, SiteSpan>;
  notSupported: NotSupportedEntry[];
  /** Lines of every function-like node with a body, symbol or not. */
  functionLike: LineSpan[];
  /** Names passed as a direct argument of a call made at module level. */
  callArguments: Set<string>;
  lineCount: number;
  /** Whether a line is not code: blank, or every non-whitespace character on it is comment text. */
  nonCode(line: number): boolean;
  /** What each character of a line is: part of a token, comment text, or neither. */
  lineShape(line: number): Uint8Array;
  /** Whether a line lies inside the definition of a symbol. */
  inDefinition(line: number): boolean;
  /** Every symbol of the file with its `@private` / `@internal` tag. Read on demand: it costs a second extraction. */
  privateTags(): Map<string, boolean>;
}

/**
 * One file as this command reads it. Lines are counted the way git counts them
 * (line feeds only); the caller has already refused a file where the TypeScript
 * scanner would count differently.
 */
function parseSource(text: string, fileName: string): ParsedSource {
  const lineFeeds: number[] = [];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lineFeeds.push(at);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineFeeds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineFeeds[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  // The end offset is exclusive: its line is the line of the last character inside the span.
  const linesOf = (start: number, end: number): LineSpan => ({ start: lineOf(start), end: lineOf(Math.max(start, end - 1)) });

  const lineStart = (line: number): number => (line <= 1 ? 0 : lineFeeds[line - 2] + 1);
  const lineEnd = (line: number): number => (line <= lineFeeds.length ? lineFeeds[line - 1] : text.length);

  // The file name carries the extension, so the parser picks the grammar the file is written in.
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const functionLike: LineSpan[] = [];
  const callArguments = new Set<string>();
  const visit = (node: ts.Node, moduleLevel: boolean): void => {
    const hasBody =
      ts.isClassStaticBlockDeclaration(node) ||
      ((ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
        node.body !== undefined);
    if (hasBody) functionLike.push(linesOf(node.getStart(sf), node.getEnd()));
    if (moduleLevel && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      for (const arg of node.arguments ?? []) if (ts.isIdentifier(arg)) callArguments.add(arg.text);
    }
    ts.forEachChild(node, (child) => visit(child, moduleLevel && !hasBody));
  };
  visit(sf, true);

  // What each character is: part of a token, comment text, or neither. Comments
  // are looked for only in the gaps between two tokens of the parsed file, so
  // `//` inside a string, a template, a regular expression or JSX text is part of
  // a token and never read as a comment.
  const TOKEN = 1;
  const COMMENT = 2;
  const charKind = new Uint8Array(text.length);
  const tokenStart = new Uint8Array(text.length);
  const markGap = (from: number, to: number): void => {
    if (to <= from) return;
    const mark = (start: number, end: number): void => {
      if (start >= from && end <= to) charKind.fill(COMMENT, start, end);
    };
    // After a token, comments on its own line are its trailing ones; the leading scan starts at the next line.
    if (from > 0) ts.forEachTrailingCommentRange(text, from, mark);
    ts.forEachLeadingCommentRange(text, from, mark);
  };
  let cursor = 0;
  const walkTokens = (node: ts.Node): void => {
    // A JSDoc block is attached to its node as a child, but it is comment text.
    const children = node.getChildren(sf).filter((child) => !ts.isJSDoc(child));
    if (children.length > 0) {
      for (const child of children) walkTokens(child);
      return;
    }
    const start = node.getStart(sf);
    const end = node.getEnd();
    if (start < cursor) return;
    markGap(cursor, start);
    charKind.fill(TOKEN, start, end);
    if (end > start) tokenStart[start] = 1;
    cursor = Math.max(cursor, end);
  };
  walkTokens(sf);
  markGap(cursor, text.length);
  const lineCount = lineFeeds.length + 1;
  // In a file its own grammar cannot read without errors, which lines are comments
  // is not known: every line counts as code.
  const readsCleanly = parseErrorCount(sf) === 0;
  // The line's own line feed is looked at too: inside a multi-line template an
  // empty line is part of the string, not a blank line between statements.
  const nonCode = (line: number): boolean => {
    if (!readsCleanly || line < 1 || line > lineCount) return false;
    const end = Math.min(text.length, lineEnd(line) + 1);
    for (let at = lineStart(line); at < end; at++) {
      if (charKind[at] === TOKEN) return false;
      if (charKind[at] !== COMMENT && !ts.isWhiteSpaceLike(text.charCodeAt(at))) return false;
    }
    return true;
  };
  const lineShape = (line: number): Uint8Array =>
    line < 1 || line > lineCount ? new Uint8Array(0) : charKind.subarray(lineStart(line), Math.min(text.length, lineEnd(line) + 1));

  // Code as the parser's own tokens, one space between two of them: the same
  // code reads the same however it is spaced, wrapped or commented.
  const tokensIn = (from: number, to: number, keep: (at: number) => boolean): string[] => {
    const tokens: string[] = [];
    let run = -1;
    for (let at = from; at <= to; at++) {
      const inside = at < to && charKind[at] === TOKEN && keep(at);
      if (run >= 0 && (!inside || tokenStart[at] === 1)) {
        tokens.push(text.slice(run, at));
        run = -1;
      }
      if (inside && run < 0) run = at;
    }
    return tokens;
  };
  const listed = listFunctionSites(text);
  // Each character belongs to the innermost definition around it, so a class is
  // read without its methods. Larger definitions are painted first.
  const definitions = [...new Map(listed.sites.map((site) => [site.statement.join(":"), site.statement])).values()].sort(
    (a, b) => b[1] - b[0] - (a[1] - a[0]) || a[0] - b[0]
  );
  const definitionAt = new Int32Array(text.length).fill(-1);
  const definitionLine = new Uint8Array(lineCount + 2);
  definitions.forEach(([start, end], index) => {
    definitionAt.fill(index, start, end);
    const lines = linesOf(start, end);
    definitionLine.fill(1, lines.start, lines.end + 1);
  });
  const definitionIndex = new Map(definitions.map((span, index) => [span.join(":"), index]));
  // Two functions can share a line: the code beside one of them is what belongs to
  // neither. A separator alone is not code beside it: the comma a literal's last
  // method gains when another is added after it changes nothing.
  const functionAt = new Uint8Array(text.length);
  for (const site of listed.sites) if (site.fn) functionAt.fill(1, site.fn[0], site.fn[1]);
  const beside = (from: number, to: number): string =>
    tokensIn(from, to, (at) => functionAt[at] === 0)
      .filter((token) => token !== "," && token !== ";")
      .join(" ");
  const sites = listed.sites.map((site): SiteSpan => {
    const [start, end] = site.fn ?? site.statement;
    const lines = linesOf(start, end);
    const own = definitionIndex.get(site.statement.join(":"));
    return {
      name: site.name,
      kind: site.fn ? "function" : site.symbol_kind === "class" ? "class" : "other",
      lines,
      text: text.slice(start, end),
      before: beside(lineStart(lines.start), start),
      after: beside(end, lineEnd(lines.end)),
      code: tokensIn(site.statement[0], site.statement[1], (at) => definitionAt[at] === own).join(" "),
      ...(site.member_of ? { owner: site.member_of } : {})
    };
  });
  let tags: Map<string, boolean> | undefined;
  const privateTags = (): Map<string, boolean> =>
    (tags ??= new Map(extractSymbolsWithMeta(text).symbols.map((symbol) => [symbol.name, symbol.documented_private === true])));

  return {
    sites,
    byName: new Map(sites.map((site) => [site.name, site])),
    notSupported: listed.not_supported,
    functionLike,
    callArguments,
    lineCount,
    nonCode,
    lineShape,
    inDefinition: (line) => line >= 1 && line <= lineCount && definitionLine[line] === 1,
    privateTags
  };
}

/** The innermost functions a span test accepts; a class is the answer only when no function is. */
function innermost(sites: SiteSpan[], inside: (span: LineSpan) => boolean): SiteSpan[] {
  for (const kind of ["function", "class"] as const) {
    let best: SiteSpan[] = [];
    let size = Number.POSITIVE_INFINITY;
    for (const site of sites) {
      if (site.kind !== kind || !inside(site.lines)) continue;
      const lines = site.lines.end - site.lines.start;
      if (lines < size) {
        best = [site];
        size = lines;
      } else if (lines === size) {
        best.push(site);
      }
    }
    if (best.length > 0) return best;
  }
  return [];
}

interface BlockMapping {
  /** Names of the graph symbols the block maps to. */
  names: string[];
  unknown: Set<UnknownBlockCode>;
  spansBoundary: boolean;
  removed: string[];
  /** Every changed line, new and old, is blank or comment text. */
  nonCode: boolean;
}

/**
 * Where one block lands in the merged file.
 *  - A blank line, or one that lies wholly inside a comment, is not code. It is
 *    ignored: it never makes a block unknown and never maps to a function. A
 *    block made only of such lines, on both sides, is `non_code`.
 *  - Each new code line goes to the innermost graph function containing it.
 *  - When code was removed and no code line took its place, the change sits
 *    where the removed lines were: between new lines c and c+1 for a pure
 *    deletion, on the comment or blank lines that replaced them otherwise. It
 *    maps only when that place is inside one function.
 *  - A line (or place) inside no graph function is named by what it is inside: a
 *    shape the kit reports as not supported, a function that is not a symbol, or
 *    nothing (module level).
 *  - Lines are whole, functions are not: the code beside a function on its first
 *    or last line (its assignment targets, a second statement) is not the
 *    function's. When that code differs from the base, the line also changed at
 *    module level. Code that only moved with the function is the same code.
 *  - Old code lines that belong to a base symbol the merged file no longer has say so.
 */
function mapBlock(hunk: Hunk, merged: ParsedSource, bound: SiteSpan[], base: ParsedSource | null): BlockMapping {
  const names = new Set<string>();
  const unknown = new Set<UnknownBlockCode>();
  const groups = new Set<string>();
  const probe = (first: number, last: number): void => {
    const inside = (span: LineSpan): boolean => span.start <= first && last <= span.end;
    const owners = innermost(bound, inside);
    if (owners.length > 0) {
      for (const owner of owners) names.add(owner.name);
      groups.add(owners.map((owner) => owner.name).join("\n"));
      if (owners.length > 1) groups.add("\n");
      return;
    }
    groups.add("");
    if (
      bound.some((site) => site.kind === "other" && inside(site.lines)) ||
      merged.notSupported.some((entry) => inside({ start: entry.start_line, end: entry.end_line }))
    ) {
      unknown.add("unsupported_shape");
    } else if (merged.functionLike.some(inside)) {
      unknown.add("unrecognised_function");
    } else {
      unknown.add("module_level");
    }
  };
  const newLast = hunk.new_start + hunk.new_count - 1;
  const oldLast = hunk.old_start + hunk.old_count - 1;
  let newCode = false;
  for (let line = hunk.new_start; line <= newLast; line++) {
    if (merged.nonCode(line)) continue;
    newCode = true;
    probe(line, line);
  }
  const removedCodeIn = (first: number, last: number): boolean => {
    for (let line = first; base !== null && line <= last; line++) if (!base.nonCode(line)) return true;
    return false;
  };
  const removedCode = removedCodeIn(hunk.old_start, oldLast);
  if (!newCode && removedCode) {
    if (hunk.new_count === 0) probe(hunk.new_start, hunk.new_start + 1);
    else probe(hunk.new_start, newLast);
  }
  // A hunk that replaces lines shows where its NEW lines land. Code it removed that
  // sat outside every definition of the base (a module-level statement, or a function
  // that is not a symbol) belongs to none of the functions the new lines map to.
  if (base && newCode && removedCode) {
    for (let line = hunk.old_start; line <= oldLast; line++) {
      if (base.nonCode(line)) continue;
      const inside = (span: LineSpan): boolean => span.start <= line && line <= span.end;
      if (base.sites.some((site) => inside(site.lines))) continue;
      unknown.add(base.functionLike.some(inside) ? "unrecognised_function" : "module_level");
    }
  }
  const touches = (line: number): boolean => hunk.new_start <= line && line <= newLast;
  for (const name of names) {
    const now = merged.byName.get(name) as SiteSpan;
    const was = base?.byName.get(name);
    if (!was) continue;
    if ((touches(now.lines.start) && now.before !== was.before) || (touches(now.lines.end) && now.after !== was.after)) unknown.add("module_level");
  }

  const removed: string[] = [];
  if (base && removedCode) {
    for (const site of base.sites) {
      if (!merged.byName.has(site.name) && removedCodeIn(Math.max(site.lines.start, hunk.old_start), Math.min(site.lines.end, oldLast))) removed.push(site.name);
    }
    if (removed.length > 0) unknown.add("symbol_removed");
  }
  return {
    names: [...names].sort(byCodeUnit),
    unknown,
    spansBoundary: names.size > 0 && groups.size > 1,
    removed: removed.sort(byCodeUnit),
    nonCode: !newCode && !removedCode
  };
}

/**
 * The safety net behind the per-line mapping: what differs between the base and
 * merged versions of one file while no block says so. A hunk shows its own lines
 * only, and a `/*` or a `@private` tag on a comment line changes code it does not
 * touch. Compared, with comments and whitespace out of the way:
 *  - which symbols the file has;
 *  - each definition's own code;
 *  - each symbol's `@private` / `@internal` tag;
 *  - every unchanged line outside a definition: the same text must still be the
 *    same thing (code, comment or string) on both sides.
 * `carried` says whether a block already accounts for a symbol, as one it maps to
 * or one it reports removed.
 */
function unshownDifferences(
  hunks: Hunk[],
  base: ParsedSource,
  merged: ParsedSource,
  carried: (name: string) => boolean
): { names: string[]; outside: boolean } {
  const names = new Set<string>();
  for (const site of base.sites) if (!merged.byName.has(site.name)) names.add(site.name);
  for (const site of merged.sites) {
    const was = base.byName.get(site.name);
    if (!was || was.code !== site.code) names.add(site.name);
  }
  const tagsBefore = base.privateTags();
  for (const [name, tagged] of merged.privateTags()) if (tagsBefore.has(name) && tagsBefore.get(name) !== tagged) names.add(name);

  let outside = false;
  let oldLine = 1;
  let newLine = 1;
  const compare = (count: number): void => {
    for (let k = 0; k < count && !outside; k++) {
      if (base.inDefinition(oldLine + k) && merged.inDefinition(newLine + k)) continue;
      const before = base.lineShape(oldLine + k);
      const after = merged.lineShape(newLine + k);
      outside = before.length !== after.length || before.some((kind, at) => kind !== after[at]);
    }
  };
  for (const hunk of hunks) {
    // A side with no lines names the line the change sits after.
    const oldFirst = hunk.old_count === 0 ? hunk.old_start + 1 : hunk.old_start;
    const newFirst = hunk.new_count === 0 ? hunk.new_start + 1 : hunk.new_start;
    compare(newFirst - newLine);
    oldLine = oldFirst + hunk.old_count;
    newLine = newFirst + hunk.new_count;
  }
  compare(merged.lineCount - newLine + 1);
  return { names: [...names].filter((name) => !carried(name)).sort(byCodeUnit), outside };
}

interface BlockDraft {
  block: ChangedBlock;
  role: "code" | "test" | "config" | "doc";
  symbols: string[];
  unknown: Set<UnknownBlockCode>;
  spansBoundary: boolean;
  removed: string[];
  nonCode: boolean;
  weakCallers: number;
  /** Symbols whose difference no block shows (see `unshownDifferences`). */
  differs: string[];
}

interface MappedFunction {
  id: string;
  name: string;
  /** Scan-root-relative path, as in the graph. */
  rel: string;
  node: GraphNode;
  /** False for a class: a record binds a function. */
  bindable: boolean;
  lines: LineSpan;
  /** Null when the text is identical at base. */
  change: "text_changed" | "new_function" | null;
  blocks: BlockDraft[];
}

interface Candidate {
  id: string;
  node: GraphNode;
  reason: TargetReason;
  rank: number;
  blocks: BlockDraft[];
  lines?: LineSpan;
  /** Reached through changed helpers: helper id → symbol ids from that helper up to this function. */
  through?: Map<string, string[]>;
}

/** The name in a symbol id `sym:<file>#<name>`. A `#` can be part of a file name, never of a name: the last one divides the two. */
function nameInId(symbolId: string): string {
  return symbolId.slice(symbolId.lastIndexOf("#") + 1);
}

function fileOfSymbol(node: GraphNode): string {
  if (typeof node.properties.file === "string") return node.properties.file;
  const id = node.external_id.replace(/^sym:/, "");
  return id.includes("#") ? id.slice(0, id.lastIndexOf("#")) : id;
}

/** The nearest helper: fewest steps, then the helper's id. */
function nearestHelper(through: Map<string, string[]>): { helper: string; path: string[] } {
  const [helper, path] = [...through.entries()].sort((a, b) => a[1].length - b[1].length || byCodeUnit(a[0], b[0]))[0];
  return { helper, path };
}

function blocksOf(drafts: Iterable<BlockDraft>): ChangedBlock[] {
  return [...new Set(drafts)]
    .map((draft) => draft.block)
    .sort((a, b) => byCodeUnit(a.file, b.file) || a.new_start - b.new_start || a.old_start - b.old_start);
}

function orderedUncertainty(found: Iterable<TargetUncertainty>): TargetUncertainty[] {
  const set = new Set(found);
  return TARGET_UNCERTAINTIES.filter((uncertainty) => set.has(uncertainty));
}

/** What only the record check changes: it rebuilds one named function, and may be told the checkout holds other work. */
interface MapMode {
  cleanTree: boolean;
  /** Build the record of this function only, wherever the cut would fall. */
  only?: string;
}

export function opChangedTargets(root: string, opts: ChangedTargetsOptions = {}, deps: ChangedTargetsDeps = {}): ChangedTargetsResult {
  return mapChange(root, opts, deps, { cleanTree: true });
}

function mapChange(root: string, opts: ChangedTargetsOptions, deps: ChangedTargetsDeps, mapMode: MapMode): ChangedTargetsResult {
  const refuse = (refused: ChangedTargetsRefusal, message: string, paths: string[] = []): ChangedTargetsRefused => ({
    status: "refused",
    refused,
    message,
    ...(paths.length > 0 ? { paths: [...new Set(paths)].sort(byCodeUnit).slice(0, MAX_REFUSAL_PATHS) } : {})
  });
  if (!opts.base || !opts.merged) return refuse("missing_argument", "Pass both --base <sha> and --merged <sha>.");
  const limit = typeof opts.limit === "number" && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_TARGET_LIMIT;

  const workspace = workspacePaths(root);
  let graph: LocalGraph;
  try {
    graph = loadGraph(workspace.graphPath);
  } catch {
    return refuse("graph_missing", "No usable graph in this workspace. Run `opro analyze` on the merged commit first.");
  }
  const scanRoot = graph.workspace.root;
  const run = deps.git ?? gitBytes;
  const git = (args: string[], cwd: string = scanRoot): Buffer | null => run(cwd, [...GIT_GLOBAL_ARGS, ...args]);
  const gitLine = (args: string[], cwd?: string): string | null => {
    const out = git(args, cwd);
    return out === null ? null : out.toString("utf8").replace(/\r?\n$/, "");
  };

  // ---- Preconditions: answer only for the merged commit, as analysed and as checked out ----
  if (gitLine(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return refuse("not_a_git_repo", "The analysed source is not a git checkout, so there is no merged change to map.");
  }
  const top = gitLine(["rev-parse", "--show-toplevel"]);
  // Paths are matched in git's own terms: the scan root's prefix inside the repository, never an absolute path.
  const prefix = gitLine(["rev-parse", "--show-prefix"]);
  if (!top || prefix === null) return refuse("not_a_git_repo", "git could not locate the repository of the analysed source.");

  // A commit id only (full or a unique abbreviation), and it must be the commit
  // it names: a branch, a tag object or `HEAD~1` can move or peel to something else.
  const resolveCommit = (id: string): string | null => {
    if (!HEX_ID_RE.test(id)) return null;
    const full = gitLine(["rev-parse", "--verify", "--quiet", `${id}^{commit}`]);
    return full && full.startsWith(id.toLowerCase()) ? full : null;
  };
  const base = resolveCommit(opts.base);
  if (!base) return refuse("base_not_a_commit", "--base must be the id of a commit in this repository (full, or a unique abbreviation).");
  const merged = resolveCommit(opts.merged);
  if (!merged) return refuse("merged_not_a_commit", "--merged must be the id of a commit in this repository (full, or a unique abbreviation).");

  const mode: ChangedTargetsOk["mode"] = opts.range ? "range" : "first_parent";
  if (opts.range) {
    if (git(["merge-base", "--is-ancestor", base, merged]) === null) {
      return refuse("base_not_ancestor", `${base} is not an ancestor of ${merged}, so the two do not bound one range of changes.`);
    }
  } else if (gitLine(["rev-parse", "--verify", "--quiet", `${merged}^1^{commit}`]) !== base) {
    return refuse("not_first_parent", `${base} is not the first parent of ${merged}. Pass --range to map everything between the two.`);
  }

  const head = gitLine(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head !== merged) return refuse("head_mismatch", `HEAD is ${head ?? "unknown"}, not the merged commit ${merged}. Check out the merged commit first.`);
  const graphCommit = graph.manifest.git?.commit;
  if (!graphCommit || graphCommit.length < 40 || !merged.startsWith(graphCommit)) {
    return refuse("graph_commit_mismatch", `The graph was built at ${graphCommit ?? "no recorded commit"}, not at the merged commit ${merged}. Run \`opro analyze\` again.`);
  }

  // Clean means clean: the only paths tolerated are the kit's own workspace
  // files — `.orangepro/` (as run reuse excludes it) and the ignore file
  // workspace init writes beside it, untracked. Computed here, at command time:
  // the graph's own `dirty` flag is true for those two alone.
  const ownDirs = [`${prefix}${WORKSPACE_DIR}/`];
  const ownIgnoreFiles: string[] = [];
  const workspacePrefix = gitLine(["rev-parse", "--show-prefix"], workspace.root);
  if (workspacePrefix !== null && gitLine(["rev-parse", "--show-toplevel"], workspace.root) === top) {
    ownDirs.push(`${workspacePrefix}${WORKSPACE_DIR}/`);
    ownIgnoreFiles.push(`${workspacePrefix}${WORKSPACE_IGNORE_FILE}`);
  }
  if (mapMode.cleanTree) {
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status === null) return refuse("git_failed", "git status failed.");
    const dirty: string[] = [];
    const statusFields = status.toString("utf8").split("\0");
    for (let i = 0; i < statusFields.length; i++) {
      const entry = statusFields[i];
      if (!entry) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename lists its source as the next NUL-separated field.
      if (code[0] === "R" || code[0] === "C") i += 1;
      if (ownDirs.some((dir) => path.startsWith(dir))) continue;
      if (code === "??" && ownIgnoreFiles.includes(path)) continue;
      dirty.push(path);
    }
    if (dirty.length > 0) {
      return refuse("dirty_tree", "The checkout has modified or untracked files, so it is not the merged commit. Commit, stash or remove them first.", dirty);
    }
  }

  // ---- The file list ----
  const raw = git(["diff", "--raw", "-z", "--no-abbrev", ...RENAME_ARGS, base, merged], top);
  const rows = raw === null ? null : parseRawDiff(raw);
  if (rows === null) return refuse("git_failed", "git diff --raw failed or printed something unexpected.");
  rows.sort((a, b) => byCodeUnit(a.path, b.path));

  // For every changed file in the graph: the commit's bytes, the working file's
  // bytes and the hash the graph recorded must all agree.
  const workingBytes = new Map<string, Buffer>();
  const readWorking = (rel: string): Buffer | null => {
    try {
      return readFileSync(join(scanRoot, rel));
    } catch {
      return null;
    }
  };
  const disagreement = (rel: string, commitId: string): string | null => {
    const recorded = graph.manifest.files[rel]?.hash;
    const bytes = readWorking(rel);
    if (bytes === null) return "the working file is missing";
    if (blobId(bytes, commitId.length) !== commitId) return "the working file differs from the commit";
    if (recorded !== hashBuffer(bytes)) return "the graph was built from different bytes";
    workingBytes.set(rel, bytes);
    return null;
  };
  const scanned = (path: string): string | null => {
    if (!path.startsWith(prefix)) return null;
    const rel = path.slice(prefix.length);
    return graph.manifest.files[rel] ? rel : null;
  };
  // A caller whose checkout rightly holds other work (the record check before a
  // proof) may have edited a test, config or doc file since: only code is compared.
  const compared = (rel: string): boolean => mapMode.cleanTree || roleOf(rel) === "code";
  const stale: string[] = [];
  let staleWhy = "";
  for (const row of rows) {
    const rel = scanned(row.path);
    if (rel === null || row.oldMode === SUBMODULE_MODE || row.newMode === SUBMODULE_MODE || !compared(rel)) continue;
    const why = row.status === "D" ? "the graph still lists a file the merged commit deleted" : disagreement(rel, row.newId);
    if (why === null) continue;
    stale.push(row.path);
    staleWhy ||= why;
  }
  if (stale.length > 0) {
    return refuse("file_hash_mismatch", `A changed file is not the same in the commit, the checkout and the graph (${staleWhy}). Run \`opro analyze\` on a clean checkout of the merged commit.`, stale);
  }

  // The same for every other file the graph was analysed from: links and ranks
  // come from all of them. One listing of the merged tree, one read per file.
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", merged], top);
  if (tree === null) return refuse("git_failed", "git ls-tree failed.");
  const committed = new Map<string, string>();
  const gitlinks: string[] = [];
  for (const entry of tree.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [entryMode, , id] = entry.slice(0, tab).split(" ");
    if (entryMode === SUBMODULE_MODE) gitlinks.push(`${entry.slice(tab + 1)}/`);
    else committed.set(entry.slice(tab + 1), id);
  }
  const gitPathOf = (rel: string): string => `${prefix}${rel}`;
  const foreign: string[] = [];
  let foreignWhy = "";
  for (const [rel, recorded] of Object.entries(graph.manifest.files)) {
    if (workingBytes.has(rel) || !compared(rel)) continue;
    const path = gitPathOf(rel);
    const id = committed.get(path);
    // The kit's own workspace files, as in the clean-tree check above.
    if (ownDirs.some((dir) => path.startsWith(dir)) || (id === undefined && ownIgnoreFiles.includes(path))) continue;
    const bytes = readWorking(rel);
    // A file inside a submodule belongs to the commit through its link; its bytes are that repository's.
    const why =
      id === undefined && !gitlinks.some((dir) => path.startsWith(dir))
        ? "the merged commit does not have the file"
        : bytes === null
          ? "the working file is missing"
          : recorded.hash !== hashBuffer(bytes)
            ? "the graph was built from different bytes"
            : id !== undefined && blobId(bytes, id.length) !== id
              ? "the working file differs from the commit"
              : null;
    if (why === null) continue;
    foreign.push(path);
    foreignWhy ||= why;
  }
  if (foreign.length > 0) {
    return refuse(
      "graph_not_from_commit",
      `The graph was analysed from ${foreign.length} file(s) that are not the merged commit's (${foreignWhy}). Run \`opro analyze\` on a clean checkout of the merged commit.`,
      foreign
    );
  }

  // ---- File rows and blocks ----
  const symbolNodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) if (node.kind === "CodeSymbol") symbolNodes.set(node.external_id, node);
  const files: ChangedFileRow[] = [];
  const drafts: BlockDraft[] = [];
  const mapped = new Map<string, MappedFunction>();
  const parsedByRel = new Map<string, ParsedSource>();

  /** The row of a file whose lines are not read, in the order the first applicable cause is reported. */
  const unreadFile = (row: RawRow): FileRowCode | null => {
    if (row.oldMode === SUBMODULE_MODE || row.newMode === SUBMODULE_MODE) return "submodule";
    if (!row.path.startsWith(prefix)) return "outside_scan_root";
    if (row.status === "D") return "file_deleted";
    if (row.status === "M" && row.oldId === row.newId) return "mode_only";
    const rel = scanned(row.path);
    if (rel === null) return "file_not_scanned";
    const role = roleOf(rel);
    const language = languageOf(rel);
    if (role === "other" || (role === "code" && language !== "typescript" && language !== "javascript")) return "other_language";
    // Identical content under a new name, or a file that became a link (or stopped being one): no lines to read.
    return row.oldId === row.newId || row.status === "T" ? "no_text_diff" : null;
  };
  const productCode = (path: string): boolean => {
    if (!path.startsWith(prefix)) return false;
    const rel = path.slice(prefix.length);
    const language = languageOf(rel);
    return roleOf(rel) === "code" && (language === "typescript" || language === "javascript");
  };

  for (const row of rows) {
    const fileRow = (unknown: FileRowCode | null, blocks = 0): void => {
      files.push({
        path: row.path,
        ...(row.oldPath !== undefined ? { old_path: row.oldPath } : {}),
        change: row.status,
        ...(unknown === null ? { status: "blocks" as const } : { status: "unknown" as const, unknown }),
        blocks
      });
    };
    // A code file renamed to a test, a document or a place outside the scan root has left the
    // product: the new path's rows say nothing about the functions that went with it.
    if (row.status === "R" && row.oldPath !== undefined && productCode(row.oldPath) && !productCode(row.path)) {
      files.push({ path: row.oldPath, change: row.status, status: "unknown", unknown: "file_deleted", blocks: 0 });
    }
    const unread = unreadFile(row);
    if (unread !== null) {
      fileRow(unread);
      continue;
    }
    const rel = row.path.slice(prefix.length);
    const role = roleOf(rel) as BlockDraft["role"];

    const pathspec = row.oldPath !== undefined ? [row.oldPath, row.path] : [row.path];
    const patch = git(["--literal-pathspecs", "diff", ...BLOCK_DIFF_ARGS, "--no-color", base, merged, "--", ...pathspec], top);
    if (patch === null) return refuse("git_failed", "git diff failed for a changed file.", [row.path]);
    const hunks = parseHunks(patch);
    // A binary change: git lists the file and shows no lines.
    if (hunks.length === 0) {
      fileRow("no_text_diff");
      continue;
    }
    fileRow(null, hunks.length);

    if (role !== "code") {
      for (const hunk of hunks) {
        drafts.push({ block: { file: row.path, ...hunk }, role, symbols: [], unknown: new Set(), spansBoundary: false, removed: [], nonCode: false, weakCallers: 0, differs: [] });
      }
      continue;
    }

    const ruleMessage = (rule: FileRuleRefusal, version: string): string =>
      rule === "not_utf8"
        ? `The ${version} version of a changed file is not valid UTF-8.`
        : `The ${version} version of a changed file has a lone carriage return, U+2028 or U+2029: git and the parser would count its lines differently.`;
    const mergedBytes = workingBytes.get(rel) as Buffer;
    const mergedRule = fileRuleRefusal(mergedBytes);
    if (mergedRule) return refuse(mergedRule, ruleMessage(mergedRule, "merged"), [row.path]);
    let baseParsed: ParsedSource | null = null;
    if (row.status !== "A") {
      const basePath = row.oldPath ?? row.path;
      const baseBytes = git(["cat-file", "blob", row.oldId], top);
      if (baseBytes === null) return refuse("git_failed", "git could not read the base version of a changed file.", [basePath]);
      const baseRule = fileRuleRefusal(baseBytes);
      if (baseRule) return refuse(baseRule, ruleMessage(baseRule, "base"), [basePath]);
      baseParsed = parseSource(baseBytes.toString("utf8"), basePath);
    }
    const mergedParsed = parseSource(mergedBytes.toString("utf8"), row.path);
    parsedByRel.set(rel, mergedParsed);
    const idOf = (name: string): string => `sym:${rel}#${name}`;
    const bound = mergedParsed.sites.filter((site) => symbolNodes.has(idOf(site.name)));

    const fileDrafts: BlockDraft[] = [];
    for (const hunk of hunks) {
      const mapping = mapBlock(hunk, mergedParsed, bound, baseParsed);
      const draft: BlockDraft = {
        block: { file: row.path, ...hunk },
        role,
        symbols: mapping.names.map(idOf),
        unknown: mapping.unknown,
        spansBoundary: mapping.spansBoundary,
        removed: mapping.removed,
        nonCode: mapping.nonCode,
        weakCallers: 0,
        differs: []
      };
      drafts.push(draft);
      fileDrafts.push(draft);
      for (const name of mapping.names) {
        const id = idOf(name);
        let fn = mapped.get(id);
        if (!fn) {
          const site = mergedParsed.byName.get(name) as SiteSpan;
          const before = baseParsed?.byName.get(name);
          fn = {
            id,
            name,
            rel,
            node: symbolNodes.get(id) as GraphNode,
            bindable: site.kind === "function",
            lines: site.lines,
            // Changed means the text changed: the same symbol at base, compared as written.
            change: !before ? "new_function" : before.text !== site.text ? "text_changed" : null,
            blocks: []
          };
          mapped.set(id, fn);
        }
        fn.blocks.push(draft);
      }
    }

    // What the blocks' own lines do not show. The comment-only blocks carry it; in a
    // file that has none, and no other unknown, every block does.
    if (baseParsed) {
      const removedHere = new Set(fileDrafts.flatMap((draft) => draft.removed));
      const unshown = unshownDifferences(hunks, baseParsed, mergedParsed, (name) => mapped.has(idOf(name)) || removedHere.has(name));
      if (unshown.names.length > 0 || unshown.outside) {
        const quiet = fileDrafts.filter((draft) => draft.nonCode);
        const carriers = quiet.length > 0 ? quiet : fileDrafts.some((draft) => draft.unknown.size > 0) ? [] : fileDrafts;
        for (const draft of carriers) {
          draft.unknown.add(draft.nonCode ? "comment_changes_code" : "unmapped_change");
          draft.differs = unshown.names;
        }
      }
    }
  }

  // ---- Rank once: no limit, no per-file cap, no proof history ----
  const ranked = rankRiskGaps(graph, { repoRoot: scanRoot, limit: Number.MAX_SAFE_INTEGER, provenIds: new Set(), includeAssociated: true });
  const rankOf = new Map(ranked.map((gap, index) => [gap.id, index + 1]));
  const riskConfig = loadRiskConfig(scanRoot).config;
  const suppressed = riskConfig.overrides.filter((o) => o.action === "suppress").map((o) => ({ symbol: o.symbol, re: globToRegExp(o.symbol) }));
  const excludedPaths = [...riskConfig.classification.test_support_paths, ...riskConfig.classification.rank_exclude_paths].map(globToRegExp);
  const isCounted = (node: GraphNode): boolean => node.denominator_eligible === true && !node.stale;
  /** Why a function is missing from the ranking: one reason, the most specific first. */
  const unranked = (node: GraphNode): { reason: Extract<ListedReason, "not_counted" | "rank_excluded" | "suppressed_by_config">; detail?: ListedFunction["detail"] } => {
    const id = node.external_id;
    const rel = fileOfSymbol(node);
    if (suppressed.some((o) => o.symbol === id || o.re.test(id))) return { reason: "suppressed_by_config" };
    if (isCounted(node)) return { reason: "rank_excluded" };
    if (
      node.properties.ranking_exclusion_code !== undefined ||
      node.properties.ranking_exclusion_reason_code !== undefined ||
      builtInRankExclusion(rel) !== undefined ||
      excludedPaths.some((re) => re.test(rel))
    ) {
      return { reason: "rank_excluded" };
    }
    if (TYPE_DECLARATION_RE.test(rel)) return { reason: "not_counted", detail: "type_declaration" };
    if (isNonProductPath(rel)) return { reason: "not_counted", detail: "test_code" };
    if (node.denominator_reason === GENERATED_CODE_REASON) return { reason: "not_counted", detail: "generated_code" };
    return { reason: "not_counted" };
  };

  // ---- Following a helper: hard CALLS links backwards, two steps at most ----
  const callersOf = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.relationship_type !== "CALLS" || edge.evidence_strength !== "hard") continue;
    const set = callersOf.get(edge.to_external_id) ?? new Set<string>();
    set.add(edge.from_external_id);
    callersOf.set(edge.to_external_id, set);
  }
  const weakCallersOf = new Map<string, number>();
  for (const edge of graph.candidate_edges) {
    if (edge.relationship_type === "MAY_CALL") weakCallersOf.set(edge.to_external_id, (weakCallersOf.get(edge.to_external_id) ?? 0) + 1);
  }
  /** Counted callers of a helper, each with the path that reached it. A counted caller ends its path; one that is not counted is passed through once. */
  const walkCallers = (helper: string): Array<{ id: string; path: string[] }> => {
    const visited = new Set([helper]);
    const found: Array<{ id: string; path: string[] }> = [];
    let frontier: string[][] = [[helper]];
    for (let step = 1; step <= HELPER_MAX_STEPS && frontier.length > 0; step++) {
      const next: string[][] = [];
      for (const path of frontier) {
        for (const caller of [...(callersOf.get(path[path.length - 1]) ?? [])].sort(byCodeUnit)) {
          if (visited.has(caller)) continue;
          visited.add(caller);
          const node = symbolNodes.get(caller);
          if (!node) continue;
          if (isCounted(node)) found.push({ id: caller, path: [...path, caller] });
          else next.push([...path, caller]);
        }
      }
      frontier = next;
    }
    return found;
  };

  const listed: ListedFunction[] = [];
  const candidates: Candidate[] = [];
  const affected = new Map<string, Map<string, string[]>>();
  const boundaryOf = (blocks: Iterable<BlockDraft>): TargetUncertainty[] => ([...blocks].some((draft) => draft.spansBoundary) ? ["hunk_spans_boundary"] : []);
  const directlyChanged = (id: string): boolean => (mapped.get(id)?.change ?? null) !== null;

  /** The bytes of a file a record depends on, checked like every changed file: commit, checkout and graph must agree. */
  const recordFile = (rel: string): Buffer | ChangedTargetsRefused => {
    if (!workingBytes.has(rel)) {
      const commitId = committed.get(gitPathOf(rel));
      const why = commitId === undefined ? "the merged commit does not have it" : disagreement(rel, commitId);
      if (why !== null) {
        return refuse("file_hash_mismatch", `A file needed for a record is not the same in the commit, the checkout and the graph (${why}). Run \`opro analyze\` on a clean checkout of the merged commit.`, [gitPathOf(rel)]);
      }
    }
    return workingBytes.get(rel) as Buffer;
  };
  /** The file as this command reads it, or null when it cannot be read as text with git's line numbers. */
  const readable = new Map<string, ParsedSource | null>();
  const parsedOf = (rel: string, bytes: Buffer): ParsedSource | null => {
    let parsed = readable.get(rel);
    if (parsed === undefined) {
      parsed = fileRuleRefusal(bytes) !== null ? null : (parsedByRel.get(rel) ?? parseSource(bytes.toString("utf8"), rel));
      readable.set(rel, parsed);
      if (parsed) parsedByRel.set(rel, parsed);
    }
    return parsed;
  };
  /**
   * Whether a record can bind a function reached through a helper: its own file
   * must show it as a function. One that is not (a const bound to a call result)
   * is listed and never selected, wherever the cut falls; the run goes on.
   */
  const bindable = (node: GraphNode): boolean | ChangedTargetsRefused => {
    const rel = fileOfSymbol(node);
    const bytes = recordFile(rel);
    if (!Buffer.isBuffer(bytes)) return bytes;
    return parsedOf(rel, bytes)?.byName.get(nameInId(node.external_id))?.kind === "function";
  };

  for (const fn of [...mapped.values()].sort((a, b) => byCodeUnit(a.id, b.id))) {
    if (fn.change === null) continue;
    const rank = rankOf.get(fn.id);
    if (rank !== undefined && !fn.bindable) {
      for (const draft of fn.blocks) draft.unknown.add("unsupported_shape");
      listed.push({
        symbol_id: fn.id,
        file: gitPathOf(fn.rel),
        lines: fn.lines,
        reason: "unsupported_shape",
        rank,
        text_changed: true,
        change: fn.change,
        uncertainty: orderedUncertainty(boundaryOf(fn.blocks)),
        blocks: blocksOf(fn.blocks)
      });
      continue;
    }
    if (rank !== undefined) {
      candidates.push({ id: fn.id, node: fn.node, reason: fn.change, rank, blocks: fn.blocks, lines: fn.lines });
      continue;
    }
    const why = unranked(fn.node);
    const follow = why.reason === "not_counted" && why.detail === undefined;
    const callers = follow ? walkCallers(fn.id) : [];
    // A record names the helper's function. A class has none: what it reaches is reported, never selected.
    if (callers.length > 0 && !fn.bindable) for (const draft of fn.blocks) draft.unknown.add("unsupported_shape");
    for (const caller of fn.bindable ? callers : []) {
      // A function that is also directly changed is listed once, as directly changed.
      if (directlyChanged(caller.id)) continue;
      const through = affected.get(caller.id) ?? new Map<string, string[]>();
      through.set(fn.id, caller.path);
      affected.set(caller.id, through);
    }
    if (follow && callers.length === 0) {
      for (const draft of fn.blocks) {
        draft.unknown.add("no_caller_link");
        draft.weakCallers += weakCallersOf.get(fn.id) ?? 0;
      }
    }
    listed.push({
      symbol_id: fn.id,
      file: gitPathOf(fn.rel),
      lines: fn.lines,
      reason: why.reason,
      ...(why.detail ? { detail: why.detail } : {}),
      rank: null,
      text_changed: true,
      change: fn.change,
      ...(follow ? { followed: true, callers: callers.map((caller) => caller.id).sort(byCodeUnit) } : {}),
      uncertainty: orderedUncertainty([...boundaryOf(fn.blocks), ...(why.reason === "not_counted" ? (["not_counted"] as const) : [])]),
      blocks: blocksOf(fn.blocks)
    });
  }

  const helperBlocks = (through: Map<string, string[]>): BlockDraft[] => [...through.keys()].flatMap((helper) => mapped.get(helper)?.blocks ?? []);
  for (const [id, through] of [...affected.entries()].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    const node = symbolNodes.get(id) as GraphNode;
    const rank = rankOf.get(id);
    const blocks = helperBlocks(through);
    const binds = rank === undefined ? true : bindable(node);
    if (typeof binds !== "boolean") return binds;
    if (rank !== undefined && binds) {
      candidates.push({ id, node, reason: "affected_through", rank, blocks, lines: mapped.get(id)?.lines, through });
      continue;
    }
    // The change reaches a caller no record can bind: the helper's blocks say so.
    if (rank !== undefined) for (const draft of blocks) draft.unknown.add("unsupported_shape");
    const nearest = nearestHelper(through);
    listed.push({
      symbol_id: id,
      file: gitPathOf(fileOfSymbol(node)),
      ...(mapped.get(id) ? { lines: (mapped.get(id) as MappedFunction).lines } : {}),
      reason: rank !== undefined ? "unsupported_shape" : unranked(node).reason,
      rank: rank ?? null,
      text_changed: false,
      change: "affected_through",
      affected_through: [...through.keys()].sort(byCodeUnit),
      path: nearest.path,
      steps: nearest.path.length - 1,
      uncertainty: orderedUncertainty([...boundaryOf(blocks), "via_helper"]),
      blocks: blocksOf(blocks)
    });
  }

  // Identical text at base, and nothing reaches it: listed, never a target.
  for (const fn of mapped.values()) {
    if (fn.change !== null || affected.has(fn.id)) continue;
    listed.push({
      symbol_id: fn.id,
      file: gitPathOf(fn.rel),
      lines: fn.lines,
      reason: "overlap_text_unchanged",
      rank: rankOf.get(fn.id) ?? null,
      text_changed: false,
      uncertainty: orderedUncertainty(boundaryOf(fn.blocks)),
      blocks: blocksOf(fn.blocks)
    });
  }

  // ---- Selection: directly changed by rank, then reached through a helper; the cut is last ----
  const stepsOf = (candidate: Candidate): number => (candidate.through ? nearestHelper(candidate.through).path.length - 1 : 0);
  candidates.sort(
    (a, b) =>
      Number(a.reason === "affected_through") - Number(b.reason === "affected_through") ||
      a.rank - b.rank ||
      stepsOf(a) - stepsOf(b) ||
      byCodeUnit(a.id, b.id)
  );
  const selected = mapMode.only === undefined ? candidates.slice(0, limit) : candidates.filter((candidate) => candidate.id === mapMode.only);
  for (const candidate of mapMode.only === undefined ? candidates.slice(limit) : []) {
    const nearest = candidate.through ? nearestHelper(candidate.through) : null;
    listed.push({
      symbol_id: candidate.id,
      file: gitPathOf(fileOfSymbol(candidate.node)),
      ...(candidate.lines ? { lines: candidate.lines } : {}),
      reason: "beyond_cut",
      rank: candidate.rank,
      text_changed: candidate.reason !== "affected_through",
      change: candidate.reason,
      ...(candidate.through && nearest
        ? { affected_through: [...candidate.through.keys()].sort(byCodeUnit), path: nearest.path, steps: nearest.path.length - 1 }
        : {}),
      uncertainty: orderedUncertainty([...boundaryOf(candidate.blocks), ...(candidate.through ? (["via_helper"] as const) : [])]),
      blocks: blocksOf(candidate.blocks)
    });
  }

  // ---- Records: every span and hash re-derived from the file, never copied from the graph ----
  const packageRoots = new Map<string, boolean>();
  const hasManifest = (dir: string): boolean => {
    let known = packageRoots.get(dir);
    if (known === undefined) {
      known = git(["cat-file", "-e", `${merged}:${dir ? `${dir}/` : ""}${PACKAGE_MANIFEST}`], top) !== null;
      packageRoots.set(dir, known);
    }
    return known;
  };
  const packageRootOf = (path: string): string => {
    let dir = path;
    do {
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      if (hasManifest(dir)) return dir;
    } while (dir !== "");
    return "";
  };
  /** One function as its file shows it now. */
  const describe = (node: GraphNode): { target: TargetDescription; ownerPassedToCall: boolean } | ChangedTargetsRefused => {
    const rel = fileOfSymbol(node);
    const bytes = recordFile(rel);
    if (!Buffer.isBuffer(bytes)) return bytes;
    const described = describeTarget(bytes, nameInId(node.external_id));
    if (!described.ok) {
      if (described.refused === "not_utf8" || described.refused === "line_rule_mismatch") {
        return refuse(described.refused, "A file needed for a record cannot be read as text with git's line numbers.", [gitPathOf(rel)]);
      }
      return refuse("record_failed", `${node.external_id} could not be bound to a function in its file (${described.refused}).`, [gitPathOf(rel)]);
    }
    const owner = described.target.owner;
    return { target: described.target, ownerPassedToCall: owner !== undefined && parsedOf(rel, bytes)?.callArguments.has(owner) === true };
  };

  const targets: TargetRecord[] = [];
  for (const candidate of selected) {
    const own = describe(candidate.node);
    if ("refused" in own) return own;
    const file = gitPathOf(fileOfSymbol(candidate.node));
    const nearest = candidate.through ? nearestHelper(candidate.through) : null;
    let viaHelper: ViaHelper | undefined;
    if (nearest) {
      const helper = describe(symbolNodes.get(nearest.helper) as GraphNode);
      if ("refused" in helper) return helper;
      viaHelper = { symbol_id: nearest.helper, function: helper.target.function, function_sha256: helper.target.function_sha256, path: nearest.path };
    }
    targets.push({
      version: TARGET_RECORD_VERSION,
      identity: {
        merged_commit: merged,
        package_root: packageRootOf(file),
        file,
        symbol_id: candidate.id,
        ...own.target,
        ...(viaHelper ? { via_helper: viaHelper } : {})
      },
      selection: {
        base_commit: base,
        mode,
        blocks: blocksOf(candidate.blocks),
        reason: candidate.reason,
        rank: candidate.rank,
        uncertainty: orderedUncertainty([
          ...(own.ownerPassedToCall ? (["owner_passed_to_call"] as const) : []),
          ...boundaryOf(candidate.blocks),
          ...(candidate.through ? (["via_helper"] as const) : [])
        ]),
        text_changed: candidate.reason !== "affected_through",
        change_kind: "text_not_classified"
      }
    });
  }

  // ---- The block table ----
  const blocks = drafts
    .map((draft): ChangedBlockRow => {
      const causes = UNKNOWN_BLOCK_CODES.filter((code) => draft.unknown.has(code));
      const statusOf: BlockStatus =
        draft.role === "test"
          ? "test_file"
          : draft.role === "config"
            ? "config_file"
            : draft.role === "doc"
              ? "doc_file"
              : causes.length > 0
                ? "unknown"
                : draft.nonCode
                  ? "non_code"
                  : "mapped";
      return {
        ...draft.block,
        status: statusOf,
        ...(causes.length > 0 ? { unknown: causes[0] } : {}),
        ...(causes.length > 1 ? { unknown_also: causes.slice(1) } : {}),
        ...(draft.differs.length > 0 ? { differs: draft.differs } : {}),
        ...(draft.symbols.length > 0 ? { symbols: draft.symbols } : {}),
        ...(draft.spansBoundary ? { spans_boundary: true } : {}),
        ...(draft.removed.length > 0 ? { removed: draft.removed } : {}),
        ...(draft.unknown.has("no_caller_link") ? { weak_callers: draft.weakCallers } : {})
      };
    })
    .sort((a, b) => byCodeUnit(a.file, b.file) || a.new_start - b.new_start || a.old_start - b.old_start);

  return {
    status: "ok",
    base,
    merged,
    mode,
    complete: files.every((file) => file.status !== "unknown") && blocks.every((block) => block.status !== "unknown"),
    limit,
    files: files.sort((a, b) => byCodeUnit(a.path, b.path)),
    blocks,
    targets,
    listed: listed.sort((a, b) => byCodeUnit(a.symbol_id, b.symbol_id))
  };
}

export type TargetRecordCheck =
  | { ok: true }
  | { ok: false; refused: ChangedTargetsRefusal | "record_version" | "record_not_found" | "record_mismatch"; message: string };

/**
 * A record handed over is a claim. Rebuild all of it — spans and hashes from the
 * file, the blocks from git, the rank and the link path from the graph — and
 * refuse on any difference. The rebuild itself refuses unless the record's
 * merged commit, `HEAD` and the graph's commit are the same.
 *
 * The record says how its base relates to its merged commit, and the rebuild runs
 * the same way: a `first_parent` record whose base is not the merged commit's
 * first parent is refused, and only a record that says `range` may name another
 * ancestor. `cleanTree: false` is for a caller whose checkout rightly holds other
 * work (a new test, or an edit to a test the same merge touched): test, config
 * and doc files are then not compared with the commit. Every code file the graph
 * was analysed from still is, the target's and the helper's among them.
 */
export function verifyTargetRecord(
  root: string,
  record: TargetRecord,
  opts: { cleanTree?: boolean } = {},
  deps: ChangedTargetsDeps = {}
): TargetRecordCheck {
  const well =
    record?.version === TARGET_RECORD_VERSION &&
    typeof record.identity?.merged_commit === "string" &&
    typeof record.identity.symbol_id === "string" &&
    typeof record.selection?.base_commit === "string" &&
    (record.selection.mode === "first_parent" || record.selection.mode === "range");
  if (!well) return { ok: false, refused: "record_version", message: `Not a ${TARGET_RECORD_VERSION} record.` };
  const fresh = mapChange(
    root,
    { base: record.selection.base_commit, merged: record.identity.merged_commit, range: record.selection.mode === "range" },
    deps,
    { cleanTree: opts.cleanTree !== false, only: record.identity.symbol_id }
  );
  if (fresh.status === "refused") return { ok: false, refused: fresh.refused, message: fresh.message };
  const again = fresh.targets[0];
  if (!again) {
    return { ok: false, refused: "record_not_found", message: `${record.identity.symbol_id} is not a target of this change as the file, git and the graph give it now.` };
  }
  for (const part of ["identity", "selection"] as const) {
    if (canonicalJson(again[part]) !== canonicalJson(record[part])) {
      return { ok: false, refused: "record_mismatch", message: `The record's ${part} differs from what the file, git and the graph give now.` };
    }
  }
  return { ok: true };
}

function blockPlace(block: ChangedBlock): string {
  if (block.new_count === 0) return `${block.file}:${block.new_start} (lines removed after)`;
  return block.new_count === 1 ? `${block.file}:${block.new_start}` : `${block.file}:${block.new_start}-${block.new_start + block.new_count - 1}`;
}

const titleOf = nameInId;

/** The human-readable tables `opro changed-targets` prints without `--json`. */
export function renderChangedTargets(result: ChangedTargetsResult): string[] {
  if (result.status === "refused") {
    return [`Refused (${result.refused}): ${result.message}`, ...(result.paths ?? []).map((path) => `  - ${path}`)];
  }
  const unknownFiles = result.files.filter((file) => file.status === "unknown").length;
  const unknownBlocks = result.blocks.filter((block) => block.status === "unknown").length;
  const lines = [
    `Changed targets: ${result.base.slice(0, 12)} → ${result.merged.slice(0, 12)} (${result.mode === "range" ? "range" : "first parent"})`,
    result.complete
      ? "Complete: every changed line is accounted for."
      : `Incomplete: ${unknownBlocks} block(s) and ${unknownFiles} file(s) are unknown.`,
    "",
    `Files (${result.files.length}):`
  ];
  for (const file of result.files) {
    const from = file.old_path !== undefined ? ` (from ${file.old_path})` : "";
    lines.push(`  ${file.change}  ${file.path}${from}  ${file.status === "unknown" ? `unknown: ${file.unknown}` : `${file.blocks} block(s)`}`);
  }
  lines.push("", `Blocks (${result.blocks.length}):`);
  for (const block of result.blocks) {
    const causes = [block.unknown, ...(block.unknown_also ?? [])].filter(Boolean).join(", ");
    const statusText = block.status === "unknown" ? `unknown: ${causes}` : block.status;
    const extras = [
      block.symbols?.length ? `→ ${block.symbols.map(titleOf).join(", ")}` : "",
      block.spans_boundary ? "(crosses a function boundary)" : "",
      block.removed?.length ? `(removed: ${block.removed.join(", ")})` : "",
      block.differs?.length ? `(differs: ${block.differs.join(", ")})` : "",
      block.weak_callers !== undefined ? `(weak callers: ${block.weak_callers})` : ""
    ].filter(Boolean);
    lines.push(`  ${blockPlace(block)}  ${statusText}${extras.length ? `  ${extras.join(" ")}` : ""}`);
  }
  lines.push("", `Targets (${result.targets.length}, cut at ${result.limit}):`);
  result.targets.forEach((record, index) => {
    const { identity, selection } = record;
    const via = identity.via_helper ? ` through ${titleOf(identity.via_helper.symbol_id)} (${identity.via_helper.path.length - 1} step(s))` : "";
    const doubt = selection.uncertainty.length ? `  uncertainty: ${selection.uncertainty.join(", ")}` : "";
    lines.push(
      `  ${index + 1}. ${identity.name}  ${identity.file}:${identity.function.lines.start}-${identity.function.lines.end}  rank ${selection.rank}  ${selection.reason}${via}${doubt}`
    );
  });
  if (result.listed.length > 0) {
    lines.push("", `Listed, not selected (${result.listed.length}):`);
    for (const fn of result.listed) {
      const where = fn.lines ? `${fn.file}:${fn.lines.start}-${fn.lines.end}` : fn.file;
      const notes = [
        fn.detail ?? "",
        fn.rank !== null ? `rank ${fn.rank}` : "",
        fn.followed ? (fn.callers?.length ? `followed to ${fn.callers.map(titleOf).join(", ")}` : "followed, no caller link") : "",
        fn.affected_through?.length ? `through ${fn.affected_through.map(titleOf).join(", ")}` : ""
      ].filter(Boolean);
      lines.push(`  ${titleOf(fn.symbol_id)}  ${where}  ${fn.reason}${notes.length ? `  (${notes.join("; ")})` : ""}`);
    }
  }
  return lines;
}
