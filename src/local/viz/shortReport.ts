import path from "node:path";

/**
 * Helpers both reports share: where the summary is written, links to the code at
 * the analysed commit (only for known hosts, never with credentials), the noun the
 * counts use, how a proof names its test, and a plain name for what a delete removes.
 * The reports themselves render in summaryReport.ts and detailedReport.ts.
 */

export const SHORT_REPORT_PREFIX = "short_";

/** `dir/behavior-coverage.html` → `dir/short_behavior-coverage.html`. */
export function shortReportPath(detailedPath: string): string {
  return path.join(path.dirname(detailedPath), `${SHORT_REPORT_PREFIX}${path.basename(detailedPath)}`);
}

export interface RepoWeb {
  base: string;
  host: "github" | "gitlab";
}

/**
 * Web base for a git remote on a known host, with any credentials removed.
 * Unknown hosts return null, so no link is ever guessed.
 */
export function repoWebFromRemote(remote: string | null | undefined): RepoWeb | null {
  if (!remote) return null;
  let r = remote.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(r);
  if (scp) r = `https://${scp[1]}/${scp[2]}`;
  let url: URL;
  try {
    url = new URL(r.replace(/^ssh:\/\//, "https://").replace(/^git:\/\//, "https://"));
  } catch {
    return null;
  }
  const hostName = url.hostname.toLowerCase();
  const host = hostName === "github.com" ? "github" : hostName === "gitlab.com" ? "gitlab" : null;
  if (!host) return null;
  const repoPath = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repoPath)) return null;
  return { base: `https://${hostName}/${repoPath}`, host };
}

/** Plural noun that truthfully describes what the denominator counts. */
export function denominatorNoun(kinds?: { functionLike: number; classes: number; total: number }): { plural: string; singular: string; title: string } {
  if (!kinds || kinds.total === 0 || kinds.functionLike / kinds.total >= 0.9) return { plural: "functions", singular: "function", title: "Functions mapped" };
  if ((kinds.functionLike + kinds.classes) / kinds.total >= 0.9) return { plural: "functions and classes", singular: "function or class", title: "Functions and classes mapped" };
  return { plural: "code symbols", singular: "code symbol", title: "Code symbols mapped" };
}

// Labels the oracle records in place of a concrete value (mode names, not code).
const SENTINEL_MODE_LABELS = new Set(["return-json", "promise-json", "go-zero-return", "java-typed-sentinel"]);

/**
 * The replacement a proof applied, as code, from the certificate's `sentinel`
 * (the value; `sentinel_source` only says how it was chosen). Mode labels and
 * empty values return undefined so the page states it in words instead.
 */
export function proofSentinelText(sentinel: string | undefined): string | undefined {
  const value = sentinel?.trim();
  if (!value || SENTINEL_MODE_LABELS.has(value)) return undefined;
  return /^return\b/.test(value) ? value : `return ${value}`;
}

/**
 * Repository-relative path for a test path recorded relative to a sub-project
 * (`tests/x.py` run from `pkg/` → `pkg/tests/x.py`). Resolved only when exactly
 * one scanned file matches; otherwise the recorded path is kept as is.
 */
export function repoRelativeTestPath(recorded: string, repoFiles: readonly string[]): { path: string; resolved: boolean } {
  const clean = recorded.replace(/^\.\//, "");
  if (repoFiles.includes(clean)) return { path: clean, resolved: true };
  const matches = repoFiles.filter((f) => f.endsWith(`/${clean}`));
  return matches.length === 1 ? { path: matches[0]!, resolved: true } : { path: clean, resolved: false };
}

/**
 * Where a proof's test lives, from the certificate. Runners record the test as
 * `file::selector` relative to the project they ran in; the file part is resolved
 * to a repository path (unique match only) and the selector is kept. When the
 * recorded path has no selector, the one in the runner command for that file is used.
 */
export function proofTestLocation(
  recorded: string | undefined,
  command: string | undefined,
  repoFiles: readonly string[]
): { testPath?: string; testPathResolved?: boolean; testId?: string } {
  const value = (recorded ?? "").trim().replace(/^\.\//, "");
  const cut = value.indexOf("::");
  const file = cut >= 0 ? value.slice(0, cut) : value;
  if (!file) return {};
  let selector = cut >= 0 ? value.slice(cut) : "";
  if (!selector && command) {
    for (const m of command.matchAll(/(\S+?\.\w+)(::\S+)/g)) {
      if (m[1]!.replace(/^['"]?\.?\/?/, "").endsWith(file)) {
        selector = m[2]!.replace(/['"]+$/, "");
        break;
      }
    }
  }
  const where = repoRelativeTestPath(file, repoFiles);
  return { testPath: where.path, testPathResolved: where.resolved, ...(selector ? { testId: `${where.path}${selector}` } : {}) };
}

export function permalink(web: RepoWeb, commit: string, file: string, line?: number): string {
  const enc = file.split("/").map(encodeURIComponent).join("/");
  const anchor = line ? `#L${line}` : "";
  return web.host === "gitlab" ? `${web.base}/-/blob/${commit}/${enc}${anchor}` : `${web.base}/blob/${commit}/${enc}${anchor}`;
}

// Generic container words that never name the data itself.
const STORE_NOISE = new Set([
  "self", "this", "cls", "s", "r", "c", "db", "database", "table", "tables", "client", "clients", "conn", "connection",
  "session", "tx", "txn", "repo", "repository", "store", "collection", "model", "models", "objects", "query", "manager",
  "orm", "dao", "ctx", "app", "api", "svc", "service", "opts", "options", "cfg", "conf", "deps", "impl", "inner", "base",
  "util", "utils", "helper", "helpers", "mgr"
]);
const STORE_SUFFIX = /(Repository|Repo|Table|Client|Dao|DAO|Collection)$|_(repository|repo|table|client|dao|collection)$/;

function words(identifier: string): string {
  const spaced = identifier
    .replace(/^_+/, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .trim();
  const parts = spaced.split(/\s+/).filter(Boolean).map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()));
  if (parts.length === 0) return "";
  const first = parts[0]!;
  parts[0] = /^[A-Z0-9]{2,}$/.test(first) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return parts.join(" ");
}

function meaningful(identifier: string): string | null {
  const stripped = identifier.replace(STORE_SUFFIX, "");
  if (!stripped || STORE_NOISE.has(stripped.toLowerCase()) || STORE_NOISE.has(identifier.toLowerCase())) return null;
  // Abbreviations (`pm`, `bs`) name nothing a reader recognizes; acronyms (`MCP`) do.
  if (stripped.replace(/^_+/, "").length < 4 && !/^[A-Z0-9]{2,}$/.test(stripped)) return null;
  return words(stripped) || null;
}

/**
 * Plain-language name for what a destructive call removes, read from the names in
 * the call itself (`OrdersRepository(conn).table.delete` → "Orders",
 * `self._session_cache.delete` → "Session cache"), else from the class that owns
 * the call (`AccountsRepository.remove_by_id` → "Accounts"). Names only; never a guess
 * beyond them. Empty string when nothing meaningful is named.
 */
export function storeLabel(sink: string, owner?: string): string {
  const qualifier = sink.replace(/\([^()]*\)/g, "()").split(".").slice(0, -1).join(".");
  for (const id of qualifier.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    const label = meaningful(id);
    if (label) return label;
  }
  const ownerClass = owner?.split("#").pop()?.split(".").slice(-2, -1)[0];
  if (ownerClass && /^[A-Z]/.test(ownerClass)) {
    const label = meaningful(ownerClass);
    if (label) return label;
  }
  return "";
}
